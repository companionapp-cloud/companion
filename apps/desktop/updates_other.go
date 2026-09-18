//go:build !darwin

package main

import "errors"

// Self-update ships for macOS only so far (updates.go). Elsewhere there's no bundle to
// replace, so the update service stays disabled and these never run.
var errUpdatesUnsupported = errors.New("self-update isn't supported on this platform yet")

func runningBundle() string { return "" }

func replaceableBundle(string) error { return errUpdatesUnsupported }

func verifyStagedBundle(string, string) error { return errUpdatesUnsupported }
