import ExpoModulesCore
import WatchConnectivity

// Two-way WatchConnectivity bridge between the phone (React Native) and the watch app.
//
//   phone → watch : updateContext() ships the latest task snapshot as *application context*
//                   (coalesced to latest, replayed when the watch next wakes).
//   watch → phone : the watch sends "create task" requests via transferUserInfo; they arrive
//                   here and are forwarded to JS as an `onWatchMessage` event.
//
// App Groups don't cross devices, so WCSession is the only phone↔watch path.
public class WatchBridgeModule: Module {
  private let sessionDelegate = SessionDelegate()

  public func definition() -> ModuleDefinition {
    Name("WatchBridge")

    // Emitted when the watch sends a message (e.g. { type: "createTask", title: "…" }).
    Events("onWatchMessage")

    OnCreate {
      self.sessionDelegate.onMessage = { [weak self] message in
        self?.sendEvent("onWatchMessage", message)
      }
      guard WCSession.isSupported() else { return }
      let session = WCSession.default
      session.delegate = self.sessionDelegate
      session.activate()
    }

    Function("isSupported") { () -> Bool in
      WCSession.isSupported()
    }

    // Answer a reply-expecting watch message (see the reply-variant didReceiveMessage below).
    // JS calls this with the requestId it received and the reply payload.
    Function("respond") { (requestId: String, response: [String: Any]) in
      self.sessionDelegate.resolveReply(requestId, response)
    }

    // Push the latest snapshot two ways: application context (durable — coalesced to latest and
    // replayed when the watch next wakes; the primary path on real devices) and, when the watch
    // is reachable, a live message (immediate — and the only path the Simulator actually delivers).
    // If the session hasn't finished activating yet, we stash it and the delegate flushes on
    // activation, so the first snapshot after launch is never lost.
    Function("updateContext") { (payload: [String: Any]) -> Bool in
      guard WCSession.isSupported() else { return false }
      self.sessionDelegate.pending = payload
      let session = WCSession.default
      guard session.activationState == .activated else { return true }
      let ok = self.sessionDelegate.flush(session)
      if session.isReachable {
        session.sendMessage(payload, replyHandler: nil, errorHandler: { _ in })
      }
      return ok
    }
  }
}

private class SessionDelegate: NSObject, WCSessionDelegate {
  // The most recent snapshot handed to updateContext; retried once the session activates.
  var pending: [String: Any]?
  // Forwards inbound watch messages to the module (set in OnCreate).
  var onMessage: (([String: Any]) -> Void)?
  // Reply handlers for reply-expecting messages, keyed by a requestId we hand to JS.
  private var pendingReplies: [String: ([String: Any]) -> Void] = [:]

  func resolveReply(_ requestId: String, _ response: [String: Any]) {
    if let handler = pendingReplies.removeValue(forKey: requestId) { handler(response) }
  }

  @discardableResult
  func flush(_ session: WCSession) -> Bool {
    guard let payload = pending else { return true }
    do {
      try session.updateApplicationContext(payload)
      return true
    } catch {
      return false
    }
  }

  func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
    if state == .activated { flush(session) }
  }

  // Inbound from the watch. transferUserInfo is the reliable, queued path (delivered even if the
  // phone wasn't reachable at send time); sendMessage covers the reachable-now case.
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    onMessage?(userInfo)
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    onMessage?(message)
  }

  // Reply-expecting variant (the watch sends these with a replyHandler, e.g. "parseDate"). We
  // correlate the async JS reply via a requestId, and time out so a silent JS never leaks the
  // handler.
  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    let requestId = UUID().uuidString
    pendingReplies[requestId] = replyHandler
    var payload = message
    payload["requestId"] = requestId
    onMessage?(payload)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      self?.resolveReply(requestId, [:])
    }
  }

  // iOS-only lifecycle: when the active watch changes, the session deactivates — reactivate so
  // the newly paired watch keeps working.
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) {
    WCSession.default.activate()
  }
}
