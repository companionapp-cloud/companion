package bridge

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"companion/core/store"
)

// Device identity (PLAN-agents.md §2.2). Every install has a stable id from first launch;
// the shell tells the core its platform and whether it can host agents (desktop only), and
// the user may rename it in Settings › Sync.

const eventDevicesPresence = "devices.presence"

// deviceShell is what the platform shell knows about this install.
type deviceShell struct {
	platform    string
	defaultName string
	canHost     bool
}

// SetDeviceInfo records the shell's platform ("macos", "ios", "web"…), a default display name
// (hostname / device model) used until the user renames it, and whether this shell can host
// local agents. Call once at startup, before the UI loads.
func (c *Core) SetDeviceInfo(platform, defaultName string, canHost bool) {
	c.device = deviceShell{platform: platform, defaultName: defaultName, canHost: canHost}
	_ = c.store.SetDeviceInfo("", platform)
	// Legacy pre-agents rows (a device-scoped Ollama URL) become agents hosted here, and folder
	// exports made before they synced become exports run here.
	if info, err := c.store.DeviceInfo(); err == nil {
		_, _ = c.store.Agents.ClaimUnhosted(info.ID, c.deviceDisplayName(info))
		c.claimFolderExports(info)
	}
}

// deviceDisplayName is the user-chosen name, else the shell's default, else the platform.
func (c *Core) deviceDisplayName(info store.DeviceInfo) string {
	if strings.TrimSpace(info.Name) != "" {
		return info.Name
	}
	if c.device.defaultName != "" {
		return c.device.defaultName
	}
	if info.Platform != "" {
		return info.Platform
	}
	return "This device"
}

type deviceView struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	CanHost    bool       `json:"canHost"`
	Online     bool       `json:"online"`
	LastSeenAt *time.Time `json:"lastSeenAt,omitempty"`
	IsThis     bool       `json:"isThis"`
}

func (c *Core) devicesThis() ([]byte, error) {
	info, err := c.store.DeviceInfo()
	if err != nil {
		return nil, err
	}
	return json.Marshal(deviceView{
		ID: info.ID, Name: c.deviceDisplayName(info), Platform: info.Platform,
		CanHost: c.device.canHost, Online: true, IsThis: true,
	})
}

func (c *Core) devicesRename(payload []byte) ([]byte, error) {
	var args struct {
		Name string `json:"name"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(args.Name)
	if name == "" {
		return nil, errors.New("name is required")
	}
	if err := c.store.SetDeviceInfo(name, ""); err != nil {
		return nil, err
	}
	info, err := c.store.DeviceInfo()
	if err != nil {
		return nil, err
	}
	// Agents hosted here carry a display copy of the host name, and so do the exports run here;
	// refresh both so other devices see the new name after sync.
	_ = c.store.Agents.SetHostName(info.ID, name)
	c.emitAgentsChanged()
	if err := c.store.Exports.SetDeviceName(info.ID, name); err == nil {
		c.emitExportChanged("")
	}
	return c.devicesThis()
}

// --- presence ---------------------------------------------------------------

// presence is the last-known online state of the user's other devices, fed by the server's
// device list (phase 2) and relay presence events (phase 3). Guarded by presenceMu.
type presenceEntry struct {
	online     bool
	lastSeenAt time.Time
	name       string
	platform   string
	canHost    bool
}

type presenceTable struct {
	mu      sync.Mutex
	devices map[string]presenceEntry
}

func (c *Core) deviceOnline(deviceID string) bool {
	c.presence.mu.Lock()
	defer c.presence.mu.Unlock()
	return c.presence.devices[deviceID].online
}

// devicePresence is what presence knows of a device, if it has heard of it.
func (c *Core) devicePresence(deviceID string) (presenceEntry, bool) {
	if deviceID == "" {
		return presenceEntry{}, false
	}
	c.presence.mu.Lock()
	defer c.presence.mu.Unlock()
	e, ok := c.presence.devices[deviceID]
	return e, ok
}

// setPresence records a device's state and notifies the UI when it went on- or offline. It
// reports whether anything about the device changed, its last sync included.
func (c *Core) setPresence(deviceID string, e presenceEntry) bool {
	c.presence.mu.Lock()
	if c.presence.devices == nil {
		c.presence.devices = map[string]presenceEntry{}
	}
	prev, had := c.presence.devices[deviceID]
	c.presence.devices[deviceID] = e
	c.presence.mu.Unlock()
	if !had || prev.online != e.online {
		p, _ := json.Marshal(map[string]any{"deviceId": deviceID, "online": e.online, "lastSeenAt": e.lastSeenAt})
		c.emit(eventDevicesPresence, p)
		c.emitAgentsChanged()
	}
	return !had || prev.online != e.online || !prev.lastSeenAt.Equal(e.lastSeenAt)
}

// devicesList returns this device plus every other device known from presence.
func (c *Core) devicesList() ([]byte, error) {
	this, err := c.store.DeviceInfo()
	if err != nil {
		return nil, err
	}
	out := []deviceView{{
		ID: this.ID, Name: c.deviceDisplayName(this), Platform: this.Platform,
		CanHost: c.device.canHost, Online: true, IsThis: true,
	}}
	c.presence.mu.Lock()
	for id, e := range c.presence.devices {
		if id == this.ID {
			continue
		}
		last := e.lastSeenAt
		out = append(out, deviceView{ID: id, Name: e.name, Platform: e.platform, CanHost: e.canHost, Online: e.online, LastSeenAt: &last})
	}
	c.presence.mu.Unlock()
	return json.Marshal(out)
}
