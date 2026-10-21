@testable import DaemonClient
import Foundation
import Testing

private actor LifecycleLog {
    var events: [DaemonEvent] = []
    var finished = false

    func append(_ event: DaemonEvent) { events.append(event) }
    func finish() { finished = true }
}

@Suite("Daemon process lifecycle")
struct DaemonLifecycleTests {
    /// Runs a local shell fixture through the same process lifecycle as Node.
    private func makeFixture(exitCode: Int) throws -> (DaemonController, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("HydraLifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let script = directory.appendingPathComponent("daemon.sh")
        try """
        printf 'launch\\n' >> "$HYDRA_DATA_DIR/launches"
        if [ "$(wc -l < "$HYDRA_DATA_DIR/launches")" -eq 1 ]; then
          exit \(exitCode)
        fi
        while read -r line; do :; done
        """.write(to: script, atomically: true, encoding: .utf8)
        return (
            DaemonController(overrideEnvironment: [
                "HYDRA_NODE": "/bin/sh",
                "HYDRA_DAEMON": script.path,
                "HYDRA_DATA_DIR": directory.path,
            ]),
            directory
        )
    }

    private func waitUntil(_ condition: @Sendable () async -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while !(await condition()) && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(await condition())
    }

    @Test("unsupported runtime ends the stream without retry and keeps its actionable error")
    func unsupportedRuntimeDoesNotRestart() async throws {
        let (controller, directory) = try makeFixture(exitCode: 78)
        defer {
            controller.disconnect()
            try? FileManager.default.removeItem(at: directory)
        }
        let log = LifecycleLog()
        let recording = Task {
            for await event in controller.eventStream { await log.append(event) }
            await log.finish()
        }
        defer { recording.cancel() }

        try await controller.connect()
        try await waitUntil { await log.finished }
        let events = await log.events
        guard case .connectionChanged(.failed(let message)) = events.first else {
            Issue.record("Expected a terminal runtime failure, got \(events)")
            return
        }
        #expect(events.count == 1)
        #expect(message.contains("HYDRA_NODE"))
        #expect(message.contains("patched Node.js"))
        // Also cover a request arriving after termination, rather than pending at exit.
        do {
            _ = try await controller.hello()
            Issue.record("Expected the permanent startup error")
        } catch {
            #expect((error as? DaemonError)?.code == "unsupported_node")
            #expect(error.localizedDescription == message)
        }
        do {
            try await controller.connect()
            Issue.record("Expected reconnect to retain the permanent startup error")
        } catch {
            #expect((error as? DaemonError)?.code == "unsupported_node")
        }
        try await Task.sleep(for: .milliseconds(1200))
        let launches = try String(contentsOf: directory.appendingPathComponent("launches"), encoding: .utf8)
        #expect(launches == "launch\n")
    }

    @Test("ordinary process failures still restart and reconnect")
    func ordinaryFailureRestarts() async throws {
        let (controller, directory) = try makeFixture(exitCode: 1)
        defer {
            controller.disconnect()
            try? FileManager.default.removeItem(at: directory)
        }
        let log = LifecycleLog()
        let recording = Task {
            for await event in controller.eventStream { await log.append(event) }
        }
        defer { recording.cancel() }

        try await controller.connect()
        try await waitUntil { await log.events.contains(.connectionChanged(.reconnected)) }
        try await waitUntil {
            (try? String(contentsOf: directory.appendingPathComponent("launches"), encoding: .utf8))
                == "launch\nlaunch\n"
        }
        #expect(await log.events == [
            .connectionChanged(.restarting(attempt: 1)),
            .connectionChanged(.reconnected),
        ])
        let launches = try String(contentsOf: directory.appendingPathComponent("launches"), encoding: .utf8)
        #expect(launches == "launch\nlaunch\n")
    }
}
