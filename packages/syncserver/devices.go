package syncserver

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Devices (PLAN-agents.md §2.2, §5.1). Every install registers itself so the account has a
// list of devices with names, platforms and whether each can host local agents. Presence is
// live, not stored: a device is online while it holds an open relay inbox (desktops that host)
// — for everything else last_seen_at (bumped by every sync) is the best available signal.

// deviceHeader carries the caller's device id on sync requests so the server can bump
// last_seen_at without an extra round trip. Not a secret: it's a per-install UUID.
const deviceHeader = "X-Companion-Device"

// deviceWire is the JSON shape of a device on POST/GET /v1/devices.
type deviceWire struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Platform   string    `json:"platform"`
	CanHost    bool      `json:"canHost"`
	Online     bool      `json:"online"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

// handleDevicesUpsert registers or refreshes the calling device.
func (s *Server) handleDevicesUpsert(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var in deviceWire
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	in.ID = strings.TrimSpace(in.ID)
	if in.ID == "" || len(in.ID) > 64 || len(in.Name) > 512 || len(in.Platform) > 32 {
		writeErr(w, http.StatusBadRequest, "device id, name and platform are required and bounded")
		return
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	// A device id belongs to exactly one user; refuse to let another account claim it.
	var owner string
	err := s.queryRow(`SELECT user_id FROM devices WHERE id = ?;`, in.ID).Scan(&owner)
	if err != nil && err != sql.ErrNoRows {
		writeErr(w, http.StatusInternalServerError, "device lookup failed")
		return
	}
	if err == nil && owner != uid {
		writeErr(w, http.StatusConflict, "device id is registered to another account")
		return
	}
	if _, err := s.exec(
		`INSERT INTO devices (id, user_id, name, platform, can_host, last_seen_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		   name = excluded.name, platform = excluded.platform, can_host = excluded.can_host, last_seen_at = excluded.last_seen_at;`,
		in.ID, uid, in.Name, in.Platform, boolInt(in.CanHost), now, now); err != nil {
		writeErr(w, http.StatusInternalServerError, "device store failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleDevicesList returns the account's devices with live presence.
func (s *Server) handleDevicesList(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	list, err := s.listDevices(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "device list failed")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) listDevices(uid string) ([]deviceWire, error) {
	rows, err := s.query(`SELECT id, name, platform, can_host, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC;`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []deviceWire{}
	for rows.Next() {
		var d deviceWire
		var canHost int
		var seen string
		if err := rows.Scan(&d.ID, &d.Name, &d.Platform, &canHost, &seen); err != nil {
			return nil, err
		}
		d.CanHost = canHost != 0
		d.LastSeenAt, _ = time.Parse(timeFormat, seen)
		d.Online = s.relay.online(d.ID)
		out = append(out, d)
	}
	return out, rows.Err()
}

// touchDevice bumps last_seen_at for the device named in the request header, if any. Failures
// are ignored: presence is advisory and must never fail a sync.
func (s *Server) touchDevice(uid string, r *http.Request) {
	id := strings.TrimSpace(r.Header.Get(deviceHeader))
	if id == "" {
		return
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	_, _ = s.exec(`UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?;`, now, id, uid)
}

// deviceOwnedBy reports whether deviceID is registered to uid.
func (s *Server) deviceOwnedBy(uid, deviceID string) (bool, error) {
	var owner string
	err := s.queryRow(`SELECT user_id FROM devices WHERE id = ?;`, deviceID).Scan(&owner)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return owner == uid, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
