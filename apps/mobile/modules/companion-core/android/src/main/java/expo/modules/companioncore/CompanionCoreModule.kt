package expo.modules.companioncore

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import so.companion.core.mobile.Core
import so.companion.core.mobile.EventHandler
import so.companion.core.mobile.Mobile

// Bridges the gomobile-bound Go core (core.aar) to JS. `initialize` opens the SQLite
// database and registers an event sink; `invoke` dispatches JSON in / JSON out. The
// shape (async `invoke(method, payloadJson)` + an `onCoreEvent` emitter) matches
// `@companion/core-bridge/native`.
class CompanionCoreModule : Module() {
  private var core: Core? = null

  override fun definition() = ModuleDefinition {
    Name("CompanionCore")

    Events("onCoreEvent")

    // Opens (or creates) the database at `dbPath`. Idempotent: a second call replaces
    // the handle. Must run before `invoke`.
    Function("initialize") { dbPath: String ->
      val opened = Mobile.new_(dbPath)
      opened.setEventHandler(object : EventHandler {
        // gomobile passes a Go `nil []byte` (payload-less events) as a null byte[], and
        // the name could be null too, so both params must be nullable — declaring them
        // non-null makes Kotlin's generated null-check throw mid-JNI-call (fatal).
        override fun onEvent(name: String?, payload: ByteArray?) {
          sendEvent(
            "onCoreEvent",
            mapOf(
              "name" to (name ?: ""),
              "payload" to (payload?.let { String(it, Charsets.UTF_8) } ?: ""),
            ),
          )
        }
      })
      core = opened
    }

    AsyncFunction("invoke") { method: String, payloadJson: String ->
      val active = core ?: throw CodedException("core not initialized; call initialize(dbPath) first")
      val result = active.invoke(method, payloadJson.toByteArray(Charsets.UTF_8))
      String(result, Charsets.UTF_8)
    }

    OnDestroy {
      core?.setEventHandler(null)
      core?.close()
      core = null
    }
  }
}
