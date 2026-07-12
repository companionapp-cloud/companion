# syntax=docker/dockerfile:1
#
# Web app (apps/web): the offline WASM PWA, served as a static SPA by Caddy on
# Railway. Build context is the REPO ROOT so the Go workspace (go.work) resolves
# core and the npm workspaces resolve @companion/*:
#   docker build -f apps/web/Dockerfile -t companion-web .
#
# Three stages: (1) compile the Go core to core.wasm, (2) stage it + wasm_exec.js
# into public/ and run the Vite build, (3) serve the static dist with Caddy. This
# mirrors `make web-assets` + `npm run build -w @companion/web`.

# 1. Go core -> WebAssembly. Pinned to the build platform; the wasm/JS output is
#    platform-independent, so there's no need to run this under qemu on multi-arch.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS wasm
WORKDIR /src
COPY . .
RUN GOOS=js GOARCH=wasm go build -C core -ldflags="-s -w" -o /out/core.wasm ./cmd/wasm \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

# 2. Vite build. The staged wasm assets must land in public/ before the build so
#    Vite copies them into dist/ (public/core.wasm + public/wasm_exec.js are gitignored
#    and normally staged by `make web-assets`).
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /src
COPY . .
COPY --from=wasm /out/core.wasm apps/web/public/core.wasm
COPY --from=wasm /out/wasm_exec.js apps/web/public/wasm_exec.js
RUN npm ci --no-audit --no-fund \
 && npm run build -w @companion/web

# 3. Static file server. Caddy binds Railway's $PORT (falling back to 3000), which is
#    the port EXPOSE advertises and Railway's networking targets.
FROM caddy:2-alpine
WORKDIR /srv
COPY apps/web/Caddyfile ./Caddyfile
RUN caddy fmt --overwrite Caddyfile
COPY --from=build /src/apps/web/dist ./dist
EXPOSE 3000
CMD ["caddy", "run", "--config", "Caddyfile", "--adapter", "caddyfile"]
