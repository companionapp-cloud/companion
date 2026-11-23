// companion-fm: the desktop's bridge to Apple's Foundation Models (the on-device Apple
// Intelligence model). Private Cloud Compute is left out: it needs a managed entitlement
// (com.apple.developer.private-cloud-compute) the app doesn't have. Foundation Models is a Swift-only
// framework, so the Go core drives it through this small helper over newline-delimited JSON
// (core/agentrt/foundation.go). One process serves one request and exits, so a crash or a
// stuck generation never takes the app down with it.
//
//   companion-fm check   → prints {"models":[{id, label, available, reason, contextSize}]}
//   companion-fm run     → reads one request line from stdin, then streams events on stdout:
//                            {"type":"usage","setupTokens":…}         instructions + tool definitions
//                            {"type":"delta","text":…}               assistant text as it arrives
//                            {"type":"trace","tool","input","output"} catalog-mode steps (diagnostics)
//                            {"type":"tool_call","id","name","args"}  run this tool and reply
//                            {"type":"done","text":…,"contextTokens":…} the full reply
//                            {"type":"error","message":…,"code":…}
//                          and reads {"type":"tool_result","id","content","isError"} lines back.
//   companion-fm ocr     → reads {"images":[base64 PNG…],"languages":[…]?} from stdin and prints
//                            {"results":[[{"text","confidence","box":{x,y,w,h}}…]…]}, the lines of
//                            handwriting Vision read in each image (box normalized, origin top-left).
//                            Vision needs no Apple Intelligence, so this works on any Mac the
//                            helper runs on.
//
// Tool calls run inside the framework's own loop (a Tool's call() suspends until the host
// replies), so the host answers each one as it comes rather than ending the round.
//
// Catalog mode: a request may put most tools in `catalog` instead of `tools`. Their definitions
// then stay out of the model's context. The model gets one call_tool(name, request) whose
// description is a menu of names and a few words each; call_tool fills in the arguments with a
// side generation guided by that one tool's schema, so arguments stay well-formed while only the
// tool the model picked ever costs context.

import Foundation
import FoundationModels
import ImageIO
import Vision

// MARK: - Wire types

struct WireTool: Decodable {
    let name: String
    let description: String
    let schema: JSONValue?
    /// A few words for call_tool's menu (catalog mode); the description's first sentence if absent.
    let blurb: String?
}

struct WireTurn: Decodable {
    let role: String  // "user" | "assistant"
    let text: String
}

struct WireRequest: Decodable {
    let model: String?
    let system: String?
    let history: [WireTurn]?
    let prompt: String
    let tools: [WireTool]?
    let catalog: [WireTool]?
    let temperature: Double?
}

struct WireToolResult: Decodable {
    let type: String
    let id: String
    let content: String
    let isError: Bool?
}

/// A minimal JSON value, enough to walk a tool's JSON Schema.
indirect enum JSONValue: Decodable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        self = .object(try c.decode([String: JSONValue].self))
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
}

// MARK: - Output

let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    outLock.unlock()
}

func fail(_ message: String, code: String = "error") -> Never {
    emit(["type": "error", "message": message, "code": code])
    exit(1)
}

// MARK: - Models

let onDeviceID = "apple-on-device"

func onDeviceReason(_ r: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch r {
    case .deviceNotEligible: return "This Mac doesn't support Apple Intelligence."
    case .appleIntelligenceNotEnabled: return "Turn on Apple Intelligence in System Settings to use it."
    case .modelNotReady: return "The Apple Intelligence model is still downloading."
    @unknown default: return "Apple Intelligence isn't available right now."
    }
}

func checkModels() -> [[String: Any]] {
    var out: [[String: Any]] = []
    let sys = SystemLanguageModel.default
    var entry: [String: Any] = ["id": onDeviceID, "label": "Apple Intelligence (on device)"]
    switch sys.availability {
    case .available:
        entry["available"] = true
    case .unavailable(let r):
        entry["available"] = false
        entry["reason"] = onDeviceReason(r)
    }
    if #available(macOS 26.2, *) { entry["contextSize"] = sys.contextSize }
    out.append(entry)

    return out
}

// MARK: - JSON Schema → DynamicGenerationSchema

/// Converts the subset of JSON Schema Companion's tools use (objects, strings with enums,
/// numbers, integers, booleans, arrays, nullable unions) into a guided-generation schema.
/// Anything it can't express becomes a string, which the tool handler then parses leniently.
func dynamicSchema(_ s: JSONValue?, name: String) -> DynamicGenerationSchema {
    guard let s else { return DynamicGenerationSchema(type: String.self) }
    let desc = s["description"]?.string
    if let choices = s["enum"]?.array?.compactMap({ $0.string }), !choices.isEmpty {
        return DynamicGenerationSchema(name: name, description: desc, anyOf: choices)
    }
    var type = s["type"]?.string
    if type == nil, let types = s["type"]?.array?.compactMap({ $0.string }) {
        type = types.first { $0 != "null" }  // ["string","null"] → string (optional)
    }
    if type == nil, let alts = (s["anyOf"] ?? s["oneOf"])?.array {
        if let first = alts.first(where: { $0["type"]?.string != "null" }) {
            return dynamicSchema(first, name: name)
        }
    }
    switch type {
    case "object":
        let props = s["properties"]?.object ?? [:]
        let required = Set(s["required"]?.array?.compactMap { $0.string } ?? [])
        let properties = props.keys.sorted().map { key in
            DynamicGenerationSchema.Property(
                name: key,
                description: props[key]?["description"]?.string,
                schema: dynamicSchema(props[key], name: name + "_" + key),
                isOptional: !required.contains(key))
        }
        return DynamicGenerationSchema(name: name, description: desc, properties: properties)
    case "array":
        return DynamicGenerationSchema(arrayOf: dynamicSchema(s["items"], name: name + "_item"))
    case "integer":
        return DynamicGenerationSchema(type: Int.self)
    case "number":
        return DynamicGenerationSchema(type: Double.self)
    case "boolean":
        return DynamicGenerationSchema(type: Bool.self)
    default:
        return DynamicGenerationSchema(type: String.self)
    }
}

func generationSchema(for tool: WireTool) -> GenerationSchema {
    var root = dynamicSchema(tool.schema, name: tool.name + "_args")
    if tool.schema?["type"]?.string != "object" {
        root = DynamicGenerationSchema(name: tool.name + "_args", properties: [])
    }
    if let schema = try? GenerationSchema(root: root, dependencies: []) { return schema }
    // A schema the framework rejects still gets a callable tool with no arguments.
    return try! GenerationSchema(root: DynamicGenerationSchema(name: tool.name + "_args", properties: []), dependencies: [])
}

// MARK: - Tool calls answered by the host

actor ToolReplies {
    private var waiting: [String: CheckedContinuation<WireToolResult, Never>] = [:]
    private var early: [String: WireToolResult] = [:]

    func wait(for id: String) async -> WireToolResult {
        if let r = early.removeValue(forKey: id) { return r }
        return await withCheckedContinuation { waiting[id] = $0 }
    }

    func deliver(_ r: WireToolResult) {
        if let c = waiting.removeValue(forKey: r.id) { c.resume(returning: r) } else { early[r.id] = r }
    }

    /// Unblocks every pending call when stdin closes (the host went away or cancelled).
    func closeAll() {
        for (id, c) in waiting {
            c.resume(returning: WireToolResult(type: "tool_result", id: id, content: "The tool was cancelled.", isError: true))
        }
        waiting.removeAll()
    }
}

let replies = ToolReplies()

/// What tools returned so far this turn: the context call_tool's side generation fills
/// arguments from (ids, titles and dates the model found a step earlier).
actor TurnLog {
    private(set) var entries: [String] = []
    private var seen: [String: String] = [:]
    private var repeats = 0
    /// Counts a repeated call; true once the model has repeated itself past the nudge.
    func repeated() -> Bool { repeats += 1; return repeats > 2 }
    func add(_ name: String, _ output: String) { entries.append("\(name) returned: \(output)") }
    func earlier(_ key: String) -> String? { seen[key] }
    func remember(_ key: String, _ output: String) { seen[key] = output }
    /// The most recent outputs, newest last, within a character budget.
    func recent(limit: Int = 2500) -> String {
        var out: [String] = []
        var used = 0
        for e in entries.reversed() {
            let piece = e.count > 1200 ? String(e.prefix(1200)) + "…" : e
            if used + piece.count > limit { break }
            used += piece.count
            out.append(piece)
        }
        return out.reversed().joined(separator: "\n")
    }
}

let turnLog = TurnLog()

/// Sends one call to the host and waits for its result.
func hostCall(_ name: String, _ args: String) async throws -> String {
    // Small models can loop on a tool. An identical repeat gets the earlier result back, with a
    // nudge, instead of running again.
    let key = name + "\u{0}" + args
    if let prior = await turnLog.earlier(key) {
        emit(["type": "trace", "tool": name, "input": "repeat", "output": ""])
        if await turnLog.repeated() { throw StuckError() }
        return "You already called \(name) with these arguments. Its result: \(prior)\nDon't call it again. Use this to do what the user asked, or answer them."
    }
    let id = UUID().uuidString
    emit(["type": "tool_call", "id": id, "name": name, "args": args.isEmpty ? "{}" : args])
    let r = await replies.wait(for: id)
    let out = (r.isError ?? false) ? "Error: " + r.content : r.content
    await turnLog.add(name, out)
    await turnLog.remember(key, out)
    return out
}

struct HostTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema

    func call(arguments: GeneratedContent) async throws -> String {
        try await hostCall(name, arguments.jsonString)
    }
}

// MARK: - Catalog mode

/// The first sentence of a description, for search results.
func summary(_ s: String) -> String {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if let r = trimmed.range(of: ". ") { return String(trimmed[..<r.lowerBound]) + "." }
    return trimmed.count > 160 ? String(trimmed.prefix(160)) + "…" : trimmed
}

struct CallTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let catalog: [WireTool]
    let userPrompt: String
    let model: SystemLanguageModel
    let name = "call_tool"
    /// The menu: every catalog tool's name and a few words, the only part of the catalog the
    /// main model sees.
    var description: String {
        let menu = catalog.map { "- \($0.name): \($0.blurb ?? summary($0.description))" }.joined(separator: "\n")
        return "Run one of Companion's tools. Pick it by name:\n" + menu + "\nIn request, say exactly what it should do, with every id, title, date and value it needs."
    }
    var parameters: GenerationSchema {
        try! GenerationSchema(root: DynamicGenerationSchema(name: "call_tool_args", properties: [
            .init(name: "name", description: "The tool's name", schema: DynamicGenerationSchema(name: "tool_name", anyOf: catalog.map(\.name))),
            .init(name: "request", description: "What the tool should do, with the ids, titles, dates and values to use", schema: DynamicGenerationSchema(type: String.self)),
        ]), dependencies: [])
    }

    func call(arguments: GeneratedContent) async throws -> String {
        let toolName = (try? arguments.value(String.self, forProperty: "name")) ?? ""
        let request = (try? arguments.value(String.self, forProperty: "request")) ?? ""
        emit(["type": "trace", "tool": "call_tool", "input": toolName, "output": request])
        guard let tool = catalog.first(where: { $0.name == toolName }) else {
            return "Error: no tool named \(toolName)."
        }
        // Fill the arguments in a separate session that sees only this tool's schema.
        let context = await turnLog.recent()
        let side = LanguageModelSession(model: model, instructions: """
            You fill in the arguments for Companion's \(tool.name) tool. \(tool.description)
            Use only values given below. Leave optional fields out unless the request needs them.
            """)
        let prompt = """
            The user said: \(userPrompt)
            \(context.isEmpty ? "" : "Earlier results this turn:\n" + context + "\n")
            Fill in \(tool.name) to do this: \(request)
            """
        let args: String
        do {
            args = try await side.respond(to: prompt, schema: generationSchema(for: tool)).content.jsonString
        } catch {
            return "Error: couldn't fill in \(tool.name): \(describe(error).0)"
        }
        return try await hostCall(tool.name, args)
    }
}



// MARK: - Run

func textSegment(_ s: String) -> Transcript.Segment { .text(Transcript.TextSegment(content: s)) }

func transcript(system: String, history: [WireTurn], tools: [any Tool]) -> Transcript {
    var entries: [Transcript.Entry] = []
    let defs = tools.map { Transcript.ToolDefinition(name: $0.name, description: $0.description, parameters: $0.parameters) }
    entries.append(.instructions(Transcript.Instructions(segments: [textSegment(system)], toolDefinitions: defs)))
    for turn in history where !turn.text.isEmpty {
        if turn.role == "assistant" {
            entries.append(.response(Transcript.Response(assetIDs: [], segments: [textSegment(turn.text)])))
        } else {
            entries.append(.prompt(Transcript.Prompt(segments: [textSegment(turn.text)])))
        }
    }
    return Transcript(entries: entries)
}

let tooLong = ("This conversation is too long for Apple Intelligence. Start a new chat to keep going.", "context")
let stuck = ("Apple Intelligence got stuck repeating the same step. Try asking again with more detail.", "stuck")

/// Thrown from a tool to end the turn when the model keeps repeating the same call.
struct StuckError: Error {}

func describe(_ error: Error) -> (String, String) {
    if error is StuckError { return stuck }
    if let e = error as? LanguageModelSession.ToolCallError {
        if e.underlyingError is StuckError { return stuck }
        return ("A tool failed: \(e.underlyingError.localizedDescription)", "error")
    }
    // LanguageModelError only exists in the macOS 27 SDK (Swift 6.4); an older SDK can't name it,
    // even behind #available, so builds against it rely on the text match below.
    #if compiler(>=6.4)
    if #available(macOS 27.0, *), let e = error as? LanguageModelError {
        switch e {
        case .contextSizeExceeded: return tooLong
        case .guardrailViolation, .refusal: return ("Apple Intelligence declined this request.", "refusal")
        case .rateLimited: return ("Apple Intelligence is busy. Try again in a moment.", "rate_limited")
        case .unsupportedLanguageOrLocale: return ("Apple Intelligence doesn't support this language yet.", "unsupported")
        case .timeout: return ("Apple Intelligence took too long to answer. Try again.", "timeout")
        default: return (e.localizedDescription, "error")
        }
    }
    #endif
    // Overflow also surfaces as wrapped framework errors; match the text so it reads the same.
    let text = String(describing: error)
    if text.contains("exceeds the maximum allowed context size") || (text.contains("Provided") && text.contains("maximum allowed is")) {
        return tooLong
    }
    if let e = error as? LanguageModelSession.GenerationError {
        switch e {
        case .exceededContextWindowSize:
            return tooLong
        case .guardrailViolation:
            return ("Apple Intelligence declined this request.", "refusal")
        case .refusal:
            return ("Apple Intelligence declined this request.", "refusal")
        case .assetsUnavailable:
            return ("The Apple Intelligence model isn't available right now.", "unavailable")
        case .unsupportedLanguageOrLocale:
            return ("Apple Intelligence doesn't support this language yet.", "unsupported")
        case .rateLimited:
            return ("Apple Intelligence is busy. Try again in a moment.", "rate_limited")
        case .concurrentRequests:
            return ("Apple Intelligence is busy with another request.", "rate_limited")
        default:
            return (e.localizedDescription, "error")
        }
    }
    return (text, "error")
}

func run() async {
    guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8) else {
        fail("no request on stdin")
    }
    let req: WireRequest
    do { req = try JSONDecoder().decode(WireRequest.self, from: data) } catch { fail("bad request: \(error)") }

    // Tool results arrive on stdin while the model runs.
    Task.detached {
        while let line = readLine(strippingNewline: true) {
            guard let d = line.data(using: .utf8), let r = try? JSONDecoder().decode(WireToolResult.self, from: d),
                  r.type == "tool_result" else { continue }
            await replies.deliver(r)
        }
        await replies.closeAll()
    }

    let modelID = req.model ?? onDeviceID
    guard modelID == onDeviceID else { fail("Unknown Apple model \(modelID).", code: "unavailable") }
    let sys = SystemLanguageModel.default
    if case .unavailable(let r) = sys.availability { fail(onDeviceReason(r), code: "unavailable") }

    // A tool is only callable with its schema in the instructions: hiding it (Tool's
    // includesSchemaInInstructions = false) drops the tool from the model's view entirely, so
    // shrinking tools is done on the host by shortening descriptions instead.
    var tools: [any Tool] = (req.tools ?? []).map { HostTool(name: $0.name, description: $0.description, parameters: generationSchema(for: $0)) }
    let system = req.system ?? ""
    if let catalog = req.catalog, !catalog.isEmpty {
        tools.append(CallTool(catalog: catalog, userPrompt: req.prompt, model: sys))
    }
    let t = transcript(system: system, history: req.history ?? [], tools: tools)
    if #available(macOS 26.4, *), let n = try? await sys.tokenCount(for: t) {
        emit(["type": "usage", "setupTokens": n])
    }
    let session = LanguageModelSession(model: sys, tools: tools, transcript: t)

    var options = GenerationOptions()
    if let temp = req.temperature { options.temperature = temp }

    var sent = "", last = ""
    do {
        let stream = session.streamResponse(to: req.prompt, options: options)
        for try await snapshot in stream {
            let full = snapshot.content
            last = full
            // Snapshots carry the whole reply so far; send only what's new. A snapshot that
            // rewrites earlier text (rare) is sent in full by the done event instead.
            if full.hasPrefix(sent) {
                let delta = String(full.dropFirst(sent.count))
                if !delta.isEmpty { emit(["type": "delta", "text": delta]) }
                sent = full
            }
        }
        var done: [String: Any] = ["type": "done", "text": last]
        if #available(macOS 26.4, *), let n = try? await sys.tokenCount(for: session.transcript) {
            done["contextTokens"] = n
        }
        emit(done)
    } catch {
        let (msg, code) = describe(error)
        emit(["type": "error", "message": msg, "code": code])
        exit(1)
    }
}

// MARK: - Text recognition

struct OCRRequest: Decodable {
    let images: [String]
    let languages: [String]?
}

/// Reads handwriting in each image with Vision's accurate text recognizer, one result list per
/// image in reading order.
func ocr() {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let req = try? JSONDecoder().decode(OCRRequest.self, from: input) else {
        fail("bad ocr request", code: "bad_request")
    }
    var results: [[[String: Any]]] = []
    for encoded in req.images {
        guard let data = Data(base64Encoded: encoded),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            results.append([])
            continue
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if let languages = req.languages, !languages.isEmpty {
            request.recognitionLanguages = languages
        } else {
            request.automaticallyDetectsLanguage = true
        }
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch {
            fail("text recognition failed: \(error.localizedDescription)", code: "ocr_failed")
        }
        var lines: [[String: Any]] = []
        for observation in request.results ?? [] {
            guard let best = observation.topCandidates(1).first else { continue }
            let b = observation.boundingBox  // normalized, origin bottom-left
            lines.append([
                "text": best.string,
                "confidence": Double(best.confidence),
                "box": ["x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)],
            ])
        }
        results.append(lines)
    }
    emit(["results": results])
}

// MARK: - Main

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "check":
    emit(["models": checkModels()])
case "ocr":
    ocr()
case "run":
    let done = DispatchSemaphore(value: 0)
    Task { await run(); done.signal() }
    done.wait()
default:
    FileHandle.standardError.write("usage: companion-fm check | run | ocr\n".data(using: .utf8)!)
    exit(2)
}
