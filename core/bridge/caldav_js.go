//go:build js

package bridge

import (
	"errors"

	"companion/core/caldav"
	"companion/core/domain"
)

// The web client never speaks CalDAV (PLAN-caldav.md §0). A browser cannot make the cross-origin
// requests, and proxying them through the sync server would hand it the password and every event —
// exactly what end-to-end encryption exists to prevent. Web edits local rows; a native client that
// holds the account pushes them.
const caldavSupported = false

var errCalDAVNative = errors.New("calendar accounts are added from the desktop or mobile app; once added, their events can be edited here too")

func (c *Core) calendarAccountsAdd(payload []byte) ([]byte, error)    { return nil, errCalDAVNative }
func (c *Core) calendarAccountsUpdate(payload []byte) ([]byte, error) { return nil, errCalDAVNative }
func (c *Core) calendarAccountsRescan(payload []byte) ([]byte, error) { return nil, errCalDAVNative }

// No OAuth purposes on web yet: the only one that exists connects a calendar, which the web
// client cannot talk to. A "login" purpose would be registered from a platform-neutral file.
func (c *Core) registerPlatformOAuthPurposes() {}

// canSyncAccount is always false on web: it never reaches a calendar provider.
func (c *Core) canSyncAccount(a *domain.CalendarAccount) bool { return false }

func (c *Core) syncCalDAV(pushOnly bool) ([]caldav.Conflict, error) { return nil, nil }
func (c *Core) pushCalDAVAfterSync()                                {}
