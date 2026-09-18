# Homebrew cask for the Companion desktop app (macOS).
#
# This file is the SOURCE for companionapp-cloud/homebrew-tap: the Release workflow
# (.github/workflows/release.yml, `homebrew-tap` job) stamps `version` and `sha256`
# from the freshly built release asset, then pushes the whole ../homebrew folder to
# the tap repo. Edit it here, never in the tap repo directly.
#
# The bundle is ad-hoc signed and not notarized. Homebrew always quarantines cask
# downloads (the --no-quarantine flag was removed in Homebrew 4.7), and Gatekeeper
# refuses to open a quarantined unsigned app, so the postflight_steps below strip the
# attribute after install. Plain install, no flags:
#
#   brew install --cask companionapp-cloud/tap/companion
cask "companion" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/companionapp-cloud/companion/releases/download/v#{version}/Companion-#{version}-macos-universal.zip"
  name "Companion"
  desc "Local-first notes, chats and canvas with a private sync server"
  homepage "https://github.com/companionapp-cloud/companion"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself (apps/desktop/updates.go in the main repo), but this stays false
  # for now: `auto_updates true` would make a plain `brew upgrade` skip the cask, stranding
  # installs from before the updater existed (0.6.1 and earlier), which can only get it
  # through Homebrew. The cost of false is small: after the app updates itself, the next
  # `brew upgrade` reinstalls that same version, because Homebrew's record lags. Flip it
  # once those old installs have moved on.
  auto_updates false
  depends_on :macos

  app "Companion.app"

  # Strip the quarantine attribute Homebrew applied to the download so the ad-hoc
  # signed bundle launches like a locally built one. Runs after the app is moved
  # into place, as the user, no sudo. Drop this once the build is notarized.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Companion.app"]
  end

  zap trash: "~/Library/Application Support/Companion"
end
