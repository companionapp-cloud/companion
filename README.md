# companion

A Corepack-managed npm workspaces monorepo.

## Layout

```
apps/       Deployable applications
packages/   Reusable npm packages shared across the workspace
plugins/    Claude Code and Codex plugins (listed in .claude-plugin/marketplace.json)
```

To use Companion from Claude Code, run `/plugin install companion --marketplace companionapp-cloud/companion`. For Codex and setup details, see [plugins/companion](plugins/companion/README.md).

## Requirements

- Node.js >= 20
- [Corepack](https://github.com/nodejs/corepack) enabled (`corepack enable`)

The package manager is pinned via the `packageManager` field in the root
`package.json`. Corepack automatically uses that version — no global npm
install needed.

## Getting started

```bash
corepack enable   # once per machine
npm install       # installs all workspace dependencies
```

## Creating a package

```bash
mkdir -p packages/my-lib
cd packages/my-lib
npm init -y
```

Name it under a scope (e.g. `@companion/my-lib`) and reference it from an app
with `"@companion/my-lib": "*"` — npm links it locally via the workspace.

## Creating an app

```bash
mkdir -p apps/my-app
cd apps/my-app
npm init -y
```

## Workspace scripts

Run from the repo root; each fans out to every workspace that defines the script:

```bash
npm run build   # npm run build --workspaces --if-present
npm run test
npm run lint
npm run dev
```

Target a single workspace with `-w`:

```bash
npm run build -w @companion/my-lib
npm install lodash -w apps/my-app
```
