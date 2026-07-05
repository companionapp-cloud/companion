import ExpoModulesCore
import Core

// Bridges the gomobile-bound Go core (Core.xcframework) to JS. `initialize` opens the
// SQLite database and registers an event sink; `invoke` dispatches JSON in / JSON out.
// The shape (async `invoke(method, payloadJson)` + an `onCoreEvent` emitter) is what
// `@companion/core-bridge/native` expects.
public class CompanionCoreModule: Module {
  private var core: MobileCore?
  private var handler: CoreEventForwarder?

  public func definition() -> ModuleDefinition {
    Name("CompanionCore")

    Events("onCoreEvent")

    // Opens (or creates) the database at `dbPath`. Idempotent: a second call replaces
    // the handle. Must run before `invoke`.
    Function("initialize") { (dbPath: String) throws in
      var error: NSError?
      guard let core = MobileNew(dbPath, &error) else {
        throw CoreException(error?.localizedDescription ?? "failed to open core at \(dbPath)")
      }
      let forwarder = CoreEventForwarder { [weak self] name, payloadJson in
        self?.sendEvent("onCoreEvent", ["name": name, "payload": payloadJson])
      }
      core.setEventHandler(forwarder)
      self.core = core
      self.handler = forwarder
    }

    AsyncFunction("invoke") { (method: String, payloadJson: String) throws -> String in
      guard let core = self.core else {
        throw CoreException("core not initialized; call initialize(dbPath) first")
      }
      let payload = payloadJson.data(using: .utf8) ?? Data()
      let result = try core.invoke(method, payload: payload)
      guard let result else { return "" }
      return String(data: result, encoding: .utf8) ?? ""
    }

    OnDestroy {
      self.core?.setEventHandler(nil)
      try? self.core?.close()
      self.core = nil
      self.handler = nil
    }
  }
}

internal final class CoreException: GenericException<String> {
  override var reason: String { "Companion core error: \(param)" }
}

// Conforms to the gomobile-generated MobileEventHandler protocol and forwards each Go
// core event to the JS emitter, decoding the payload bytes as a UTF-8 JSON string.
private class CoreEventForwarder: NSObject, MobileEventHandler {
  private let forward: (String, String) -> Void
  init(_ forward: @escaping (String, String) -> Void) { self.forward = forward }

  func onEvent(_ name: String?, payload: Data?) {
    let json = payload.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    forward(name ?? "", json)
  }
}
