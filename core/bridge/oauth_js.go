//go:build js

package bridge

import "errors"

// A browser has no loopback listener. A web OAuth flow (a future "sign in with Google") uses a
// fixed redirect back to the app and oauth.complete, so the provider must be configured with one.
func openOAuthLoopback() (oauthLoopback, error) {
	return nil, errors.New("this sign-in needs a redirect address configured for the web app")
}
