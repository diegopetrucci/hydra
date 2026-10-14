@testable import DaemonClient
import Foundation
import Testing

// MARK: - DaemonEventLog

/// Thread-safe accumulator for DaemonEvents, used by integration tests that
/// need to wait for specific events without racing against event delivery.
private final class DaemonEventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [DaemonEvent] = []

    func append(_ event: DaemonEvent) {
        lock.withLock { events.append(event) }
    }

    /// Polls every 50 ms until `predicate` matches a collected event or `timeout` elapses.
    /// Returns the first matching event, or `nil` on timeout.
    func waitForFirst(
        timeout: Duration,
        matching predicate: @Sendable (DaemonEvent) -> Bool
    ) async throws -> DaemonEvent? {
        let deadline = ContinuousClock().now.advanced(by: timeout)
        while ContinuousClock().now < deadline {
            if let match = lock.withLock({ events.first(where: predicate) }) { return match }
            try await Task.sleep(for: .milliseconds(50))
        }
        return nil
    }
}

// MARK: - DaemonClientTests

@Suite("DaemonClient")
struct DaemonClientTests {

    // MARK: - LineBuffer framing

    @Suite("LineBuffer framing")
    struct LineBufferTests {

        @Test("partial line yields nothing until newline")
        func partialLine() {
            var buffer = LineBuffer()
            let lines = buffer.append(Data(#"{"id":"1","type":"hell"#.utf8))
            #expect(lines.isEmpty)
        }

        @Test("completing a partial line yields one line")
        func completingPartialLine() {
            var buffer = LineBuffer()
            _ = buffer.append(Data(#"{"id":"1","type":"hell"#.utf8))
            let lines = buffer.append(Data("o\"}\n".utf8))
            #expect(lines.count == 1)
            #expect(lines[0] == Data(#"{"id":"1","type":"hello"}"#.utf8))
        }

        @Test("several lines in one chunk are all returned")
        func severalLinesInOneChunk() {
            var buffer = LineBuffer()
            let lines = buffer.append(Data("line1\nline2\nline3\n".utf8))
            #expect(lines.count == 3)
            #expect(lines[0] == Data("line1".utf8))
            #expect(lines[1] == Data("line2".utf8))
            #expect(lines[2] == Data("line3".utf8))
        }

        @Test("empty lines are discarded")
        func emptyLinesDiscarded() {
            var buffer = LineBuffer()
            let lines = buffer.append(Data("\n\nline\n\n".utf8))
            #expect(lines.count == 1)
            #expect(lines[0] == Data("line".utf8))
        }

        @Test("large line spread across many chunks")
        func largeLineAcrossChunks() {
            var buffer = LineBuffer()
            let json = String(repeating: "x", count: 4096) + "\n"
            var allLines: [Data] = []
            for byte in json.utf8 {
                allLines += buffer.append(Data([byte]))
            }
            #expect(allLines.count == 1)
            #expect(allLines[0].count == 4096)
        }

        @Test("malformed JSON does not crash — buffer still yields the line")
        func malformedJSON() {
            var buffer = LineBuffer()
            let lines = buffer.append(Data("not-json\n".utf8))
            #expect(lines.count == 1)
            #expect(lines[0] == Data("not-json".utf8))
        }

        @Test("reset discards partial line")
        func resetDiscardsPartialLine() {
            var buffer = LineBuffer()
            _ = buffer.append(Data("partial".utf8))
            buffer.reset()
            let lines = buffer.append(Data("fresh\n".utf8))
            #expect(lines.count == 1)
            #expect(lines[0] == Data("fresh".utf8))
        }
    }

    // MARK: - Protocol model decoding

    @Suite("Model decoding")
    struct ModelDecodingTests {

        private let isoDecoder: JSONDecoder = {
            let d = JSONDecoder()
            d.dateDecodingStrategy = .iso8601
            return d
        }()

        @Test("decodes Bot with all fields populated")
        func decodesBotFull() throws {
            let json = """
            {
              "id": "42",
              "name": "My Bot",
              "instructions": "Be concise.",
              "model": "anthropic/claude-sonnet-5-5",
              "createdAt": "2025-01-01T00:00:00.000Z",
              "lastMessagePreview": "Hello!",
              "lastMessageAt": "2025-01-02T00:00:00.000Z"
            }
            """.data(using: .utf8)!
            let bot = try isoDecoder.decode(Bot.self, from: json)
            #expect(bot.id == "42")
            #expect(bot.name == "My Bot")
            #expect(bot.lastMessagePreview == "Hello!")
            #expect(bot.lastMessageAt != nil)
        }

        @Test("decodes fresh Bot with empty-string lastMessageAt and lastMessagePreview as nil")
        func decodesBotEmptyDates() throws {
            // The daemon sends "" for bots.create / bots.list on a brand-new bot.
            let json = """
            {
              "id": "1",
              "name": "New Bot",
              "instructions": "",
              "model": "anthropic/claude-sonnet-5-5",
              "createdAt": "2025-01-01T00:00:00.000Z",
              "lastMessagePreview": "",
              "lastMessageAt": ""
            }
            """.data(using: .utf8)!
            // Must not throw even though "" is not a valid ISO 8601 date.
            let bot = try isoDecoder.decode(Bot.self, from: json)
            #expect(bot.lastMessagePreview == nil, "empty string should decode as nil")
            #expect(bot.lastMessageAt == nil, "empty string should decode as nil")
        }

        @Test("decodes Bot without optional fields (fields absent)")
        func decodesBotNoOptionals() throws {
            let json = """
            {
              "id": "1",
              "name": "Plain Bot",
              "instructions": "",
              "model": "anthropic/claude-sonnet-5-5",
              "createdAt": "2025-01-01T00:00:00.000Z"
            }
            """.data(using: .utf8)!
            let bot = try isoDecoder.decode(Bot.self, from: json)
            #expect(bot.lastMessagePreview == nil)
            #expect(bot.lastMessageAt == nil)
        }

        @Test("decodes HelloResult")
        func decodesHelloResult() throws {
            let json = """
            {
              "protocolVersion": "1",
              "daemonVersion": "0.1.0",
              "tools": ["web_search", "fetch_content", "get_search_content"]
            }
            """.data(using: .utf8)!
            let result = try isoDecoder.decode(HelloResult.self, from: json)
            #expect(result.protocolVersion == "1")
            #expect(result.tools.count == 3)
        }

        @Test("decodes ModelDescriptor with modelId CodingKey")
        func decodesModelDescriptor() throws {
            let json = """
            {
              "provider": "anthropic",
              "modelId": "claude-sonnet-5-5",
              "name": "Claude Sonnet 5.5",
              "default": true
            }
            """.data(using: .utf8)!
            let desc = try isoDecoder.decode(ModelDescriptor.self, from: json)
            #expect(desc.modelID == "claude-sonnet-5-5")
            #expect(desc.default == true)
        }

        @Test("decodes ProviderStatus with providerId CodingKey")
        func decodesProviderStatus() throws {
            let json = """
            { "providerId": "anthropic", "type": "api_key", "source": "stored" }
            """.data(using: .utf8)!
            let status = try isoDecoder.decode(ProviderStatus.self, from: json)
            #expect(status.providerID == "anthropic")
            #expect(status.type == "api_key")
        }
    }

    // MARK: - Connector decoding

    @Suite("Connector decoding")
    struct ConnectorDecodingTests {

        @Test("decodes connectors.list entries including error and every status")
        func decodesList() throws {
            let json = """
            [
              { "id": "sentry", "name": "Sentry", "status": "connected" },
              { "id": "notion", "name": "Notion", "status": "signed_out", "error": "Sign-in timed out. Try again." },
              { "id": "a", "name": "A", "status": "connecting" },
              { "id": "b", "name": "B", "status": "needs_sign_in" },
              { "id": "c", "name": "C", "status": "error", "error": "Offline" }
            ]
            """.data(using: .utf8)!
            let list = try JSONDecoder().decode([Connector].self, from: json)
            #expect(list.map(\.status) == [.connected, .signedOut, .connecting, .needsSignIn, .error])
            #expect(list[0].error == nil)
            #expect(list[1].error == "Sign-in timed out. Try again.")
        }

        @Test("parses connector.signInUrl and connector.updated events")
        func parsesEvents() async {
            let controller = DaemonController()
            let urlLine = #"{"type":"event","event":"connector.signInUrl","connectorId":"sentry","url":"https://mcp.sentry.dev/a"}"#
            let urlEvent = await controller.parseEvent("connector.signInUrl", data: Data(urlLine.utf8))
            #expect(urlEvent == .connectorSignInURL(connectorID: "sentry", url: "https://mcp.sentry.dev/a"))

            let updLine = #"{"type":"event","event":"connector.updated","connector":{"id":"sentry","name":"Sentry","status":"needs_sign_in"}}"#
            let updEvent = await controller.parseEvent("connector.updated", data: Data(updLine.utf8))
            #expect(updEvent == .connectorUpdated(Connector(id: "sentry", name: "Sentry", status: .needsSignIn)))
        }

        @Test("malformed connector events degrade to unknown")
        func malformedEvent() async {
            let controller = DaemonController()
            let event = await controller.parseEvent("connector.updated", data: Data(#"{"connector":{"id":"x"}}"#.utf8))
            #expect(event == .unknown(event: "connector.updated"))
        }

        @Test("connector requests while disconnected throw")
        func requestsWhileDisconnectedThrow() async {
            let controller = DaemonController()
            await #expect(throws: DaemonError.self) { _ = try await controller.connectorsList() }
            await #expect(throws: DaemonError.self) { _ = try await controller.connectorsSignIn(connectorID: "sentry") }
            await #expect(throws: DaemonError.self) { _ = try await controller.connectorsSignOut(connectorID: "sentry") }
        }
    }

    // MARK: - Write safety

    @Suite("Write safety")
    struct WriteSafetyTests {

        @Test("sendRequest while disconnected throws immediately (no unresumed continuation)")
        func requestWhileDisconnectedThrows() async throws {
            // A controller that was never connected has no stdinHandle.
            let controller = DaemonController()
            await #expect(throws: DaemonError.self) {
                _ = try await controller.hello()
            }
        }

        /// Gap (6): after a process crash the handle is cleared before the backoff sleep,
        /// so new requests throw immediately rather than writing to a broken pipe.
        /// A fresh controller (no stdinHandle) is the observable equivalent of the
        /// post-crash state, since both have stdinHandle == nil.
        @Test("sendRequest during backoff (nil handle) throws not_connected immediately")
        func requestDuringBackoffThrows() async throws {
            let controller = DaemonController()
            // Sequential throws: each request fails without leaving an unresumed continuation.
            do {
                _ = try await controller.hello()
                Issue.record("Expected hello to throw while disconnected")
            } catch is DaemonError {
                // expected
            }
            do {
                _ = try await controller.botsList()
                Issue.record("Expected botsList to throw while disconnected")
            } catch is DaemonError {
                // expected
            }
        }
    }

    // MARK: - End-to-end integration (opt-in: requires built daemon)

    @Suite("Integration")
    struct IntegrationTests {

        @Test(
            "connect → hello → bots.create → bots.list → auth.status → disconnect",
            .enabled(if: isIntegrationEnabled())
        )
        func endToEnd() async throws {
            let tmpDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("HydraIntegrationTest-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tmpDir) }

            let controller = DaemonController(overrideEnvironment: [
                "HYDRA_DATA_DIR": tmpDir.path,
            ])
            defer { controller.disconnect() }

            // Connect
            try await controller.connect()

            // hello — verify tools list matches PROTOCOL.md
            let hello = try await controller.hello()
            #expect(hello.protocolVersion == "1")
            #expect(hello.tools.contains("web_search"))
            #expect(hello.tools.contains("fetch_content"))
            #expect(hello.tools.contains("get_search_content"))

            // bots.create — new bot has empty lastMessageAt/Preview (bug 2 regression check)
            let created = try await controller.botsCreate(
                name: "Integration Test Bot",
                instructions: "Say hi.",
                model: nil
            )
            #expect(created.name == "Integration Test Bot")
            #expect(created.lastMessageAt == nil, "fresh bot should have nil lastMessageAt")
            #expect(created.lastMessagePreview == nil, "fresh bot should have nil lastMessagePreview")

            // bots.list — must contain the newly created bot
            let bots = try await controller.botsList()
            #expect(bots.contains(where: { $0.id == created.id }), "bots.list must include new bot")

            // auth.status — just verify it decodes without throwing
            let authStatus = try await controller.authStatus()
            _ = authStatus // suppress unused warning

            // Graceful disconnect — give daemon a moment to exit
            controller.disconnect()
            try await Task.sleep(for: .milliseconds(300))
        }

        /// Gap (7): forces out-of-order delivery by creating a bot first (so bots.list has data
        /// to return), then sending hello and bots.list concurrently. Correct ID-based correlation
        /// is proven by asserting response-specific fields: if hello's response were routed to
        /// botsList or vice versa, the decoders would throw or produce wrong field values.
        @Test(
            "concurrent requests — ID-based correlation routes each response correctly",
            .enabled(if: isIntegrationEnabled())
        )
        func concurrentOutOfOrderResponses() async throws {
            let tmpDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("HydraIntegrationConcurrent-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tmpDir) }

            let controller = DaemonController(overrideEnvironment: [
                "HYDRA_DATA_DIR": tmpDir.path,
            ])
            defer { controller.disconnect() }
            try await controller.connect()

            // Pre-create a bot so bots.list returns a non-empty array.  This ensures the
            // response payloads are structurally different (HelloResult vs [Bot]) and
            // a misrouted response would produce a decoding error.
            let created = try await controller.botsCreate(
                name: "Correlation Test Bot",
                instructions: "Test.",
                model: nil
            )

            // Send hello and bots.list concurrently.  The daemon may respond in any order;
            // the request-ID correlation in DaemonController must route each response to
            // the correct continuation regardless.
            async let helloFuture = controller.hello()
            async let botsFuture = controller.botsList()
            let (hello, bots) = try await (helloFuture, botsFuture)

            // hello response must have decoded as HelloResult (wrong routing would throw
            // or produce a zero-value protocolVersion).
            #expect(hello.protocolVersion == "1",
                    "hello response must be routed to the hello continuation")
            #expect(hello.tools.contains("web_search"),
                    "hello response must carry the tools array")

            // bots.list response must have decoded as [Bot] and contain the pre-created bot.
            #expect(bots.contains(where: { $0.id == created.id }),
                    "bots.list response must be routed to the botsList continuation")

            controller.disconnect()
            try await Task.sleep(for: .milliseconds(200))
        }

        /// Regression test for the bundled OAuth loader (nb-jysh).
        ///
        /// Verifies that the built daemon (dist/daemon.mjs) emits an auth.prompt
        /// event with kind "select" immediately after auth.login (before any network
        /// call), then emits auth.failed "Login cancelled" after auth.cancel.
        ///
        /// The test never answers the select prompt and never touches the network.
        @Test(
            "oauth login → select prompt → cancel → auth.failed (bundled OAuth loader regression)",
            .enabled(if: isIntegrationEnabled())
        )
        func oauthLoginSelectPromptThenCancel() async throws {
            let tmpDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("HydraOAuthTest-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tmpDir) }

            let controller = DaemonController(overrideEnvironment: [
                "HYDRA_DATA_DIR": tmpDir.path,
            ])
            defer { controller.disconnect() }
            try await controller.connect()

            // Drain the event stream into a thread-safe log using a persistent
            // background task. This is the sole consumer of controller.eventStream;
            // the test reads from the log without iterating the stream directly.
            let log = DaemonEventLog()
            let collectTask = Task {
                for await event in controller.eventStream {
                    log.append(event)
                }
            }
            defer { collectTask.cancel() }

            // Initiate OAuth login. The daemon emits auth.prompt(kind:"select")
            // before starting any network call or callback server, so this test
            // is entirely offline regardless of environment.
            let loginID = try await controller.authLogin(providerID: "anthropic", loginType: "oauth")

            // Wait up to 10 s for the select prompt.
            let selectEvent = try await log.waitForFirst(timeout: .seconds(10)) {
                if case .authPrompt(_, _, let kind, _, _, _) = $0, kind == "select" { return true }
                return false
            }
            guard let selectEvent else {
                Issue.record("Timed out waiting for auth.prompt(kind:select) — OAuth loader may not be registered in the bundle")
                return
            }
            guard case .authPrompt(let promptLoginID, _, "select", _, _, let options) = selectEvent else {
                Issue.record("Expected authPrompt(select) but got: \(selectEvent)")
                return
            }
            #expect(promptLoginID == loginID)
            let optionIDs = (options ?? []).map(\.id)
            #expect(optionIDs.contains("browser"),
                    "Expected 'browser' option in select prompt; got \(optionIDs)")
            #expect(optionIDs.contains("copy_code"),
                    "Expected 'copy_code' option in select prompt; got \(optionIDs)")

            // Cancel the login — no prompt was answered, no network was used.
            _ = try await controller.authCancel(loginID: loginID)

            // Wait up to 5 s for auth.failed "Login cancelled".
            let failedEvent = try await log.waitForFirst(timeout: .seconds(5)) {
                if case .authFailed = $0 { return true }
                return false
            }
            guard let failedEvent,
                  case .authFailed(let failedLoginID, let message) = failedEvent else {
                Issue.record("Timed out waiting for auth.failed after authCancel")
                return
            }
            #expect(failedLoginID == loginID)
            #expect(message == "Login cancelled")

            controller.disconnect()
            try await Task.sleep(for: .milliseconds(300))
        }

        /// Returns `true` only when both node and the built daemon script exist.
        private static func isIntegrationEnabled() -> Bool {
            let nodeExists = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
                .contains { FileManager.default.fileExists(atPath: $0) }
            // #filePath: …/hydra/Hydra/HydraPackage/Tests/DaemonClientTests/DaemonClientTests.swift
            let daemonPath = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent() // DaemonClientTests/ (dir)
                .deletingLastPathComponent() // Tests/
                .deletingLastPathComponent() // HydraPackage/
                .deletingLastPathComponent() // Hydra/
                .deletingLastPathComponent() // repo root (hydra/)
                .appendingPathComponent("daemon/dist/daemon.mjs")
                .path
            return nodeExists && FileManager.default.fileExists(atPath: daemonPath)
        }
    }
}
