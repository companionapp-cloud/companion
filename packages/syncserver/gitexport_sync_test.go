package syncserver

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

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
	// A folder export on the same device travels too, so the mini knows of it — path sealed.
	folder := &store.ExportDestination{Kind: store.ExportKindFolder, Name: "Backup", Config: json.RawMessage(`{"path":"/Users/sam/Backup"}`), Schedule: store.ExportDaily, Enabled: true, DeviceID: "macbook", DeviceName: "Sam's MacBook"}
	if err := mac.store.Exports.Save(folder); err != nil {
		t.Fatal(err)
	}
	if err := mac.engine.Sync(); err != nil {
		t.Fatalf("mac sync: %v", err)
	}

	// The server holds one row of each, and can read nothing in them that matters.
	for table, want := range map[string]string{"git_exports": `"schedule":"changes"`, "folder_exports": `"schedule":"daily"`} {
		rows, err := srv.query(`SELECT row_json FROM ` + table + `;`)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for rows.Next() {
			var body string
			rows.Scan(&body)
			n++
			for _, secret := range []string{"github_pat_SECRET", "github.com/sam/notes", "My notes repo", "Sam's MacBook", "/Users/sam/Backup", "Backup"} {
				if strings.Contains(body, secret) {
					t.Errorf("%q is readable on the server:\n%s", secret, body)
				}
			}
			// What it needs for routing stays readable.
			if !strings.Contains(body, `"deviceId":"macbook"`) || !strings.Contains(body, want) {
				t.Errorf("routing fields should be plaintext:\n%s", body)
			}
		}
		rows.Close()
		if n != 1 {
			t.Fatalf("want exactly one row in %s, got %d", table, n)
		}
	}

	// The other device receives both — the Git one with its credential — and knows it runs neither.
	if err := mini.engine.Sync(); err != nil {
		t.Fatalf("mini sync: %v", err)
	}
	list, _ := mini.store.Exports.List()
	if len(list) != 2 {
		t.Fatalf("the mini should have both exports: %d", len(list))
	}
	var got *store.ExportDestination
	for _, d := range list {
		switch d.Kind {
		case store.ExportKindGit:
			got = d
		case store.ExportKindFolder:
			if d.Name != "Backup" || !strings.Contains(string(d.Config), "/Users/sam/Backup") || d.DeviceID != "macbook" || d.DeviceName != "Sam's MacBook" {
				t.Errorf("the folder export on the mini = %+v", d)
			}
		}
	}
	if got == nil {
		t.Fatal("no git export on the mini")
	}
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

	// Deleting them anywhere removes them everywhere, and wipes the credential from the row.
	for _, id := range []string{dest.ID, folder.ID} {
		if err := mac.store.Exports.Delete(id); err != nil {
			t.Fatal(err)
		}
	}
	mac.engine.Sync()
	mini.engine.Sync()
	if list, _ := mini.store.Exports.List(); len(list) != 0 {
		t.Errorf("the deletions should reach the mini: %+v", list)
	}
	var body string
	if err := srv.queryRow(`SELECT row_json FROM git_exports;`).Scan(&body); err != nil || strings.Contains(body, "credentialEnc") {
		t.Errorf("a tombstone carries no credential: %v %s", err, body)
	}
}

// Only the exporting device reports how its runs go, and a report never dates the settings: so
// whichever reaches the server first, a pause made on another device holds, and the report it
// raced still arrives.
func TestExportPauseBeatsARacingStatusReport(t *testing.T) {
	for _, reportFirst := range []bool{true, false} {
		ts, _ := newServerAPI(t)
		token := register(t, ts.URL, fmt.Sprintf("race-%v@b.co", reportFirst), "password")
		cipher := crypto.NewCipher(mustKey(t))
		mac := newClient(t, ts.URL, token, "macbook")
		mac.engine.SetCipher(cipher)
		phone := newClient(t, ts.URL, token, "phone")
		phone.engine.SetCipher(cipher)

		folder := &store.ExportDestination{Kind: store.ExportKindFolder, Name: "Backup", Config: json.RawMessage(`{"path":"/Users/sam/Backup"}`), Schedule: store.ExportOnChanges, Enabled: true, DeviceID: "macbook", DeviceName: "Sam's MacBook"}
		if err := mac.store.Exports.Save(folder); err != nil {
			t.Fatal(err)
		}
		mustSync(t, mac, phone)

		// The phone pauses the export…
		phone.clk.t = base.Add(time.Hour)
		onPhone, _ := phone.store.Exports.Get(folder.ID)
		onPhone.Enabled = false
		if err := phone.store.Exports.Save(onPhone); err != nil {
			t.Fatal(err)
		}
		// …while the MacBook, not having heard, runs it later still and reports how it went.
		ran := base.Add(2 * time.Hour)
		if err := mac.store.Exports.RecordRun(folder.ID, "macbook", store.ExportRun{RanAt: ran, Success: &ran, Report: true}); err != nil {
			t.Fatal(err)
		}
		if reportFirst {
			mustSync(t, mac, phone)
		} else {
			mustSync(t, phone, mac)
		}
		// The MacBook sends its report once more if the pause overwrote it on the server.
		mustSync(t, mac, phone, mac, phone)

		for name, c := range map[string]*client{"mac": mac, "phone": phone} {
			got, _ := c.store.Exports.Get(folder.ID)
			if got == nil || got.Enabled {
				t.Errorf("report first = %v: on the %s the pause was lost: %+v", reportFirst, name, got)
				continue
			}
			if got.LastRunAt == nil || !got.LastRunAt.Equal(ran) || got.LastSuccessAt == nil {
				t.Errorf("report first = %v: on the %s the MacBook's report was lost: %+v", reportFirst, name, got)
			}
		}
	}
}

func mustSync(t *testing.T, clients ...*client) {
	t.Helper()
	for _, c := range clients {
		if err := c.engine.Sync(); err != nil {
			t.Fatal(err)
		}
	}
}
