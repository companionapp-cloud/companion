package syncserver

import (
	"encoding/json"
	"strings"
	"testing"

	"companion/core/crypto"
	"companion/core/store"
)

// A Git sync is set up once and reaches every device — repository, settings and credential —
// through a server that can read none of it; and the device that set it up stays the only one
// that runs it until another takes over.
func TestGitExportReachesOtherDevicesThroughAnOpaqueServer(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "git@b.co", "password")
	cipher := crypto.NewCipher(mustKey(t))
	mac := newClient(t, ts.URL, token, "macbook")
	mac.engine.SetCipher(cipher)
	mini := newClient(t, ts.URL, token, "mac-mini")
	mini.engine.SetCipher(cipher)

	config, _ := json.Marshal(map[string]string{"provider": "github", "auth": "token", "remoteUrl": "https://github.com/sam/notes.git", "branch": "main"})
	dest := &store.ExportDestination{
		Kind: store.ExportKindGit, Name: "My notes repo", Config: config, CredentialEnc: "github_pat_SECRET",
		Schedule: store.ExportOnChanges, Enabled: true, DeviceID: "macbook", DeviceName: "Sam's MacBook",
	}
	if err := mac.store.Exports.Save(dest); err != nil {
		t.Fatal(err)
	}
	// A folder export on the same device must never leave it.
	folder := &store.ExportDestination{Kind: store.ExportKindFolder, Name: "Backup", Config: json.RawMessage(`{"path":"/Users/sam/Backup"}`), Schedule: store.ExportDaily, Enabled: true}
	if err := mac.store.Exports.Save(folder); err != nil {
		t.Fatal(err)
	}
	if err := mac.engine.Sync(); err != nil {
		t.Fatalf("mac sync: %v", err)
	}

	// The server holds one row, and can read nothing in it that matters.
	rows, err := srv.query(`SELECT row_json FROM git_exports;`)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for rows.Next() {
		var body string
		rows.Scan(&body)
		n++
		for _, secret := range []string{"github_pat_SECRET", "github.com/sam/notes", "My notes repo", "Sam's MacBook", "/Users/sam/Backup"} {
			if strings.Contains(body, secret) {
				t.Errorf("%q is readable on the server:\n%s", secret, body)
			}
		}
		// What it needs for routing stays readable.
		if !strings.Contains(body, `"deviceId":"macbook"`) || !strings.Contains(body, `"schedule":"changes"`) {
			t.Errorf("routing fields should be plaintext:\n%s", body)
		}
	}
	rows.Close()
	if n != 1 {
		t.Fatalf("want exactly the git export on the server, got %d rows", n)
	}

	// The other device receives it whole — credential included — and knows it isn't the exporter.
	if err := mini.engine.Sync(); err != nil {
		t.Fatalf("mini sync: %v", err)
	}
	list, _ := mini.store.Exports.List()
	if len(list) != 1 {
		t.Fatalf("the mini should have the git export and not the folder one: %d", len(list))
	}
	got := list[0]
	if got.CredentialEnc != "github_pat_SECRET" || got.Name != "My notes repo" || !strings.Contains(string(got.Config), "github.com/sam/notes") || got.DeviceID != "macbook" || got.DeviceName != "Sam's MacBook" {
		t.Fatalf("on the mini = %+v", got)
	}
	if got.LastRunAt != nil || got.PushPending {
		t.Errorf("run state is each device's own: %+v", got)
	}

	// The mini takes over; the MacBook hears of it on its next sync.
	got.DeviceID, got.DeviceName = "mac-mini", "Sam's Mac mini"
	if err := mini.store.Exports.Save(got); err != nil {
		t.Fatal(err)
	}
	if err := mini.engine.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := mac.engine.Sync(); err != nil {
		t.Fatal(err)
	}
	onMac, _ := mac.store.Exports.Get(dest.ID)
	if onMac == nil || onMac.DeviceID != "mac-mini" {
		t.Fatalf("the MacBook should learn it no longer exports: %+v", onMac)
	}

	// Deleting it anywhere removes it everywhere, and wipes the credential from the row.
	if err := mac.store.Exports.Delete(dest.ID); err != nil {
		t.Fatal(err)
	}
	mac.engine.Sync()
	mini.engine.Sync()
	if list, _ := mini.store.Exports.List(); len(list) != 0 {
		t.Errorf("the deletion should reach the mini: %+v", list)
	}
	var body string
	if err := srv.queryRow(`SELECT row_json FROM git_exports;`).Scan(&body); err != nil || strings.Contains(body, "credentialEnc") {
		t.Errorf("a tombstone carries no credential: %v %s", err, body)
	}
}
