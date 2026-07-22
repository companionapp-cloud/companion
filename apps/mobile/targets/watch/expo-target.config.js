/**
 * Watch app target, driven by @bacons/apple-targets. The Swift source in this directory is
 * symlinked into the generated Xcode project (as the virtual `expo:targets` group) on every
 * `expo prebuild`, so the checked-in `ios/` stays disposable — edit watch code only here.
 *
 * The App Group id below MUST stay identical to the main app's group in `app.json`
 * (`expo.ios.entitlements`), or the phone→watch UserDefaults hand-off silently reads nothing.
 *
 * @type {import('@bacons/apple-targets').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'watch',
  // Distinct target/scheme name so it doesn't collide with the phone app's "Companion" scheme
  // in Xcode; `displayName` is what actually shows on the watch.
  name: 'CompanionWatch',
  displayName: 'Companion',
  // watchOS 10 is the floor for the SwiftUI APIs the UI uses (and what Xcode 16 sims ship).
  deploymentTarget: '10.0',
  // WCSession lives in WatchConnectivity; the watch receives the phone's snapshot over it.
  frameworks: ['WatchConnectivity'],
  // Reuses the phone app's icon; the plugin renders the watch icon set from it.
  icon: '../../assets/icon.png',
  entitlements: {
    'com.apple.security.application-groups': ['group.cloud.companion.app'],
  },
});
