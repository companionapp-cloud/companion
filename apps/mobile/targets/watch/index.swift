import SwiftUI

// @main entry point for the watchOS companion. The watch is a thin glance over the phone's
// data (source of truth): it reads task lists out of a WCSession-delivered snapshot and can
// send quick-add tasks back. There is no React Native runtime here — pure SwiftUI.
@main
struct CompanionWatchApp: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}
