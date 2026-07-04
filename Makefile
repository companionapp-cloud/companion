# Companion build orchestration (PLAN §8). Go builds live here; npm scripts drive
# the JS side. The Go workspace (go.work) ties core + apps/desktop + apps/server.

GO ?= go
BUILD_DIR ?= build
WASM_EXEC := $(shell $(GO) env GOROOT)/lib/wasm/wasm_exec.js
WEB_PUBLIC := apps/web/public

.PHONY: all test test-go fmt vet desktop desktop-frontend desktop-run core-wasm web-assets \
        web-run server server-run gomobile-init core-android core-ios \
        db-up db-down db-logs db-reset clean

all: test

## test-go: run the Go core + desktop + server test suites (fast, headless SQLite)
test-go:
	$(GO) test ./core/... ./apps/desktop/... ./apps/server/...

## test-server-pg: run the server suite against the compose Postgres *test* database
## (make db-up first). Never touches the dev database.
test-server-pg:
	@set -a; if [ -f .env ]; then . ./.env; fi; set +a; \
	COMPANION_TEST_DB="$${TEST_DATABASE_URL:-postgres://companion:companion@localhost:5432/companion_test?sslmode=disable}" \
	$(GO) test -C apps/server -count=1 .

test: test-go

## fmt: format all Go code
fmt:
	gofmt -w core apps/desktop

## vet: static analysis over all Go modules
vet:
	cd core && $(GO) vet ./...
	cd apps/desktop && $(GO) vet ./...

## desktop-frontend: build the react-native-web webview UI into frontend/dist
desktop-frontend:
	npm run build -w @companion/desktop-frontend

## desktop: build the Wails desktop binary (frontend is built + embedded)
desktop: desktop-frontend
	mkdir -p $(BUILD_DIR)
	cd apps/desktop && $(GO) build -o ../../$(BUILD_DIR)/companion-desktop .

## desktop-run: build the frontend, then run the desktop app from source (dev)
desktop-run: desktop-frontend
	cd apps/desktop && $(GO) run .

## core-wasm: build the web core (GOOS=js GOARCH=wasm) -> build/core.wasm
core-wasm:
	mkdir -p $(BUILD_DIR)
	cd core && GOOS=js GOARCH=wasm $(GO) build -ldflags="-s -w" -o ../$(BUILD_DIR)/core.wasm ./cmd/wasm

## web-assets: build core.wasm and stage it + wasm_exec.js into the web app's public dir
web-assets: core-wasm
	mkdir -p $(WEB_PUBLIC)
	cp $(BUILD_DIR)/core.wasm $(WEB_PUBLIC)/core.wasm
	cp "$(WASM_EXEC)" $(WEB_PUBLIC)/wasm_exec.js

## web-run: stage the wasm core, then run the web app (Vite dev server, :5273)
web-run: web-assets
	npm run dev -w @companion/web

## server: build the sync API server binary
server:
	mkdir -p $(BUILD_DIR)
	cd apps/server && $(GO) build -o ../../$(BUILD_DIR)/companion-server .

## server-run: run the sync API server from source (dev, :8080). Loads .env if
## present, so DATABASE_URL points it at the compose Postgres.
server-run:
	@set -a; if [ -f .env ]; then . ./.env; fi; set +a; cd apps/server && $(GO) run .

## gomobile-init: install + initialise gomobile (needs Xcode / Android NDK, PLAN §3.2)
gomobile-init:
	$(GO) install golang.org/x/mobile/cmd/gomobile@latest
	$(GO) install golang.org/x/mobile/cmd/gobind@latest
	gomobile init

## core-android: bind the mobile core -> build/core.aar (needs Android SDK + NDK)
core-android:
	mkdir -p $(BUILD_DIR)
	cd core && gomobile bind -target=android -javapkg=so.companion.core \
		-o ../$(BUILD_DIR)/core.aar ./cmd/mobile

## core-ios: bind the mobile core -> build/Core.xcframework (needs Xcode)
core-ios:
	mkdir -p $(BUILD_DIR)
	cd core && gomobile bind -target=ios \
		-o ../$(BUILD_DIR)/Core.xcframework ./cmd/mobile

## db-up: start the local development database(s) in the background
db-up:
	docker compose up -d

## db-down: stop the development database(s) (keeps data)
db-down:
	docker compose down

## db-logs: follow the database logs
db-logs:
	docker compose logs -f

## db-reset: destroy and recreate the development database (drops all data)
db-reset:
	docker compose down -v
	docker compose up -d

clean:
	rm -rf $(BUILD_DIR)
