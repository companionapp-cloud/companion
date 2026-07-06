// Package secrets provides a file-backed SecretStore for the native shells (desktop and
// mobile), satisfying bridge.SecretStore (PLAN §6.8). LLM API keys live in a 0600 JSON file
// in the app's config/documents directory rather than SQLite.
//
// This is a pragmatic v1: a restrictive-permission local file. The OS keychain / SecureStore
// / DPAPI is the intended hardening upgrade — the bridge.SecretStore seam means swapping this
// out later touches only shell wiring, not the core.
package secrets

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// FileStore keeps ref→secret pairs in one JSON file, guarded by a mutex so the UI and the
// chat path can't corrupt it with concurrent writes.
type FileStore struct {
	path string
	mu   sync.Mutex
}

// NewFileStore returns a store backed by the file at path (created on first write).
func NewFileStore(path string) *FileStore { return &FileStore{path: path} }

// GetSecret returns the value for ref, or "" when absent.
func (s *FileStore) GetSecret(ref string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return "", err
	}
	return m[ref], nil
}

// SetSecret writes (or replaces) the value for ref.
func (s *FileStore) SetSecret(ref, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	m[ref] = value
	return s.save(m)
}

// DeleteSecret removes ref (a no-op when absent).
func (s *FileStore) DeleteSecret(ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	delete(m, ref)
	return s.save(m)
}

func (s *FileStore) load() (map[string]string, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// save writes the map via a temp file + rename so a crash can't leave a half-written file.
func (s *FileStore) save(m map[string]string) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
