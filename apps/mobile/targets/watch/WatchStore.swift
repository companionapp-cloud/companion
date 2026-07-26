import Foundation
import Combine
import WatchConnectivity

// The App Group id, shared on-device between the watch app and its (future) complications. This
// is NOT the phone→watch channel — App Groups don't cross devices. The phone delivers the
// snapshot over WCSession (see modules/watch-bridge); we cache it here so a cold-started app
// shows the last-known value. MUST match `group.` in expo-target.config.js.
let kAppGroup = "group.cloud.companion.app"
private let kSnapshotKey = "snapshot"

// One actionable task. `sortKey` is the due timestamp in ms (phone-computed) so the watch never
// parses dates; `overdue` is 0/1 because the WCSession payload carries scalars.
struct WatchTask: Identifiable, Decodable {
  let id: String
  let title: String
  let dueLabel: String
  let overdue: Int
  let sortKey: Double

  var isOverdue: Bool { overdue != 0 }
}

// A project and its open tasks.
struct WatchProject: Identifiable, Decodable {
  let id: String
  let name: String
  let tasks: [WatchTask]
}

// A calendar event. `startKey` is the start timestamp in ms (phone-computed) for ordering.
struct WatchEvent: Identifiable, Decodable {
  let id: String
  let title: String
  let whenLabel: String
  let startKey: Double
  let allDay: Int
}

// True totals (the arrays above may be truncated for the wrist).
struct WatchMeta: Decodable {
  let updatedAt: String
  let todayCount: Int
  let upcomingCount: Int
  let overdueCount: Int
  let somedayCount: Int
  let eventCount: Int
}

// The full snapshot the phone sends as WCSession application context.
struct WatchSnapshot: Decodable {
  var today: [WatchTask] = []
  var upcoming: [WatchTask] = []
  var overdue: [WatchTask] = []
  var someday: [WatchTask] = []
  var projects: [WatchProject] = []
  var events: [WatchEvent] = []
  var meta: WatchMeta?

  static let empty = WatchSnapshot()
}

// Owns the watch's copy of the data and the WCSession. Publishes the latest snapshot the phone
// pushes; between launches it falls back to the last value cached in the App Group. Also sends
// quick-add task requests back to the phone.
final class WatchStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published var snapshot: WatchSnapshot = .empty
  /// Live Add-Task preview: the due label the phone detected in the current title, or nil.
  @Published var detectedDue: String?
  /// Offline fallback: the title looks like it has a date but the phone isn't reachable to parse.
  @Published var offlineDateHint = false

  /// Whether we've ever received/loaded a real snapshot (vs. the empty default).
  var hasData: Bool { snapshot.meta != nil }

  private let defaults = UserDefaults(suiteName: kAppGroup)

  override init() {
    super.init()
    reload() // cold start: show the last cached snapshot immediately
    if WCSession.isSupported() {
      let session = WCSession.default
      session.delegate = self
      session.activate()
    }
  }

  // Re-read the last cached snapshot from the App Group.
  func reload() {
    guard
      let data = defaults?.data(forKey: kSnapshotKey),
      let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data)
    else { return }
    snapshot = decoded
  }

  // Called from the UI on foreground: re-read the cache and pull a fresh snapshot from the phone
  // if it's reachable.
  func refresh() {
    reload()
    if WCSession.isSupported() {
      requestSnapshot(WCSession.default)
    }
  }

  // Send a quick-add task to the phone. `due` is "today", "tomorrow", or "none" (Someday); the
  // phone still auto-detects a date written into the title, which takes precedence. The phone
  // echoes the new task back in the next snapshot.
  func createTask(title: String, due: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    send(["type": "createTask", "title": trimmed, "due": due])
  }

  // Mark a task complete. Optimistically remove it from every list so the row disappears
  // instantly; the phone applies the status change and the next snapshot confirms it (or
  // restores the row if the send never lands).
  func completeTask(id: String) {
    snapshot.today.removeAll { $0.id == id }
    snapshot.upcoming.removeAll { $0.id == id }
    snapshot.overdue.removeAll { $0.id == id }
    snapshot.someday.removeAll { $0.id == id }
    snapshot.projects = snapshot.projects.map { project in
      WatchProject(id: project.id, name: project.name, tasks: project.tasks.filter { $0.id != id })
    }
    send(["type": "completeTask", "id": id])
  }

  // Deliver a watch→phone message: live when reachable (immediate, and the only path the
  // Simulator honors), otherwise queued via transferUserInfo.
  private func send(_ message: [String: Any]) {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    guard session.activationState == .activated else { return }
    if session.isReachable {
      session.sendMessage(message, replyHandler: nil, errorHandler: { _ in
        session.transferUserInfo(message)
      })
    } else {
      session.transferUserInfo(message)
    }
  }

  // Ask the phone to detect a due date in the title as the user types, and publish the label it
  // returns (nil when the title has no date). When the phone isn't reachable we can't parse, but
  // a cheap local heuristic still flags a likely date so the UI can say "Due date detected" — the
  // phone applies the real date once the queued task syncs.
  func parseDue(_ title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let session = WCSession.default
    let reachable = WCSession.isSupported()
      && session.activationState == .activated
      && session.isReachable

    if trimmed.isEmpty {
      DispatchQueue.main.async { self.detectedDue = nil; self.offlineDateHint = false }
      return
    }

    guard reachable else {
      // Offline: no live parse — hint if the title looks like it carries a date.
      let hint = Self.looksLikeDate(trimmed)
      DispatchQueue.main.async { self.detectedDue = nil; self.offlineDateHint = hint }
      return
    }

    session.sendMessage(["type": "parseDate", "title": trimmed], replyHandler: { [weak self] reply in
      let label = reply["dueLabel"] as? String
      DispatchQueue.main.async {
        self?.detectedDue = (label?.isEmpty == false) ? label : nil
        self?.offlineDateHint = false
      }
    }, errorHandler: { [weak self] _ in
      // The send failed after all — fall back to the offline hint.
      let hint = Self.looksLikeDate(trimmed)
      DispatchQueue.main.async { self?.detectedDue = nil; self?.offlineDateHint = hint }
    })
  }

  // A deliberately cheap, high-signal check for "this title probably contains a date phrase".
  // It never parses — it only decides whether to show the offline "Due date detected" hint, so
  // it favors precision (few false positives) over recall. The phone does the real parse on sync.
  static func looksLikeDate(_ text: String) -> Bool {
    let lower = " " + text.lowercased() + " "
    let words = [
      "today", "tomorrow", "tonight",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "weekend", "next week", "this week",
      "january", "february", "march", "april", "june", "july", "august",
      "september", "october", "november", "december",
    ]
    for w in words where lower.contains(" \(w) ") || lower.contains(" \(w),") { return true }
    // Times and relative offsets: "3pm", "10:30 am", "at 5", "in 2 days/weeks/hours".
    let patterns = [
      #"\b\d{1,2}(:\d{2})?\s?(am|pm)\b"#,
      #"\bat\s+\d{1,2}\b"#,
      #"\bin\s+\d+\s+(day|days|week|weeks|hour|hours|min|mins|minute|minutes)\b"#,
    ]
    for p in patterns where lower.range(of: p, options: .regularExpression) != nil { return true }
    return false
  }

  // Ask the phone to push the current snapshot (used on launch — application context isn't
  // delivered in the Simulator, so a fresh watch pulls the latest this way).
  private func requestSnapshot(_ session: WCSession) {
    guard session.isReachable else { return }
    session.sendMessage(["type": "requestSnapshot"], replyHandler: nil, errorHandler: { _ in })
  }

  // MARK: WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
    guard state == .activated else { return }
    if !session.receivedApplicationContext.isEmpty {
      apply(session.receivedApplicationContext)
    }
    requestSnapshot(session)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    apply(applicationContext)
  }

  // Live snapshot push from the phone (the reachable-now path).
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    apply(message)
  }

  // Reachability can flip true shortly after activation; pull the current snapshot when it does.
  func sessionReachabilityDidChange(_ session: WCSession) {
    requestSnapshot(session)
  }

  // Cache the received snapshot into the App Group (for cold start / complications) and publish
  // it to the UI on the main thread.
  private func apply(_ context: [String: Any]) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: context),
      let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data)
    else { return }
    defaults?.set(data, forKey: kSnapshotKey)
    DispatchQueue.main.async {
      self.snapshot = decoded
    }
  }
}
