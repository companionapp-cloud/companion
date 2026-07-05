//go:build tools

package mobile

// Pin golang.org/x/mobile in the module dependency graph so `gomobile bind` can find
// it. gomobile requires x/mobile in the module of the package being bound; it's only
// used by gomobile's generated glue, never by the app, so this import is excluded
// from every normal build by the `tools` build tag (PLAN §3.2).
import _ "golang.org/x/mobile/bind"
