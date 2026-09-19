//go:build js

package things

// The web build's time.Local is a fixed offset with no daylight saving, so the user's zone is
// loaded by name — which needs the zone database embedded (about 450 KB) (PLAN §6.12).
import _ "time/tzdata"
