//go:build !js && !ios && !android

package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion/core/store"
)

// Exports as the other devices see them: every export syncs, one device runs it, and the rest can
// pause it, resume it, remove it, or take it over (export.go).

// settle marks every export row pushed, as a sync would.
func settle(t *testing.T, c *Core) {
	t.Helper()
	gits, err := c.store.Exports.Git().Dirty()
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range gits {
		if err := c.store.Exports.Git().MarkPushed(g.ID, g.Version+1); err != nil {
			t.Fatal(err)
		}
	}
	folders, err := c.store.Exports.Folder().Dirty()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range folders {
		if err := c.store.Exports.Folder().MarkPushed(f.ID, f.Version+1); err != nil {
			t.Fatal(err)
		}
	}
}

// carry takes the export rows one device has to push and applies them on another, as a sync
// through the server would (minus the encryption, and the versions to argue over).
func carry(t *testing.T, from, to *Core) {
	t.Helper()
	gits, err := from.store.Exports.Git().Dirty()
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range gits {
		g.Version++
		raw, _ := json.Marshal(g)
		row, err := to.store.Exports.Git().Decode(raw)
		if err != nil {
			t.Fatal(err)
		}
		if err := to.store.Exports.Git().Apply(row); err != nil {
			t.Fatal(err)
		}
		_ = from.store.Exports.Git().MarkPushed(g.ID, g.Version)
	}
	folders, err := from.store.Exports.Folder().Dirty()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range folders {
		f.Version++
		raw, _ := json.Marshal(f)
		row, err := to.store.Exports.Folder().Decode(raw)
		if err != nil {
			t.Fatal(err)
		}
		if err := to.store.Exports.Folder().Apply(row); err != nil {
			t.Fatal(err)
		}
		_ = from.store.Exports.Folder().MarkPushed(f.ID, f.Version)
	}
}

// waitIdle waits for a destination's background run to finish.
func waitIdle(t *testing.T, c *Core, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c.exports.mu.Lock()
		running := c.exports.running[id]
		c.exports.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the export is still running")
}

func exportDevice(t *testing.T, name string, canExport bool) *Core {
	t.Helper()
	c, _ := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	c.SetDeviceInfo("macos", name, canExport)
	if canExport {
		c.SetExportDir(t.TempDir())
	}
	return c
}

func onlyExport(t *testing.T, c *Core) exportView {
	t.Helper()
	views := call[[]exportView](t, c, "export.destinations.list", "")
	if len(views) != 1 {
		t.Fatalf("want one export, got %+v", views)
	}
	return views[0]
}

// A folder export made before they synced belongs to the device it was made on, and from then on
// travels under that device's name, which follows a rename.
func TestFolderExportsAreClaimedByTheirDevice(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetExportDir(t.TempDir())
	legacy := &store.ExportDestination{Kind: store.ExportKindFolder, Name: "Backup", Config: json.RawMessage(`{"path":` + quote(t.TempDir()) + `}`), Schedule: store.ExportManual, Enabled: true}
	if err := c.store.Exports.Save(legacy); err != nil {
		t.Fatal(err)
	}
	c.SetDeviceInfo("macos", "Sam's MacBook", true)
	me := c.exportDeviceID()
	got := onlyExport(t, c)
	if got.DeviceID != me || got.DeviceName != "Sam's MacBook" || !got.ThisDevice {
		t.Fatalf("a folder export made here should be this device's: %+v", got)
	}
	dirty, _ := c.store.Exports.Folder().Dirty()
	if len(dirty) != 1 || dirty[0].DeviceID != me || !strings.Contains(string(dirty[0].Config), "path") {
		t.Fatalf("it should be queued to sync as a folder export: %+v", dirty)
	}

	settle(t, c)
	call[deviceView](t, c, "devices.rename", `{"name":"Studio"}`)
	if got := onlyExport(t, c); got.DeviceName != "Studio" {
		t.Errorf("a rename should reach the exports this device runs: %q", got.DeviceName)
	}
	if dirty, _ := c.store.Exports.Folder().Dirty(); len(dirty) != 1 {
		t.Error("…and sync, for the other devices to show")
	}
}

// The exporter tells the other devices how its runs go when that changes, and hourly otherwise;
// a report never dates the settings.
func TestExportRunsAreReported(t *testing.T) {
	c := exportDevice(t, "Sam's MacBook", true)
	root := t.TempDir()
	call[idOnly](t, c, "notes.create", `{"title":"One","contentMd":"First."}`)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"folder","path":`+quote(root)+`,"schedule":"manual"}`)
	settle(t, c)
	settingsAt := onlyExport(t, c).UpdatedAt

	reported := func(why string, want bool) {
		t.Helper()
		dirty, _ := c.store.Exports.Folder().Dirty()
		if got := len(dirty) == 1; got != want {
			t.Errorf("%s: reported = %v, want %v", why, got, want)
		}
		if want && len(dirty) == 1 && !dirty[0].UpdatedAt.Equal(settingsAt) {
			t.Errorf("%s: a report must not move updatedAt (%v → %v)", why, settingsAt, dirty[0].UpdatedAt)
		}
		settle(t, c)
	}

	c.runExport(dest.ID, false)
	reported("the first success", true)
	if got := onlyExport(t, c); got.LastSuccessAt == nil || got.LastError != "" {
		t.Fatalf("after a run = %+v", got)
	}
	c.runExport(dest.ID, false)
	reported("a run with nothing to do", false)

	call[idOnly](t, c, "notes.create", `{"title":"Two","contentMd":"Second."}`)
	c.runExport(dest.ID, false)
	reported("a run that wrote files", true)

	moved := root + "-moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	c.runExport(dest.ID, false)
	reported("a new error", true)
	if got := onlyExport(t, c); !strings.Contains(got.LastError, "isn't there anymore") {
		t.Fatalf("error = %q", got.LastError)
	}
	c.runExport(dest.ID, false)
	reported("the same error again", false)
	if err := os.Rename(moved, root); err != nil {
		t.Fatal(err)
	}
	c.runExport(dest.ID, false)
	reported("the error clearing", true)

	// Last reported two hours ago: a quiet run reports anyway.
	then := time.Now().Add(-2 * time.Hour)
	if err := c.store.Exports.RecordRun(dest.ID, dest.DeviceID, store.ExportRun{RanAt: then, Success: &then, Report: true}); err != nil {
		t.Fatal(err)
	}
	settle(t, c)
	c.runExport(dest.ID, false)
	reported("an hour without a report", true)
}

// A pulled row brings the other devices' settings changes but never an older report over a newer
// one; the exporter sends its own again when that happens. A new exporter's report replaces the
// old one's whatever its age.
func TestExportApplyMergesTheStatus(t *testing.T) {
	c := exportDevice(t, "Sam's MacBook", true)
	dest := call[exportView](t, c, "export.destinations.save", `{"kind":"folder","path":`+quote(t.TempDir())+`,"schedule":"manual"}`)
	t2 := time.Now().Add(-time.Minute).UTC()
	if err := c.store.Exports.RecordRun(dest.ID, dest.DeviceID, store.ExportRun{RanAt: t2, Success: &t2, Report: true}); err != nil {
		t.Fatal(err)
	}
	settle(t, c)

	// A phone pauses it, sending back the report it last saw — an older one.
	row, _ := c.store.Exports.Folder().GetAny(dest.ID)
	t1 := t2.Add(-time.Hour)
	row.Enabled, row.LastRunAt, row.LastSuccessAt, row.Version = false, &t1, &t1, row.Version+1
	row.UpdatedAt = time.Now().UTC()
	if err := c.store.Exports.Folder().Apply(row); err != nil {
		t.Fatal(err)
	}
	got := onlyExport(t, c)
	if got.Enabled || got.LastRunAt == nil || !got.LastRunAt.Equal(t2) {
		t.Fatalf("the pause should land and the newer report stay: %+v", got)
	}
	if dirty, _ := c.store.Exports.Folder().Dirty(); len(dirty) != 1 || dirty[0].Enabled || dirty[0].LastRunAt == nil || !dirty[0].LastRunAt.Equal(t2) {
		t.Fatalf("the exporter should send its report again, paused: %+v", dirty)
	}
	settle(t, c)

	// A newer report comes in.
	t3 := t2.Add(time.Minute)
	row, _ = c.store.Exports.Folder().GetAny(dest.ID)
	row.LastRunAt, row.LastError, row.Version = &t3, "disk full", row.Version+1
	if err := c.store.Exports.Folder().Apply(row); err != nil {
		t.Fatal(err)
	}
	if got := onlyExport(t, c); got.LastError != "disk full" || !got.LastRunAt.Equal(t3) {
		t.Errorf("a newer report should replace ours: %+v", got)
	}
	if dirty, _ := c.store.Exports.Folder().Dirty(); len(dirty) != 0 {
		t.Error("…and leave nothing to send")
	}

	// Another device takes it over, before it has run it at all.
	row, _ = c.store.Exports.Folder().GetAny(dest.ID)
	row.DeviceID, row.DeviceName, row.LastRunAt, row.LastSuccessAt, row.LastError, row.Version = "mini", "Mac mini", nil, nil, "", row.Version+1
	if err := c.store.Exports.Folder().Apply(row); err != nil {
		t.Fatal(err)
	}
	got = onlyExport(t, c)
	if got.ThisDevice || got.LastRunAt != nil || got.LastError != "" {
		t.Errorf("the new exporter hasn't reported yet, so there's nothing to show: %+v", got)
	}
	// Here, a late record from a run that started before the takeover changes nothing.
	late := time.Now()
	if err := c.store.Exports.RecordRun(dest.ID, dest.DeviceID, store.ExportRun{RanAt: late, Success: &late, Report: true}); err != nil {
		t.Fatal(err)
	}
	if got := onlyExport(t, c); got.LastRunAt != nil {
		t.Errorf("a run recorded after a takeover must not pass for the new exporter's: %+v", got)
	}
	if dirty, _ := c.store.Exports.Folder().Dirty(); len(dirty) != 0 {
		t.Error("…nor be sent")
	}
}

// A device that runs no exports — the web, a phone — lists the ones its other devices run and
// can pause, resume and remove them; the exporter stops when the change reaches it.
func TestExportPausedFromAnotherDevice(t *testing.T) {
	mac := exportDevice(t, "Sam's MacBook", true)
	phone := exportDevice(t, "Sam's iPhone", false)
	root := t.TempDir()
	dest := call[exportView](t, mac, "export.destinations.save", `{"kind":"folder","path":`+quote(root)+`,"schedule":"changes"}`)
	waitIdle(t, mac, dest.ID)
	carry(t, mac, phone)

	seen := onlyExport(t, phone)
	if seen.ThisDevice || seen.DeviceName != "Sam's MacBook" || seen.LastSuccessAt == nil || !strings.Contains(string(seen.Config), root) {
		t.Fatalf("the phone should see the MacBook's export and how it went: %+v", seen)
	}
	if seen.Pending || seen.OwnerLastSeenAt != nil {
		t.Errorf("with nothing known of the MacBook, nothing is pending: %+v", seen)
	}
	if _, err := phone.Invoke("export.destinations.takeOver", []byte(`{"id":"`+dest.ID+`","path":`+quote(t.TempDir())+`}`)); err == nil {
		t.Error("a device that can't run exports can't take one over")
	}

	// Presence dates the MacBook's last sync before its own latest change (a clock running ahead
	// of the server's does that): its own changes still aren't waiting on it.
	phone.setPresence(dest.DeviceID, presenceEntry{online: false, lastSeenAt: time.Now().Add(-time.Hour), name: "Sam's MacBook"})
	if got := onlyExport(t, phone); got.Pending || got.OwnerLastSeenAt == nil {
		t.Errorf("the exporter's own change can't be pending: %+v", got)
	}

	// The MacBook last synced an hour ago; the phone pauses the export.
	paused := call[exportView](t, phone, "export.destinations.setEnabled", `{"id":"`+dest.ID+`","enabled":false}`)
	if paused.Enabled || !paused.Pending || paused.OwnerOnline || paused.OwnerLastSeenAt == nil {
		t.Fatalf("paused from the phone, not yet picked up = %+v", paused)
	}

	// The MacBook syncs: it has the pause, and runs the export no more.
	carry(t, phone, mac)
	phone.setPresence(dest.DeviceID, presenceEntry{online: true, lastSeenAt: time.Now().Add(time.Second), name: "Sam's MacBook"})
	if got := onlyExport(t, phone); got.Pending || !got.OwnerOnline {
		t.Errorf("once the MacBook has synced the pause isn't pending: %+v", got)
	}
	call[idOnly](t, mac, "notes.create", `{"title":"After the pause","contentMd":"Not exported."}`)
	mac.exports.mu.Lock()
	mac.exports.changedAt = time.Now().Add(-time.Minute)
	mac.exports.mu.Unlock()
	mac.exportTick(time.Now(), true)
	waitIdle(t, mac, dest.ID)
	if _, err := os.Stat(filepath.Join(root, "Notes", "After the pause.md")); err == nil {
		t.Error("a paused export must not run")
	}
	if _, err := mac.Invoke("export.destinations.run", []byte(`{"id":"`+dest.ID+`"}`)); err == nil || !strings.Contains(err.Error(), "paused") {
		t.Errorf("run while paused: %v", err)
	}

	// Resumed from the phone, it runs again.
	call[exportView](t, phone, "export.destinations.setEnabled", `{"id":"`+dest.ID+`","enabled":true}`)
	carry(t, phone, mac)
	mac.exportTick(time.Now(), true)
	waitIdle(t, mac, dest.ID)
	if _, err := os.Stat(filepath.Join(root, "Notes", "After the pause.md")); err != nil {
		t.Errorf("a resumed export should run: %v", err)
	}

	// Removed from the phone, it's gone from the MacBook too, files left where they are.
	call[map[string]bool](t, phone, "export.destinations.delete", `{"id":"`+dest.ID+`"}`)
	carry(t, phone, mac)
	if views := call[[]exportView](t, mac, "export.destinations.list", ""); len(views) != 0 {
		t.Errorf("removed on the phone, still on the MacBook: %+v", views)
	}
	if _, err := os.Stat(filepath.Join(root, "Notes", "After the pause.md")); err != nil {
		t.Errorf("removing an export leaves its files: %v", err)
	}
}

// Another computer takes a folder export over by naming the folder on its own disk; it writes
// the workspace there, and the old exporter stops once it hears.
func TestFolderExportTakeOver(t *testing.T) {
	mac := exportDevice(t, "Sam's MacBook", true)
	mini := exportDevice(t, "Sam's Mac mini", true)
	call[idOnly](t, mac, "notes.create", `{"title":"Shared","contentMd":"In both."}`)
	call[idOnly](t, mini, "notes.create", `{"title":"Shared","contentMd":"In both."}`)
	onMac := t.TempDir()
	dest := call[exportView](t, mac, "export.destinations.save", `{"kind":"folder","path":`+quote(onMac)+`,"schedule":"changes"}`)
	waitIdle(t, mac, dest.ID)
	pause := call[exportView](t, mac, "export.destinations.setEnabled", `{"id":"`+dest.ID+`","enabled":false}`)
	if pause.Enabled {
		t.Fatal("pause")
	}
	carry(t, mac, mini)

	if _, err := mini.Invoke("export.destinations.save", []byte(`{"id":"`+dest.ID+`","kind":"folder","path":`+quote(t.TempDir())+`}`)); err == nil || !strings.Contains(err.Error(), "take the export over") {
		t.Errorf("editing another device's folder export: %v", err)
	}
	if _, err := mini.Invoke("export.destinations.takeOver", []byte(`{"id":"`+dest.ID+`","path":"/definitely/not/here"}`)); err == nil {
		t.Error("taking over into a folder that isn't there should fail")
	}

	onMini := t.TempDir()
	taken := call[exportView](t, mini, "export.destinations.takeOver", `{"id":"`+dest.ID+`","path":`+quote(onMini)+`}`)
	if !taken.ThisDevice || !taken.Enabled || taken.DeviceName != "Sam's Mac mini" || !strings.Contains(string(taken.Config), onMini) || taken.LastSuccessAt != nil {
		t.Fatalf("after the takeover = %+v", taken)
	}
	waitIdle(t, mini, dest.ID)
	if _, err := os.Stat(filepath.Join(onMini, "Notes", "Shared.md")); err != nil {
		t.Fatalf("the new exporter should write the workspace into its folder: %v", err)
	}

	// The MacBook hears of it: the export is the mini's, and it runs it no more.
	carry(t, mini, mac)
	got := onlyExport(t, mac)
	if got.ThisDevice || got.DeviceName != "Sam's Mac mini" || !got.Enabled || got.LastSuccessAt == nil {
		t.Fatalf("on the MacBook after the takeover = %+v", got)
	}
	call[idOnly](t, mac, "notes.create", `{"title":"Only on the MacBook","contentMd":"Not exported here."}`)
	mac.exportTick(time.Now(), true)
	waitIdle(t, mac, dest.ID)
	if _, err := os.Stat(filepath.Join(onMac, "Notes", "Only on the MacBook.md")); err == nil {
		t.Error("the old exporter must not run a taken-over export")
	}
	if m, _ := mini.store.Exports.Manifest(dest.ID); len(m) == 0 {
		t.Error("the new exporter keeps a manifest of what it wrote")
	}
}
