import Dependencies
import DependenciesMacros
import Foundation

// MARK: - DaemonClient

/// A client that communicates with the Hydra daemon process over JSON-lines stdio.
///
/// The live value spawns the daemon process on `connect()`, writes JSON-lines to its
/// stdin, correlates stdout lines to pending requests by `id`, and surfaces
/// unsolicited events through the `events()` stream.
@DependencyClient
public struct DaemonClient: Sendable {
    // MARK: Lifecycle

    /// Starts the daemon process and establishes the stdio connection.
    /// Must be called before any other method.
    public var connect: @Sendable () async throws -> Void

    /// Closes the daemon's stdin gracefully (async; waits up to 5 s then terminates).
    public var disconnect: @Sendable () -> Void

    /// Closes stdin synchronously. Safe to call from any thread, e.g.
    /// `applicationWillTerminate`.  Does not wait for the process to exit.
    public var syncClose: @Sendable () -> Void = {}

    // MARK: Events

    /// Returns the async stream of unsolicited events from the daemon.
    /// The stream is ready once `connect()` completes.
    public var events: @Sendable () -> AsyncStream<DaemonEvent> = { .never }

    // MARK: Commands

    public var hello: @Sendable () async throws -> HelloResult
    public var modelsList: @Sendable () async throws -> [ModelDescriptor]
    public var botsList: @Sendable () async throws -> [Bot]
    public var botsCreate: @Sendable (_ name: String, _ instructions: String, _ model: String?) async throws -> Bot
    public var botsHistory: @Sendable (_ botID: String) async throws -> [Message]
    public var botsSend: @Sendable (_ botID: String, _ text: String, _ clientMessageID: String) async throws -> Bool
    public var botsStop: @Sendable (_ botID: String) async throws -> Bool
    public var authStatus: @Sendable () async throws -> AuthStatusResult
    public var authLogin: @Sendable (_ providerID: String, _ loginType: String?) async throws -> String
    public var authRespond: @Sendable (_ loginID: String, _ promptID: String, _ value: String) async throws -> Bool
    public var authCancel: @Sendable (_ loginID: String) async throws -> Bool
    public var authSetAPIKey: @Sendable (_ providerID: String, _ apiKey: String) async throws -> Bool
    public var authLogout: @Sendable (_ providerID: String) async throws -> Bool
    public var connectorsList: @Sendable () async throws -> [Connector]
    public var connectorsSignIn: @Sendable (_ connectorID: String) async throws -> Bool
    public var connectorsSignOut: @Sendable (_ connectorID: String) async throws -> Bool
}

// MARK: - DependencyKey

extension DaemonClient: DependencyKey {
    public static var liveValue: Self {
        let controller = DaemonController()
        return DaemonClient(
            connect: { try await controller.connect() },
            disconnect: { controller.disconnect() },
            syncClose: { controller.stdinHandleBox.closeAndClear() },
            events: { controller.eventStream },
            hello: { try await controller.hello() },
            modelsList: { try await controller.modelsList() },
            botsList: { try await controller.botsList() },
            botsCreate: { name, instructions, model in
                try await controller.botsCreate(name: name, instructions: instructions, model: model)
            },
            botsHistory: { botID in try await controller.botsHistory(botID: botID) },
            botsSend: { botID, text, clientMessageID in
                try await controller.botsSend(botID: botID, text: text, clientMessageID: clientMessageID)
            },
            botsStop: { botID in try await controller.botsStop(botID: botID) },
            authStatus: { try await controller.authStatus() },
            authLogin: { providerID, loginType in
                try await controller.authLogin(providerID: providerID, loginType: loginType)
            },
            authRespond: { loginID, promptID, value in
                try await controller.authRespond(loginID: loginID, promptID: promptID, value: value)
            },
            authCancel: { loginID in try await controller.authCancel(loginID: loginID) },
            authSetAPIKey: { providerID, apiKey in
                try await controller.authSetAPIKey(providerID: providerID, apiKey: apiKey)
            },
            authLogout: { providerID in try await controller.authLogout(providerID: providerID) },
            connectorsList: { try await controller.connectorsList() },
            connectorsSignIn: { connectorID in try await controller.connectorsSignIn(connectorID: connectorID) },
            connectorsSignOut: { connectorID in try await controller.connectorsSignOut(connectorID: connectorID) }
        )
    }

    public static var testValue: Self { Self() }

    public static var previewValue: Self {
        var client = Self()
        client.connect = {}
        client.syncClose = {}
        client.events = { AsyncStream { _ in } }
        client.hello = {
            HelloResult(protocolVersion: "1", daemonVersion: "0.1.0", tools: ["web_search"])
        }
        client.botsList = {
            [
                Bot(
                    id: "1",
                    name: "Preview Bot",
                    instructions: "Be helpful.",
                    model: "anthropic/claude-sonnet-5-5",
                    createdAt: Date(timeIntervalSince1970: 1_700_000_000)
                ),
            ]
        }
        return client
    }
}

// MARK: - DependencyValues

extension DependencyValues {
    public var daemonClient: DaemonClient {
        get { self[DaemonClient.self] }
        set { self[DaemonClient.self] = newValue }
    }
}
