package bridge

import (
	"encoding/json"
	"errors"

	syncpkg "companion/core/sync"

	"github.com/google/uuid"
)

// syncConfig holds the server endpoint + bearer token the client syncs against. The
// shell obtains the token from auth (register/login) and stores it in the OS keychain
// / SecureStore; here it is held in memory for the process lifetime.
type syncConfig struct {
	baseURL  string
	token    string
	deviceID string
}

func (c *Core) syncConfigure(payload []byte) ([]byte, error) {
	var args struct {
		BaseURL string `json:"baseUrl"`
		Token   string `json:"token"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.BaseURL == "" {
		return nil, errors.New("baseUrl is required")
	}
	if c.sync.deviceID == "" {
		id, err := uuid.NewV7()
		if err != nil {
			return nil, err
		}
		c.sync.deviceID = id.String()
	}
	if err := c.store.EnsureSyncState(c.sync.deviceID); err != nil {
		return nil, err
	}
	c.sync.baseURL = args.BaseURL
	c.sync.token = args.Token
	return json.Marshal(map[string]bool{"ok": true})
}

// syncRun performs one push→pull cycle and signals the UI to refresh.
func (c *Core) syncRun() ([]byte, error) {
	if c.sync.baseURL == "" {
		return nil, errors.New("sync is not configured")
	}
	engine := syncpkg.New(c.store, syncpkg.NewHTTPTransport(c.sync.baseURL, c.sync.token), nil)
	if err := engine.Sync(); err != nil {
		return nil, err
	}
	c.emit(notesChangedEvent, nil)
	return json.Marshal(map[string]bool{"ok": true})
}
