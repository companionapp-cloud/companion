# Companion build orchestration (PLAN §8). Go builds live here; npm scripts drive
# the JS side. The Go workspace (go.work) ties core + apps/desktop + apps/server.

GO ?= go
BUILD_DIR ?= build
WASM_EXEC := $(shell $(GO) env GOROOT)/lib/wasm/wasm_exec.js
WEB_PUBLIC := apps/web/public
MOBILE_MODULE := apps/mobile/modules/companion-core

.PHONY: all test test-go fmt vet desktop desktop-frontend desktop-run desktop-app desktop-app-run core-wasm web-assets \
        web-run server server-run gomobile-init core-android core-ios android-lib \
        mobile-artifacts mobile-run db-up db-down db-logs db-reset clean

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

## desktop-app: package the binary into build/Companion.app (macOS). The bundle +
## identifier + a real code signature are what make notifications and launch-at-login work
## (PLAN §6.4); a bare binary silently no-ops both. macOS rejects an ad-hoc signature for
## UNUserNotificationCenter ("Notifications are not allowed for this application"), so we
## sign with the first Apple Development / Developer ID identity in the keychain. Override
## with `make desktop-app CODESIGN_ID="Developer ID Application: ..."`. macOS only.
DESKTOP_APP := $(BUILD_DIR)/Companion.app
CODESIGN_ID ?= $(shell security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development|Developer ID/ {print $$2; exit}')
DESKTOP_SIGN := $(if $(CODESIGN_ID),$(CODESIGN_ID),-)
desktop-app: desktop
	rm -rf "$(DESKTOP_APP)"
	mkdir -p "$(DESKTOP_APP)/Contents/MacOS" "$(DESKTOP_APP)/Contents/Resources"
	cp apps/desktop/packaging/Info.plist "$(DESKTOP_APP)/Contents/Info.plist"
	cp apps/desktop/packaging/AppIcon.icns "$(DESKTOP_APP)/Contents/Resources/AppIcon.icns"
	cp $(BUILD_DIR)/companion-desktop "$(DESKTOP_APP)/Contents/MacOS/companion-desktop"
	@if [ "$(DESKTOP_SIGN)" = "-" ]; then echo "warning: no Developer signing identity found — signing ad-hoc; notifications will be rejected by macOS"; fi
	codesign --force --sign "$(DESKTOP_SIGN)" --identifier com.companion.desktop "$(DESKTOP_APP)"
	@echo "Built $(DESKTOP_APP) (signed: $(DESKTOP_SIGN))"

## desktop-app-run: package the .app and launch it through LaunchServices (macOS).
## MUST go through `open`, not the inner binary directly — UNUserNotificationCenter
## rejects directly-exec'd processes with "Notifications are not allowed for this
## application". Stdout/stderr are redirected to a log so the notify: lines are visible.
DESKTOP_APP_LOG := $(BUILD_DIR)/companion-desktop.log
desktop-app-run: desktop-app
	@pkill -x companion-desktop 2>/dev/null || true
	@sleep 1
	: > "$(DESKTOP_APP_LOG)"
	open "$(DESKTOP_APP)" --stdout "$(DESKTOP_APP_LOG)" --stderr "$(DESKTOP_APP_LOG)"
	@echo "Launched. Logs -> $(DESKTOP_APP_LOG)  (run: tail -f $(DESKTOP_APP_LOG))"

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

## core-android: bind the mobile core -> build/core.aar (needs Android SDK + NDK).
## -androidapi 21 is the NDK's minimum supported platform (default 16 is rejected).
core-android:
	mkdir -p $(BUILD_DIR)
	cd core && gomobile bind -target=android -androidapi 21 -javapkg=so.companion.core \
		-o ../$(BUILD_DIR)/core.aar ./cmd/mobile

## core-ios: bind the mobile core -> build/Core.xcframework (needs Xcode)
core-ios:
	mkdir -p $(BUILD_DIR)
	cd core && gomobile bind -target=ios \
		-o ../$(BUILD_DIR)/Core.xcframework ./cmd/mobile

## android-lib: decompose build/core.aar into the Expo module. Local .aar file-deps
## aren't resolvable under Expo/RN's centralized Gradle repositories, so we ship the
## Java classes as a plain jar (libs/core.jar) and the JNI libs under jniLibs/ (which
## AGP packages automatically).
android-lib: core-android
	rm -rf $(MOBILE_MODULE)/android/libs $(MOBILE_MODULE)/android/src/main/jniLibs $(BUILD_DIR)/core-aar
	mkdir -p $(MOBILE_MODULE)/android/libs $(MOBILE_MODULE)/android/src/main/jniLibs
	cd $(BUILD_DIR) && unzip -o -q core.aar classes.jar 'jni/*' -d core-aar
	cp $(BUILD_DIR)/core-aar/classes.jar $(MOBILE_MODULE)/android/libs/core.jar
	cp -R $(BUILD_DIR)/core-aar/jni/. $(MOBILE_MODULE)/android/src/main/jniLibs/
	rm -rf $(BUILD_DIR)/core-aar

## mobile-artifacts: build both bindings and place them into the Expo local module
## (apps/mobile/modules/companion-core) where the podspec/build.gradle expect them.
mobile-artifacts: android-lib core-ios
	rm -rf $(MOBILE_MODULE)/ios/vendor/Core.xcframework
	mkdir -p $(MOBILE_MODULE)/ios/vendor
	cp -R $(BUILD_DIR)/Core.xcframework $(MOBILE_MODULE)/ios/vendor/Core.xcframework

## mobile-run: build the Android core binding + run the mobile app on Android
## (emulator or connected device). Only needs the aar, so no Xcode required; the
## first run regenerates the native android/ project via expo prebuild.
mobile-run: mobile-artifacts
	npm run android -w @companion/mobile

android-run: mobile-run

ios-run: mobile-artifacts
	npm run ios -w @companion/mobile

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
