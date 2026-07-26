# Releasing & Code Signing

How Companion ships to internal test channels and the release page, and the one-time
signing setup each requires.

| Target | Source | Channel | Driver | Signing you must set up |
|---|---|---|---|---|
| Android | `apps/mobile` | Play **internal testing** | fastlane `supply` | Upload keystore + Play App Signing |
| iOS | `apps/mobile` | **TestFlight** (internal) | fastlane `pilot` | Apple distribution cert + profile (via `match`) |
| macOS | `apps/desktop` | **Release page** (`.dmg`) | `make desktop-dmg` + CI | Developer ID Application cert + notarization |
| Windows | `apps/desktop` | **Release page** (`.zip`) | CI (`desktop-release.yml`) | Authenticode cert (optional) |
| Linux | `apps/desktop` | **Release page** (`.tar.gz`) | `make desktop-archive` + CI | None |

> Fastlane only covers iOS + Android. The desktop targets are built by
> [`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml) on
> per-OS runners. The desktop jobs run and upload **unsigned** artifacts until the
> signing secrets exist, so nothing breaks before you finish the steps below.

---

## 0. Prerequisites (accounts + tooling)

You don't have these yet — start here. Both account approvals take time (Apple: hours;
Google: **up to a few days** for identity verification), so kick them off first.

### Apple Developer Program — **$99/yr**, covers iOS TestFlight **and** macOS signing/notarization
1. Sign in at <https://developer.apple.com/programs/enroll/> with your Apple ID.
2. Enable two-factor auth on the Apple ID (required).
3. Enroll as an **Individual** (or Organization if you have a D-U-N-S number). Pay the
   $99. Wait for the "Welcome" email.
4. Note two IDs you'll need later:
   - **Team ID** (10 chars) — <https://developer.apple.com/account> → Membership.
   - **App Store Connect Team ID** (numeric) — appears in App Store Connect URLs / API.

### Google Play Developer — **$25 one-time**, Android only
1. Sign up at <https://play.google.com/console/signup>. Pick a **personal** or
   **organization** account.
2. Complete identity + (for orgs) D-U-N-S verification. **This can take a few days** —
   you cannot publish until it clears.
3. Pay the $25.

### Local tooling
```bash
# Ruby is already present (system). Install the pinned fastlane:
cd apps/mobile && bundle install

# Xcode + command line tools (macOS, for iOS + desktop notarization)
xcode-select --install

# Android: JDK 17 + Android SDK. Easiest via Android Studio, or:
brew install --cask temurin@17
```

---

## 1. iOS → TestFlight

### 1a. Register the app
1. App Store Connect → <https://appstoreconnect.apple.com> → **Apps → +** → New App.
2. Platform **iOS**, bundle ID **`cloud.companion.app`** (create it in
   Certificates, IDs & Profiles → Identifiers first if it isn't offered).

### 1b. App Store Connect API key (no-2FA uploads)
1. App Store Connect → **Users and Access → Integrations → App Store Connect API**.
2. Generate a key with **App Manager** access. **Download the `.p8` once** (you can't
   re-download it). Note the **Key ID** and **Issuer ID**.
3. Base64-encode it for the `.env` / CI secrets:
   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
   ```
   → `ASC_KEY_P8`, plus `ASC_KEY_ID`, `ASC_ISSUER_ID`.

### 1c. Signing via `match`
`match` stores the distribution certificate + provisioning profile **encrypted in a
private git repo** so every machine + CI shares one identity (no "cert already exists"
churn).

1. Create an **empty private repo**, e.g. `companion-certificates`.
2. Point `MATCH_GIT_URL` at it and pick a strong `MATCH_PASSWORD` (the encryption key —
   store it in your password manager).
3. First run creates the cert + App Store profile in your Apple account and pushes the
   encrypted copies:
   ```bash
   cd apps/mobile
   cp fastlane/.env.default fastlane/.env   # then fill it in
   bundle exec fastlane match appstore
   ```
   Everywhere else (CI, second machine) consumes them read-only automatically — the
   `ios beta` lane calls `match(..., readonly: true)`.

### 1d. Ship it
```bash
cd apps/mobile
bundle exec fastlane ios beta   # prebuild → pod install → build → upload to TestFlight
```
Then in App Store Connect → TestFlight, add yourself to **Internal Testing**. Internal
builds are available in minutes with no review.

---

## 2. Android → Play internal testing

### 2a. Create the app + upload keystore
1. Play Console → **Create app**, package **`cloud.companion.app`**.
2. Generate an **upload keystore** (this is *your* key; Google holds the real signing
   key via Play App Signing):
   ```bash
   keytool -genkeypair -v -keystore upload-keystore.jks \
     -alias upload -keyalg RSA -keysize 2048 -validity 9125
   ```
   Keep `upload-keystore.jks` **out of git** (already gitignored). Record the store
   password, key alias (`upload`), and key password → the `COMPANION_UPLOAD_*` vars.
3. The Expo config plugin [`plugins/withAndroidSigning.js`](apps/mobile/plugins/withAndroidSigning.js)
   wires these into the generated `android/` project on every `expo prebuild`, so the
   release AAB is signed with your upload key. No manual `build.gradle` edits.

### 2b. Play App Signing + first upload
- Play requires the **first release to be uploaded manually** (to enroll in Play App
  Signing and satisfy the store listing). Build one and upload it by hand once:
  ```bash
  cd apps/mobile && npx expo prebuild --platform android --no-install
  (cd android && ./gradlew bundleRelease)   # AAB at android/app/build/outputs/bundle/release/
  ```
  Create the **Internal testing** track and upload that AAB. After this, fastlane can
  take over.

### 2c. Service account for fastlane `supply`
1. Play Console → **Setup → API access** → link/create a Google Cloud project.
2. Create a **service account**, grant it **Release manager** (or a custom role with
   release permissions) under **Users & permissions**.
3. Create a **JSON key** for it → save as `apps/mobile/fastlane/play-service-account.json`
   (gitignored). Set `PLAY_JSON_KEY_PATH` to it.
4. Verify:
   ```bash
   cd apps/mobile && bundle exec fastlane run validate_play_store_json_key
   ```

### 2d. Ship it
```bash
cd apps/mobile
bundle exec fastlane android beta   # builds AAB → uploads to the internal track
```

---

## 3. macOS → notarized `.dmg` (release page)

We ship a **Developer ID–signed, notarized** `.dmg` (not the Mac App Store — that would
force App Sandbox + review on the Wails app). Notifications and launch-at-login already
depend on a real signature (see the `desktop-app` target in the Makefile).

### 3a. Certificate
1. Certificates, IDs & Profiles → **+** → **Developer ID Application**. Create it in
   Xcode (Settings → Accounts → Manage Certificates → + → Developer ID Application) or
   the portal, then confirm it's in your login keychain:
   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
2. Notarization uses the **same App Store Connect API key** from §1b (reused as
   `NOTARY_KEY_P8` / `NOTARY_KEY_ID` / `NOTARY_ISSUER`).

### 3b. Build locally
```bash
export NOTARY_KEY_P8="$(base64 -i AuthKey_XXXX.p8)"
export NOTARY_KEY_ID=XXXXXXXXXX
export NOTARY_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
make desktop-dmg VERSION=v0.1.0
# → build/dist/Companion-v0.1.0-macos-arm64.dmg  (signed, notarized, stapled)
```
Hardened-runtime entitlements live in
[`apps/desktop/packaging/entitlements.plist`](apps/desktop/packaging/entitlements.plist).

---

## 4. Windows → `.zip` on the release page

Ships from CI. Code signing (Authenticode) is **optional** but avoids SmartScreen
"unknown publisher" warnings.
- **With a cert:** buy an OV/EV code-signing certificate (DigiCert, Sectigo, etc.),
  export as `.pfx`, and set the `WINDOWS_CERT_PFX` (base64) + `WINDOWS_CERT_PASSWORD`
  secrets. CI signs with `signtool` automatically.
- **Without:** CI still produces an unsigned `.exe` zip.

Local build (on Windows): `make desktop && 7z a Companion.zip build/companion-desktop.exe`.

---

## 5. Linux → `.tar.gz` on the release page

No signing needed.
```bash
# Needs GTK/WebKit dev libs (CI installs them; locally on Debian/Ubuntu):
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev pkg-config
make desktop-archive VERSION=v0.1.0
```

---

## 6. CI secrets

Add these under **Repo → Settings → Secrets and variables → Actions**. Mobile ships from
[`.github/workflows/mobile-release.yml`](.github/workflows/mobile-release.yml) (iOS on a
macOS runner, Android on Linux); desktop from
[`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml). Both
fire on a `v*` tag, and mobile also has a manual **Run workflow** (choose ios/android/both).

| Secret | Used by | Notes |
|---|---|---|
| `APPLE_TEAM_ID`, `ASC_TEAM_ID` | iOS | portal team id (10-char) + App Store Connect team id (numeric) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | iOS + macOS notarization | `.p8` base64-encoded |
| `MATCH_GIT_URL`, `MATCH_PASSWORD` | iOS `match` | certs repo + passphrase |
| `MATCH_GIT_BASIC_AUTHORIZATION` | iOS `match` in CI | base64 of `user:PAT` for the certs repo |
| `ANDROID_KEYSTORE_BASE64` | Android | the upload `.jks`, base64-encoded (`base64 -i upload-keystore.jks`) |
| `COMPANION_UPLOAD_STORE_PASSWORD`, `COMPANION_UPLOAD_KEY_ALIAS`, `COMPANION_UPLOAD_KEY_PASSWORD` | Android | keystore creds |
| `PLAY_SERVICE_ACCOUNT_JSON` | Android `supply` | service-account JSON, base64-encoded |
| `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD` | macOS | Developer ID cert exported as `.p12`, base64 |
| `NOTARY_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER` | macOS notarization | reuse the ASC API key |
| `WINDOWS_CERT_PFX`, `WINDOWS_CERT_PASSWORD` | Windows (optional) | Authenticode `.pfx`, base64 |

### Never commit
`fastlane/.env`, `fastlane/play-service-account.json`, any `*.jks` / `*.p8` / `*.p12` /
`*.mobileprovision`, `upload-keystore.jks`, `MATCH_PASSWORD`. All are gitignored — keep
the originals in a password manager / secure vault; they are **not recoverable** if lost
(a lost upload keystore requires a Play support reset; a lost `match` passphrase means
regenerating certs).
