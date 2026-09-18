# companionapp-cloud/homebrew-tap

Homebrew tap for [Companion](https://github.com/companionapp-cloud/companion).

> This repository is generated. Its contents are the `homebrew/` folder of the
> main repo, pushed by the Release workflow on every tagged release. Open pull
> requests against `companionapp-cloud/companion` instead.

## Install

```bash
brew install --cask companionapp-cloud/tap/companion
```

Homebrew 7 asks you to trust a third-party cask the first time you install it.
Answer yes at the prompt, or trust it up front:

```bash
brew trust --cask companionapp-cloud/tap/companion
```

The desktop app is ad-hoc signed and not notarized. Homebrew quarantines every
cask download and Gatekeeper refuses to open a quarantined unsigned app, so the
cask's `postflight_steps` run `xattr -dr com.apple.quarantine` on the installed bundle.
That is the only thing it does beyond a normal cask install, and it's why the
cask lives in this tap rather than in homebrew-cask.

## Updates

Companion updates itself. Within an hour of a new release, the running app
downloads it, blocks its window while it installs, and restarts into it.

Versions 0.6.1 and earlier predate the updater. Upgrade those once through
Homebrew. That also works any time the app can't replace itself:

```bash
brew upgrade --cask companionapp-cloud/tap/companion
```

## Uninstall

```bash
brew uninstall --cask --zap companion
```

`--zap` also removes `~/Library/Application Support/Companion` (the local database).
