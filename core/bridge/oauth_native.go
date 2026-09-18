//go:build !js

package bridge

import "companion/core/oauth"

func openOAuthLoopback() (oauthLoopback, error) { return oauth.ListenLoopback() }
