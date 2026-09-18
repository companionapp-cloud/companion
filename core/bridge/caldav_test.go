package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"companion/core/caldav/caldavtest"
	"companion/core/domain"
)

// mapSecrets is an in-memory SecretStore.
type mapSecrets map[string]string

func (m mapSecrets) GetSecret(ref string) (string, error) { return m[ref], nil }
func (m mapSecrets) SetSecret(ref, value string) error    { m[ref] = value; return nil }
func (m mapSecrets) DeleteSecret(ref string) error        { delete(m, ref); return nil }

func invoke[T any](t *testing.T, c *Core, method string, args any) T {
	t.Helper()
	payload, _ := json.Marshal(args)
	out, err := c.Invoke(method, payload)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	var v T
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("%s: decode %s: %v", method, out, err)
	}
	return v
}

func calendarItems(t *testing.T, c *Core) []domain.CalendarItem {
	t.Helper()
	all := invoke[[]domain.CalendarItem](t, c, "calendar.range", map[string]string{
		"from": time.Now().AddDate(0, -1, 0).UTC().Format(time.RFC3339),
		"to":   time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339),
	})
	var events []domain.CalendarItem
	for _, it := range all {
		if it.Kind == domain.ItemEvent {
			events = append(events, it)
		}
	}
	return events
}

func TestCalDAVEndToEndOverBridge(t *testing.T) {
	s := caldavtest.New("sam", "app-password")
	defer s.Close()
	work := s.AddCalendar("work", "Work", "#336699", false)
	s.AddCalendar("holidays", "Holidays", "", true)
	start := time.Now().UTC().Truncate(time.Hour).Add(48 * time.Hour)
	s.PutObject(work, "existing.ics", fmt.Sprintf(
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nBEGIN:VEVENT\r\nUID:existing\r\nDTSTAMP:20260101T000000Z\r\n"+
			"DTSTART:%s\r\nDTEND:%s\r\nSUMMARY:Already there\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
		start.Format("20060102T150405Z"), start.Add(time.Hour).Format("20060102T150405Z")))

	c, h := newTestCore(t)
	secrets := mapSecrets{}
	c.SetSecretStore(secrets)

	// A wrong password must not leave an account behind.
	if _, err := c.Invoke("calendar.accounts.add", []byte(fmt.Sprintf(
		`{"serverUrl":%q,"username":"sam","password":"nope"}`, s.URL))); err == nil {
		t.Fatal("expected a bad password to be rejected")
	}
	if got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil); len(got) != 0 {
		t.Fatalf("failed add left an account behind: %+v", got)
	}

	acct := invoke[calendarAccountView](t, c, "calendar.accounts.add", map[string]string{
		"name": "My server", "serverUrl": s.URL, "username": "sam", "password": "app-password",
	})
	if len(acct.Calendars) != 2 || !acct.HasCredential {
		t.Fatalf("account after add: %+v", acct)
	}
	// The password is nowhere in what the UI receives.
	if raw, _ := json.Marshal(acct); strings.Contains(string(raw), "app-password") {
		t.Fatalf("credential leaked to the UI: %s", raw)
	}
	// No E2EE in this test, so it must live in the device keychain, not the synced row.
	stored, _ := c.store.CalendarAccounts.Get(acct.ID)
	if stored.CredentialEnc != nil || secrets["caldav."+acct.ID] != "app-password" {
		t.Fatalf("without E2EE the password belongs in the secret store: %+v / %v", stored, secrets)
	}

	var workFeed, holidayFeed string
	for _, f := range acct.Calendars {
		if f.Name == "Work" {
			workFeed = f.ID
		} else {
			holidayFeed = f.ID
		}
	}

	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	items := calendarItems(t, c)
	if len(items) != 1 || items[0].Title != "Already there" || !items[0].Editable || items[0].Pending {
		t.Fatalf("after refresh: %+v", items)
	}
	if items[0].Color == nil || *items[0].Color != "#336699" {
		t.Errorf("calendar color should come from the provider: %+v", items[0].Color)
	}

	// Create: visible and pending immediately, on the provider after a push.
	newStart := start.Add(3 * time.Hour)
	invoke[map[string]any](t, c, "calendar.events.create", map[string]any{
		"feedId": workFeed, "title": "Lunch", "startsAt": newStart, "endsAt": newStart.Add(time.Hour), "location": "Cafe",
	})
	items = calendarItems(t, c)
	if len(items) != 2 || items[1].Title != "Lunch" || !items[1].Pending {
		t.Fatalf("after create: %+v", items)
	}
	invoke[map[string]any](t, c, "calendar.push", nil)
	if n := len(s.Objects(work)); n != 2 {
		t.Fatalf("provider should hold 2 events, has %d", n)
	}
	items = calendarItems(t, c)
	if items[1].Pending {
		t.Errorf("event should no longer be pending after the push")
	}

	// Update the pre-existing event.
	invoke[map[string]bool](t, c, "calendar.events.update", map[string]any{"id": items[0].SourceID, "title": "Renamed here"})
	invoke[map[string]any](t, c, "calendar.push", nil)
	if !strings.Contains(s.Object(work+"existing.ics"), "SUMMARY:Renamed here") {
		t.Fatalf("provider did not get the rename: %q", s.Object(work+"existing.ics"))
	}

	// Delete it.
	invoke[map[string]bool](t, c, "calendar.events.delete", map[string]any{"id": items[0].SourceID})
	if got := calendarItems(t, c); len(got) != 1 {
		t.Fatalf("delete should hide the event at once: %+v", got)
	}
	invoke[map[string]any](t, c, "calendar.push", nil)
	if s.Object(work+"existing.ics") != "" {
		t.Fatalf("provider still has the deleted event")
	}

	// Read-only calendars and ICS subscriptions refuse writes.
	if _, err := c.Invoke("calendar.events.create", []byte(fmt.Sprintf(
		`{"feedId":%q,"title":"x","startsAt":%q}`, holidayFeed, newStart.Format(time.RFC3339)))); err == nil {
		t.Error("creating in a read-only calendar should fail")
	}

	if h.count(calendarChangedEvent) == 0 {
		t.Error("expected calendar.changed events")
	}

	// Removing the account forgets everything locally and leaves the provider alone.
	invoke[map[string]bool](t, c, "calendar.accounts.remove", map[string]string{"id": acct.ID})
	if got := calendarItems(t, c); len(got) != 0 {
		t.Fatalf("events should be gone with the account: %+v", got)
	}
	if _, ok := secrets["caldav."+acct.ID]; ok {
		t.Error("password should be removed from the keychain")
	}
	if n := len(s.Objects(work)); n != 1 {
		t.Fatalf("removing the account must not delete provider data (have %d)", n)
	}
}

func TestCalDAVConflictIsEmitted(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	work := s.AddCalendar("work", "Work", "", false)
	start := time.Now().UTC().Truncate(time.Hour).Add(24 * time.Hour)
	ics := func(title string) string {
		return fmt.Sprintf("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTAMP:20260101T000000Z\r\n"+
			"DTSTART:%s\r\nSUMMARY:%s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", start.Format("20060102T150405Z"), title)
	}
	s.PutObject(work, "e1.ics", ics("Original"))

	c, h := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	invoke[calendarAccountView](t, c, "calendar.accounts.add", map[string]string{"serverUrl": s.URL, "username": "sam", "password": "pw"})
	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	items := calendarItems(t, c)

	s.PutObject(work, "e1.ics", ics("Changed elsewhere"))
	invoke[map[string]bool](t, c, "calendar.events.update", map[string]any{"id": items[0].SourceID, "title": "Mine"})
	res := invoke[struct {
		Conflicts []struct{ Title string }
	}](t, c, "calendar.push", nil)

	if len(res.Conflicts) != 1 || res.Conflicts[0].Title != "Mine" || h.count(calendarConflictEvent) != 1 {
		t.Fatalf("want one conflict reported and emitted, got %+v (events %v)", res, h.events)
	}
	if got := calendarItems(t, c); len(got) != 1 || got[0].Title != "Changed elsewhere" {
		t.Fatalf("provider copy should win: %+v", got)
	}
}

// Editing a repeating event from the UI: the repeat rule round-trips through events.get, and
// moving the occurrence on screen moves the series (the UI never sees the master event).
func TestRepeatingEventEditingOverBridge(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	work := s.AddCalendar("work", "Work", "", false)
	c, _ := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	acct := invoke[calendarAccountView](t, c, "calendar.accounts.add", map[string]string{"serverUrl": s.URL, "username": "sam", "password": "pw"})

	start := time.Now().UTC().Truncate(24 * time.Hour).Add(34 * time.Hour) // tomorrow 10:00 UTC
	invoke[map[string]any](t, c, "calendar.events.create", map[string]any{
		"feedId": acct.Calendars[0].ID, "title": "Gym", "startsAt": start, "endsAt": start.Add(time.Hour),
		"repeat": map[string]any{"freq": "weekly"},
	})
	items := calendarItems(t, c)
	if len(items) < 3 || !items[0].Recurring {
		t.Fatalf("want a weekly series, got %d items (recurring=%v)", len(items), len(items) > 0 && items[0].Recurring)
	}
	got := invoke[struct {
		Repeat *struct {
			Freq   string
			Custom bool
		}
	}](t, c, "calendar.events.get", map[string]string{"id": items[0].SourceID})
	if got.Repeat == nil || got.Repeat.Freq != "weekly" || got.Repeat.Custom {
		t.Fatalf("events.get repeat: %+v", got.Repeat)
	}

	// Move the SECOND occurrence two hours later: every occurrence follows.
	second := items[1]
	invoke[map[string]bool](t, c, "calendar.events.update", map[string]any{
		"id": second.SourceID, "startsAt": second.StartsAt.Add(2 * time.Hour), "endsAt": second.StartsAt.Add(3 * time.Hour),
	})
	moved := calendarItems(t, c)
	if !moved[0].StartsAt.Equal(start.Add(2*time.Hour)) || !moved[1].StartsAt.Equal(second.StartsAt.Add(2*time.Hour)) {
		t.Fatalf("series should have moved with the edited occurrence: %v / %v", moved[0].StartsAt, moved[1].StartsAt)
	}

	// Stop it repeating from the second occurrence's editor: that occurrence is the one kept.
	invoke[map[string]bool](t, c, "calendar.events.update", map[string]any{"id": moved[1].SourceID, "repeat": map[string]any{"freq": "none"}})
	single := calendarItems(t, c)
	if len(single) != 1 || single[0].Recurring || !single[0].StartsAt.Equal(moved[1].StartsAt) {
		t.Fatalf("after removing the repeat: %+v", single)
	}
	invoke[map[string]any](t, c, "calendar.push", nil)
	for _, ics := range s.Objects(work) {
		if strings.Contains(ics, "RRULE") {
			t.Fatalf("provider still has a rule:\n%s", ics)
		}
	}
}
