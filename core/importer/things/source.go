package things

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Source is where a Things database comes from (PLAN §6.12).
type Source struct {
	// Path is a file or folder on this device: the "Things Database.thingsdatabase" package, a
	// folder holding one (ThingsData-XXXXX, or wherever a copy was put), its main.sqlite, or a
	// .zip of any of these.
	Path string
	// Files are files the user uploaded (web): a .zip of the package, or main.sqlite plus its
	// main.sqlite-wal.
	Files []File
}

// File is one uploaded file.
type File struct {
	Name string
	Data []byte
}

const (
	dbName  = "main.sqlite"
	walName = "main.sqlite-wal"
)

// ErrNoDatabase means nothing picked held a Things database.
var ErrNoDatabase = errors.New("no Things database found — choose “Things Database.thingsdatabase”, a .zip of it, or the main.sqlite inside it")

// ErrAppleArchive means the pick was the iPhone/iPad export, which needs unpacking first.
var ErrAppleArchive = errors.New("that’s an iPhone or iPad export (.aar), which can’t be read directly — open it in the Files app to unpack it, compress the “Things Database.thingsdatabase” folder it makes, and choose the .zip")

// load reads a source's main database and its write-ahead log (nil when there is none).
func load(src Source) (main, wal []byte, err error) {
	switch {
	case src.Path != "":
		return loadPath(src.Path)
	case len(src.Files) > 0:
		return loadFiles(src.Files)
	default:
		return nil, nil, ErrNoDatabase
	}
}

func loadPath(p string) (main, wal []byte, err error) {
	info, err := os.Stat(p)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		db, err := findInDir(p)
		if err != nil {
			return nil, nil, err
		}
		return readLive(db)
	}
	switch strings.ToLower(filepath.Ext(p)) {
	case ".zip":
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, nil, err
		}
		return loadZip(data)
	case ".aar":
		return nil, nil, ErrAppleArchive
	}
	return readLive(p)
}

// findInDir finds the database in a picked folder: the package itself, or a folder above it —
// searched a few levels down, skipping Things' own Backups, and taking the most recently
// written database when there is more than one.
func findInDir(dir string) (string, error) {
	if p := filepath.Join(dir, dbName); isFile(p) {
		return p, nil
	}
	var best string
	var bestMod time.Time
	root := filepath.Clean(dir)
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable corners don't stop the search
		}
		if !d.IsDir() {
			return nil
		}
		if p != root && (strings.EqualFold(d.Name(), "Backups") || strings.Count(strings.TrimPrefix(p, root), string(filepath.Separator)) > 3) {
			return filepath.SkipDir
		}
		if strings.HasSuffix(strings.ToLower(d.Name()), ".thingsdatabase") {
			if info, err := os.Stat(filepath.Join(p, dbName)); err == nil && (best == "" || info.ModTime().After(bestMod)) {
				best, bestMod = filepath.Join(p, dbName), info.ModTime()
			}
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if best == "" {
		return "", ErrNoDatabase
	}
	return best, nil
}

// readLive reads a database file and its log. Things may be running and writing as we read,
// so the log is read again after the main file: if it changed, a checkpoint may have moved
// pages between the two reads, so the pair is read again (a few times at most — the import
// is a snapshot either way).
func readLive(dbPath string) (main, wal []byte, err error) {
	for attempt := 0; attempt < 3; attempt++ {
		if wal, err = readOptional(dbPath + "-wal"); err != nil {
			return nil, nil, err
		}
		if main, err = os.ReadFile(dbPath); err != nil {
			return nil, nil, err
		}
		again, err := readOptional(dbPath + "-wal")
		if err != nil {
			return nil, nil, err
		}
		if bytes.Equal(again, wal) {
			break
		}
	}
	if !isSQLite(main) {
		return nil, nil, ErrNoDatabase
	}
	return main, wal, nil
}

// loadZip finds the database in a zip: a zipped package (what Safari uploads for a package,
// and what Finder › Compress makes) or a zipped folder above it. Things' Backups and macOS
// resource-fork entries (__MACOSX) are ignored; the shallowest database wins.
func loadZip(data []byte) (main, wal []byte, err error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, fmt.Errorf("read zip: %w", err)
	}
	byName := map[string]*zip.File{}
	var candidates []*zip.File
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, "/")
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "__macosx/") || strings.HasPrefix(lower, "backups/") || strings.Contains(lower, "/backups/") {
			continue
		}
		byName[lower] = f
		if strings.EqualFold(path.Base(name), dbName) {
			candidates = append(candidates, f)
		}
		if strings.EqualFold(path.Ext(name), ".aar") {
			return nil, nil, ErrAppleArchive
		}
	}
	if len(candidates) == 0 {
		return nil, nil, ErrNoDatabase
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return strings.Count(candidates[i].Name, "/") < strings.Count(candidates[j].Name, "/")
	})
	chosen := candidates[0]
	if main, err = readZipFile(chosen); err != nil {
		return nil, nil, err
	}
	if !isSQLite(main) {
		return nil, nil, ErrNoDatabase
	}
	walPath := strings.ToLower(path.Join(path.Dir(strings.TrimPrefix(chosen.Name, "/")), walName))
	if f, ok := byName[walPath]; ok {
		if wal, err = readZipFile(f); err != nil {
			return nil, nil, err
		}
	}
	return main, wal, nil
}

// loadFiles finds the database among uploaded files: a zip (read as above), or a SQLite file
// plus an optional "-wal" beside it.
func loadFiles(files []File) (main, wal []byte, err error) {
	for _, f := range files {
		switch strings.ToLower(path.Ext(f.Name)) {
		case ".zip":
			return loadZip(f.Data)
		case ".aar":
			return nil, nil, ErrAppleArchive
		}
	}
	var mainFile *File
	for i := range files {
		f := &files[i]
		name := strings.ToLower(f.Name)
		switch {
		case strings.HasSuffix(name, "-wal"):
			wal = f.Data
		case strings.HasSuffix(name, "-shm"):
		case isSQLite(f.Data) && (mainFile == nil || name == dbName):
			mainFile = f
		}
	}
	if mainFile == nil {
		return nil, nil, ErrNoDatabase
	}
	return mainFile.Data, wal, nil
}

func readZipFile(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("open %s in zip: %w", f.Name, err)
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func readOptional(p string) ([]byte, error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func isSQLite(b []byte) bool { return bytes.HasPrefix(b, []byte("SQLite format 3\x00")) }
