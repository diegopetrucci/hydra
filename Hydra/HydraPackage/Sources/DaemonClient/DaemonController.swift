import Foundation

// MARK: - StdinHandleBox

/// Thread-safe box for the daemon's stdin `FileHandle`.
///
/// Exists so `applicationWillTerminate` (main thread, synchronous) can close
/// the handle without `await`-ing the actor.
///
/// Safety (`@unchecked Sendable`): all mutations are protected by `NSLock`.
public final class StdinHandleBox: @unchecked Sendable {
    private let lock = NSLock()
    private var handle: FileHandle?

    public init() {}

    fileprivate func update(_ handle: FileHandle?) {
        lock.withLock { self.handle = handle }
    }

    /// Closes the handle and clears the reference. Idempotent.
    public func closeAndClear() {
        var h: FileHandle?
        lock.withLock { h = self.handle; self.handle = nil }
        h?.closeFile()
    }
}

// MARK: - DaemonController

/// Manages the lifecycle of the daemon process and marshals requests/responses.
///
/// All mutable state is actor-isolated.  `FileHandle` is not `Sendable`, so
/// references that must cross concurrency boundaries are wrapped in
/// `SendableFileHandle`.
actor DaemonController {

    // MARK: - SendableFileHandle

    /// Wraps a `FileHandle` for safe transfer across task boundaries.
    ///
    /// Safety (`@unchecked Sendable`): each instance is handed to exactly one Task
    /// (stdout reader or stderr drainer) and never shared further.
    struct SendableFileHandle: @unchecked Sendable {
        let handle: FileHandle
    }

    // MARK: - Event stream (nonisolated: callers don't need await)

    nonisolated let eventStream: AsyncStream<DaemonEvent>
    private let eventContinuation: AsyncStream<DaemonEvent>.Continuation

    // MARK: - StdinHandleBox (nonisolated: synchronous access from AppDelegate)

    nonisolated let stdinHandleBox = StdinHandleBox()

    // MARK: - Actor-isolated state

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var lineBuffer = LineBuffer()
    private var pendingRequests: [String: CheckedContinuation<Data, Error>] = [:]
    private var requestCounter: Int = 0
    private var backoffSeconds: Double = 1.0
    private var restartAttempt: Int = 0
    private static let maxBackoffSeconds: Double = 30.0
    private var isConnected = false

    // MARK: - Environment overrides (for integration testing)

    private let overrideEnvironment: [String: String]

    // MARK: - Init

    init(overrideEnvironment: [String: String] = [:]) {
        self.overrideEnvironment = overrideEnvironment
        (eventStream, eventContinuation) = AsyncStream<DaemonEvent>.makeStream()
    }

    // MARK: - Public interface

    func connect() async throws {
        guard !isConnected else { return }
        let (nodePath, daemonPath) = try resolvePaths()
        try spawnProcess(nodePath: nodePath, daemonPath: daemonPath)
        isConnected = true
        backoffSeconds = 1.0
        restartAttempt = 0
    }

    nonisolated func disconnect() {
        Task { await self.tearDown() }
    }

    private func tearDown() async {
        isConnected = false
        let proc = process

        // Close stdin — signals EOF to the daemon so it can exit cleanly.
        stdinHandle?.closeFile()
        stdinHandleBox.update(nil)
        stdinHandle = nil

        // Wait up to 5 seconds for the daemon to exit gracefully, then force-quit.
        if let proc, proc.isRunning {
            let exited = await pollUntilExited(proc, timeout: 5.0)
            if !exited {
                proc.terminate()
            }
        }
        process = nil
        failAllPending(with: DaemonError(code: "disconnected", message: "Daemon disconnected"))
    }

    /// Polls `process.isRunning` every 100 ms for up to `timeout` seconds.
    /// Returns `true` if the process exited within the timeout.
    private func pollUntilExited(_ proc: Process, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while proc.isRunning && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        return !proc.isRunning
    }

    // MARK: - Commands

    func hello() async throws -> HelloResult {
        let data = try await sendRequest(type: "hello")
        return try isoDecoder.decode(HelloResult.self, from: data)
    }

    func modelsList() async throws -> [ModelDescriptor] {
        let data = try await sendRequest(type: "models.list")
        return try isoDecoder.decode([ModelDescriptor].self, from: data)
    }

    func botsList() async throws -> [Bot] {
        let data = try await sendRequest(type: "bots.list")
        return try isoDecoder.decode([Bot].self, from: data)
    }

    func botsCreate(name: String, instructions: String, model: String?) async throws -> Bot {
        var params: [String: Any] = ["name": name, "instructions": instructions]
        if let model { params["model"] = model }
        let data = try await sendRequest(type: "bots.create", params: params)
        return try isoDecoder.decode(Bot.self, from: data)
    }

    func botsHistory(botID: String) async throws -> [Message] {
        let data = try await sendRequest(type: "bots.history", params: ["botId": botID])
        return try isoDecoder.decode([Message].self, from: data)
    }

    func botsSend(botID: String, text: String, clientMessageID: String) async throws -> Bool {
        let params: [String: Any] = [
            "botId": botID,
            "text": text,
            "clientMessageId": clientMessageID,
        ]
        let data = try await sendRequest(type: "bots.send", params: params)
        return try plainDecoder.decode(BotsSendResult.self, from: data).accepted
    }

    func botsStop(botID: String) async throws -> Bool {
        let data = try await sendRequest(type: "bots.stop", params: ["botId": botID])
        return try plainDecoder.decode(BotsStopResult.self, from: data).stopped
    }

    func authStatus() async throws -> AuthStatusResult {
        let data = try await sendRequest(type: "auth.status")
        return try plainDecoder.decode(AuthStatusResult.self, from: data)
    }

    func authLogin(providerID: String, loginType: String?) async throws -> String {
        var params: [String: Any] = ["providerId": providerID]
        if let loginType { params["loginType"] = loginType }
        let data = try await sendRequest(type: "auth.login", params: params)
        return try plainDecoder.decode(AuthLoginResult.self, from: data).loginID
    }

    func authRespond(loginID: String, promptID: String, value: String) async throws -> Bool {
        let params: [String: Any] = ["loginId": loginID, "promptId": promptID, "value": value]
        let data = try await sendRequest(type: "auth.respond", params: params)
        return try plainDecoder.decode(AuthRespondResult.self, from: data).accepted
    }

    func authCancel(loginID: String) async throws -> Bool {
        let data = try await sendRequest(type: "auth.cancel", params: ["loginId": loginID])
        return try plainDecoder.decode(AuthCancelResult.self, from: data).cancelled
    }

    func authSetAPIKey(providerID: String, apiKey: String) async throws -> Bool {
        let params: [String: Any] = ["providerId": providerID, "apiKey": apiKey]
        let data = try await sendRequest(type: "auth.setApiKey", params: params)
        return try plainDecoder.decode(AuthSetAPIKeyResult.self, from: data).stored
    }

    func authLogout(providerID: String) async throws -> Bool {
        let data = try await sendRequest(type: "auth.logout", params: ["providerId": providerID])
        return try plainDecoder.decode(AuthLogoutResult.self, from: data).loggedOut
    }

    func connectorsList() async throws -> [Connector] {
        let data = try await sendRequest(type: "connectors.list")
        return try plainDecoder.decode([Connector].self, from: data)
    }

    func connectorsSignIn(connectorID: String) async throws -> Bool {
        let data = try await sendRequest(type: "connectors.signIn", params: ["connectorId": connectorID])
        return try plainDecoder.decode(ConnectorsSignInResult.self, from: data).accepted
    }

    func connectorsSignOut(connectorID: String) async throws -> Bool {
        let data = try await sendRequest(type: "connectors.signOut", params: ["connectorId": connectorID])
        return try plainDecoder.decode(ConnectorsSignOutResult.self, from: data).signedOut
    }

    // MARK: - Private: process spawn

    private func spawnProcess(nodePath: String, daemonPath: String) throws {
        // Ignore SIGPIPE so a write to a dead pipe returns EPIPE rather than
        // raising SIGPIPE and killing the app.  signal(2) is idempotent.
        signal(SIGPIPE, SIG_IGN)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [daemonPath]

        // Merge override environment (used in tests for HYDRA_DATA_DIR, etc.)
        if !overrideEnvironment.isEmpty {
            var env = ProcessInfo.processInfo.environment
            for (key, value) in overrideEnvironment { env[key] = value }
            process.environment = env
        }

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Detect unexpected termination using terminationHandler instead of
        // `process.waitUntilExit()` (which would block a cooperative thread
        // for the daemon's entire lifetime).
        process.terminationHandler = { [weak self, nodePath, daemonPath] _ in
            Task { [weak self] in
                await self?.handleUnexpectedExit(nodePath: nodePath, daemonPath: daemonPath)
            }
        }

        // Attempt to start the process. On failure, close all pipes to prevent
        // file-descriptor leaks before re-throwing to the caller.
        do {
            try process.run()
        } catch {
            stdinPipe.fileHandleForWriting.closeFile()
            stdoutPipe.fileHandleForReading.closeFile()
            stderrPipe.fileHandleForReading.closeFile()
            throw error
        }

        // Publish handles only after process.run() succeeds so that any request
        // in flight during a failed spawn attempt throws immediately instead of
        // writing to a pipe whose read end has no reader.
        let handle = stdinPipe.fileHandleForWriting
        self.stdinHandle = handle
        stdinHandleBox.update(handle)
        self.process = process
        lineBuffer.reset()

        let sendableStdout = SendableFileHandle(handle: stdoutPipe.fileHandleForReading)
        let sendableStderr = SendableFileHandle(handle: stderrPipe.fileHandleForReading)
        let logURL = daemonLogFileURL()

        // Read stdout in chunks via readabilityHandler, dispatch to actor.
        Task { [weak self] in
            for await chunk in makeReadStream(handle: sendableStdout.handle) {
                await self?.receiveChunk(chunk)
            }
        }

        // Drain stderr in chunks so the pipe buffer never fills.
        Task {
            await drainStderr(handle: sendableStderr, logURL: logURL)
        }
    }

    // MARK: - Private: process exit

    private func handleUnexpectedExit(nodePath: String, daemonPath: String) async {
        guard isConnected else { return } // intentional disconnect → skip restart

        failAllPending(with: DaemonError(code: "daemon_exited", message: "Daemon exited unexpectedly"))

        // Clear the stdin handle immediately so that any new requests arriving during
        // the backoff sleep throw immediately with "not_connected" rather than writing
        // to a broken pipe.
        stdinHandle?.closeFile()
        stdinHandle = nil
        stdinHandleBox.update(nil)
        process = nil

        restartAttempt += 1
        let attempt = restartAttempt
        let delay = backoffSeconds
        backoffSeconds = min(backoffSeconds * 2, Self.maxBackoffSeconds)

        eventContinuation.yield(.connectionChanged(.restarting(attempt: attempt)))

        try? await Task.sleep(for: .seconds(delay))
        guard isConnected else { return }

        // Try to spawn; on failure retry with bounded backoff, then surface a terminal error.
        var spawnAttempts = 0
        let maxSpawnAttempts = 3
        var spawned = false
        while !spawned && spawnAttempts < maxSpawnAttempts {
            spawnAttempts += 1
            do {
                try spawnProcess(nodePath: nodePath, daemonPath: daemonPath)
                spawned = true
            } catch {
                if spawnAttempts < maxSpawnAttempts {
                    let spawnDelay = min(backoffSeconds * Double(spawnAttempts), Self.maxBackoffSeconds)
                    try? await Task.sleep(for: .seconds(spawnDelay))
                    guard isConnected else { return }
                }
            }
        }
        if spawned {
            // Emit reconnected event so AppFeature can re-run hello + bots.list.
            eventContinuation.yield(.connectionChanged(.reconnected))
        } else {
            // All spawn attempts exhausted — end the event stream so AppFeature surfaces
            // a terminal error via the daemonStreamEnded action.
            isConnected = false
            eventContinuation.finish()
        }
    }

    // MARK: - Private: incoming data dispatch (called from stdout reader task)

    func receiveChunk(_ data: Data) {
        let lines = lineBuffer.append(data)
        for lineData in lines {
            receiveLine(lineData)
        }
    }

    private func receiveLine(_ data: Data) {
        guard let envelope = try? plainDecoder.decode(MessageEnvelope.self, from: data) else {
            // Malformed JSON: skip silently (daemon logs detail to stderr)
            return
        }

        switch envelope.type {
        case "result":
            guard let id = envelope.id, let resultData = envelope.rawResult else { return }
            pendingRequests.removeValue(forKey: id)?.resume(returning: resultData)

        case "error":
            let payload = envelope.errorPayload ?? .init(code: "unknown", message: "Unknown error")
            let error = DaemonError(code: payload.code, message: payload.message)
            if let id = envelope.id {
                pendingRequests.removeValue(forKey: id)?.resume(throwing: error)
            }
            // id == nil (parse_error / bad_request): nothing to correlate

        case "event":
            guard let name = envelope.event else { return }
            if let event = parseEvent(name, data: data) {
                eventContinuation.yield(event)
            }

        default:
            break
        }
    }

    // MARK: - Private: request send

    private func sendRequest(type: String, params: [String: Any] = [:]) async throws -> Data {
        // Guard: no continuation may be left unresumed if stdin is absent.
        guard let stdinHandle else {
            throw DaemonError(code: "not_connected", message: "Daemon is not connected")
        }

        requestCounter += 1
        let id = "\(requestCounter)"

        var dict: [String: Any] = ["id": id, "type": type]
        for (key, value) in params { dict[key] = value }
        let line = (try JSONSerialization.data(withJSONObject: dict)) + Data([UInt8(ascii: "\n")])

        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[id] = continuation
            do {
                // write(contentsOf:) throws on EPIPE instead of raising an ObjC exception.
                try stdinHandle.write(contentsOf: line)
            } catch {
                // Write failed (e.g. broken pipe after daemon died). Remove and immediately
                // resume — no continuation may be left unresumed.
                pendingRequests.removeValue(forKey: id)?.resume(throwing:
                    DaemonError(code: "write_failed", message: "Failed to write to daemon stdin: \(error)"))
            }
        }
    }

    private func failAllPending(with error: Error) {
        for cont in pendingRequests.values { cont.resume(throwing: error) }
        pendingRequests.removeAll()
    }

    // MARK: - Private: path resolution

    private func resolvePaths() throws -> (nodePath: String, daemonPath: String) {
        let node = resolveNodePath()
        let daemon = resolveDaemonPath()

        guard FileManager.default.fileExists(atPath: node) else {
            throw DaemonError(
                code: "node_not_found",
                message: "Node not found at \(node). Set HYDRA_NODE or install Node via Homebrew."
            )
        }
        guard FileManager.default.fileExists(atPath: daemon) else {
            throw DaemonError(
                code: "daemon_not_built",
                message: "Daemon not found at \(daemon). Run `npm run build` in daemon/."
            )
        }
        return (node, daemon)
    }

    private func resolveNodePath() -> String {
        if let v = ProcessInfo.processInfo.environment["HYDRA_NODE"], !v.isEmpty { return v }
        if let v = UserDefaults.standard.string(forKey: "HYDRA_NODE"), !v.isEmpty { return v }
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { FileManager.default.fileExists(atPath: $0) } ?? candidates[0]
    }

    private func resolveDaemonPath() -> String {
        if let v = ProcessInfo.processInfo.environment["HYDRA_DAEMON"], !v.isEmpty { return v }
        // #filePath: …/hydra/Hydra/HydraPackage/Sources/DaemonClient/DaemonController.swift
        // 5 deletions: filename → DaemonClient/ → Sources/ → HydraPackage/ → Hydra/ → repo root
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // DaemonController.swift → DaemonClient/
            .deletingLastPathComponent() // DaemonClient/ → Sources/
            .deletingLastPathComponent() // Sources/ → HydraPackage/
            .deletingLastPathComponent() // HydraPackage/ → Hydra/
            .deletingLastPathComponent() // Hydra/ → repo root (hydra/)
        return repoRoot.appendingPathComponent("daemon/dist/daemon.mjs").path
    }

    private func daemonLogFileURL() -> URL {
        // When the HYDRA_DATA_DIR override is set (e.g. in integration tests),
        // write the log inside that directory so test runs do not pollute the
        // user's real ~/Library/Application Support/Hydra/logs/daemon.log.
        // The live app never sets the override, so it always uses Application Support.
        let logDir: URL
        if let dataDir = overrideEnvironment["HYDRA_DATA_DIR"] {
            logDir = URL(fileURLWithPath: dataDir).appendingPathComponent("logs")
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            logDir = base.appendingPathComponent("Hydra/logs")
        }
        try? FileManager.default.createDirectory(
            at: logDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        return logDir.appendingPathComponent("daemon.log")
    }

    // MARK: - Private: event parsing

    func parseEvent(_ name: String, data: Data) -> DaemonEvent? {
        do {
            switch name {
            case "bot.updated":
                let p = try isoDecoder.decode(BotUpdatedPayload.self, from: data)
                return .botUpdated(p.bot)
            case "message.started":
                let p = try plainDecoder.decode(MessageStartedPayload.self, from: data)
                return .messageStarted(botID: p.botID, messageID: p.messageID)
            case "message.delta":
                let p = try plainDecoder.decode(MessageDeltaPayload.self, from: data)
                return .messageDelta(botID: p.botID, messageID: p.messageID, text: p.text)
            case "message.completed":
                let p = try isoDecoder.decode(MessageCompletedPayload.self, from: data)
                return .messageCompleted(botID: p.botID, messageID: p.messageID, message: p.message)
            case "bot.activity":
                let p = try plainDecoder.decode(BotActivityPayload.self, from: data)
                return .botActivity(botID: p.botID, activity: p.activity)
            case "bot.error":
                let p = try plainDecoder.decode(BotErrorPayload.self, from: data)
                return .botError(botID: p.botID, code: p.code, message: p.message)
            case "auth.url":
                let p = try plainDecoder.decode(AuthURLPayload.self, from: data)
                return .authURL(loginID: p.loginID, url: p.url, instructions: p.instructions)
            case "auth.info":
                let p = try plainDecoder.decode(AuthInfoPayload.self, from: data)
                return .authInfo(loginID: p.loginID, message: p.message)
            case "auth.prompt":
                let p = try plainDecoder.decode(AuthPromptPayload.self, from: data)
                return .authPrompt(
                    loginID: p.loginID, promptID: p.promptID,
                    kind: p.kind, message: p.message, placeholder: p.placeholder,
                    options: p.options
                )
            case "auth.completed":
                let p = try plainDecoder.decode(AuthCompletedPayload.self, from: data)
                return .authCompleted(loginID: p.loginID, providerID: p.providerID)
            case "auth.failed":
                let p = try plainDecoder.decode(AuthFailedPayload.self, from: data)
                return .authFailed(loginID: p.loginID, message: p.message)
            case "connector.signInUrl":
                let p = try plainDecoder.decode(ConnectorSignInURLPayload.self, from: data)
                return .connectorSignInURL(connectorID: p.connectorID, url: p.url)
            case "connector.updated":
                let p = try plainDecoder.decode(ConnectorUpdatedPayload.self, from: data)
                return .connectorUpdated(p.connector)
            default:
                return .unknown(event: name)
            }
        } catch {
            return .unknown(event: name)
        }
    }

    // MARK: - Decoders

    private let plainDecoder = JSONDecoder()
    private let isoDecoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

// MARK: - Chunk-based stdout reader (free function; bridges readabilityHandler → AsyncStream)

/// Creates an `AsyncStream<Data>` that yields available chunks from `handle`
/// via `readabilityHandler`, reading all available bytes at once per notification.
private func makeReadStream(handle: FileHandle) -> AsyncStream<Data> {
    AsyncStream<Data> { continuation in
        handle.readabilityHandler = { h in
            let data = h.availableData
            if data.isEmpty {
                h.readabilityHandler = nil
                continuation.finish()
            } else {
                continuation.yield(data)
            }
        }
        continuation.onTermination = { _ in
            handle.readabilityHandler = nil
        }
    }
}

// MARK: - Stderr chunk drainer (free function)

/// Drains the daemon's stderr to a log file in chunks so the pipe buffer never
/// fills and never blocks the daemon process.
private func drainStderr(handle: DaemonController.SendableFileHandle, logURL: URL) async {
    if !FileManager.default.fileExists(atPath: logURL.path) {
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    guard let logHandle = try? FileHandle(forWritingTo: logURL) else { return }
    defer { logHandle.closeFile() }
    logHandle.seekToEndOfFile()
    for await chunk in makeReadStream(handle: handle.handle) {
        try? logHandle.write(contentsOf: chunk)
    }
}

// MARK: - Message envelope

private struct MessageEnvelope: Decodable {
    let id: String?
    let type: String
    let event: String?
    let rawResult: Data?
    let errorPayload: DaemonErrorPayload?

    private enum CodingKeys: String, CodingKey {
        case id, type, event, result, error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        type = try c.decode(String.self, forKey: .type)
        event = try c.decodeIfPresent(String.self, forKey: .event)
        errorPayload = try c.decodeIfPresent(DaemonErrorPayload.self, forKey: .error)
        if c.contains(.result) {
            let v = try c.decode(AnyJSONValue.self, forKey: .result)
            rawResult = try? JSONEncoder().encode(v)
        } else {
            rawResult = nil
        }
    }
}

private struct DaemonErrorPayload: Decodable {
    let code: String
    let message: String
}

// MARK: - AnyJSONValue (round-trip for partial result re-encoding)

private enum AnyJSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([AnyJSONValue])
    case object([String: AnyJSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil()                                   { self = .null }
        else if let v = try? c.decode(Bool.self)           { self = .bool(v) }
        else if let v = try? c.decode(Double.self)         { self = .number(v) }
        else if let v = try? c.decode(String.self)         { self = .string(v) }
        else if let v = try? c.decode([AnyJSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: AnyJSONValue].self) { self = .object(v) }
        else {
            throw DecodingError.typeMismatch(
                AnyJSONValue.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Unexpected JSON value")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        case .null:          try c.encodeNil()
        case .array(let v):  try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

// MARK: - Private result shapes

private struct BotsSendResult: Decodable      { let accepted: Bool }
private struct BotsStopResult: Decodable      { let stopped: Bool }
private struct AuthRespondResult: Decodable   { let accepted: Bool }
private struct AuthCancelResult: Decodable    { let cancelled: Bool }
private struct AuthSetAPIKeyResult: Decodable { let stored: Bool }
private struct AuthLogoutResult: Decodable    { let loggedOut: Bool }

private struct ConnectorsSignInResult: Decodable  { let accepted: Bool }
private struct ConnectorsSignOutResult: Decodable { let signedOut: Bool }

private struct AuthLoginResult: Decodable {
    let loginID: String
    enum CodingKeys: String, CodingKey { case loginID = "loginId" }
}

// MARK: - Event payload shapes

private struct BotUpdatedPayload: Decodable {
    let bot: Bot
}

private struct MessageStartedPayload: Decodable {
    let botID: String
    let messageID: String
    enum CodingKeys: String, CodingKey {
        case botID = "botId"; case messageID = "messageId"
    }
}

private struct MessageDeltaPayload: Decodable {
    let botID: String
    let messageID: String
    let text: String
    enum CodingKeys: String, CodingKey {
        case botID = "botId"; case messageID = "messageId"; case text
    }
}

private struct MessageCompletedPayload: Decodable {
    let botID: String
    let messageID: String
    let message: Message
    enum CodingKeys: String, CodingKey {
        case botID = "botId"; case messageID = "messageId"; case message
    }
}

private struct BotActivityPayload: Decodable {
    let botID: String
    let activity: BotActivity
    enum CodingKeys: String, CodingKey {
        case botID = "botId"; case activity; case tool; case label
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botID = try c.decode(String.self, forKey: .botID)
        switch try c.decode(String.self, forKey: .activity) {
        case "thinking": activity = .thinking
        case "tool":
            activity = .tool(
                name: try c.decode(String.self, forKey: .tool),
                label: try c.decode(String.self, forKey: .label)
            )
        default: activity = .idle
        }
    }
}

private struct BotErrorPayload: Decodable {
    let botID: String; let code: String; let message: String
    enum CodingKeys: String, CodingKey { case botID = "botId"; case code; case message }
}

private struct AuthURLPayload: Decodable {
    let loginID: String; let url: String; let instructions: String?
    enum CodingKeys: String, CodingKey { case loginID = "loginId"; case url; case instructions }
}

private struct AuthInfoPayload: Decodable {
    let loginID: String; let message: String
    enum CodingKeys: String, CodingKey { case loginID = "loginId"; case message }
}

private struct AuthPromptPayload: Decodable {
    let loginID: String; let promptID: String; let kind: String
    let message: String; let placeholder: String?
    let options: [AuthPromptOption]?
    enum CodingKeys: String, CodingKey {
        case loginID = "loginId"; case promptID = "promptId"
        case kind; case message; case placeholder; case options
    }
}

private struct AuthCompletedPayload: Decodable {
    let loginID: String; let providerID: String
    enum CodingKeys: String, CodingKey { case loginID = "loginId"; case providerID = "providerId" }
}

private struct AuthFailedPayload: Decodable {
    let loginID: String; let message: String
    enum CodingKeys: String, CodingKey { case loginID = "loginId"; case message }
}

private struct ConnectorSignInURLPayload: Decodable {
    let connectorID: String; let url: String
    enum CodingKeys: String, CodingKey { case connectorID = "connectorId"; case url }
}

private struct ConnectorUpdatedPayload: Decodable {
    let connector: Connector
}
