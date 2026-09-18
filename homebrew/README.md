# companionapp-cloud/homebrew-tap

Homebrew tap for [Companion](https://github.com/companionapp-cloud/companion).

> This repository is generated. Its contents are the `homebrew/` folder of the
> main repo, pushed by the Release workflow on every tagged release. Open pull
> requests against `companionapp-cloud/companion` instead.

## Install

The desktop app is ad-hoc signed and not notarized, so tell Homebrew not to
quarantine the download. Without `--no-quarantine`, Gatekeeper refuses to open it.

```bash
brew install --cask --no-quarantine companionapp-cloud/tap/companion
```

Upgrades need the same flag:

```bash
brew upgrade --cask --no-quarantine companion
```

Or set it once in your shell profile so every cask command picks it up:

```bash
export HOMEBREW_CASK_OPTS="--no-quarantine"
```

## Uninstall

```bash
brew uninstall --cask --zap companion
```

`--zap` also removes `~/Library/Application Support/Companion` (the local database).
