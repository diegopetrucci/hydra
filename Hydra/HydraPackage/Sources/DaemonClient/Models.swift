import Foundation

// MARK: - Bot

public struct Bot: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let instructions: String
    public let model: String
    public let createdAt: Date
    /// `nil` when the bot has no messages yet (daemon sends `""` for a fresh bot).
    public let lastMessagePreview: String?
    /// `nil` when the bot has no messages yet (daemon sends `""` for a fresh bot).
    public let lastMessageAt: Date?

    public init(
        id: String,
        name: String,
        instructions: String,
        model: String,
        createdAt: Date,
        lastMessagePreview: String? = nil,
        lastMessageAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.instructions = instructions
        self.model = model
        self.createdAt = createdAt
        self.lastMessagePreview = lastMessagePreview
        self.lastMessageAt = lastMessageAt
    }
}

/// Custom `Codable` that maps empty-string `lastMessageAt` / `lastMessagePreview`
/// (emitted by the daemon for brand-new bots) to `nil`.
extension Bot: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        instructions = try c.decode(String.self, forKey: .instructions)
        model = try c.decode(String.self, forKey: .model)
        createdAt = try c.decode(Date.self, forKey: .createdAt)

        // The daemon sends `""` for bots without any messages; treat that as nil.
        let preview = try c.decodeIfPresent(String.self, forKey: .lastMessagePreview)
        lastMessagePreview = (preview?.isEmpty == false) ? preview : nil

        // `lastMessageAt` is `""` for fresh bots; ISO 8601 decoding would fail on "".
        // Try with fractional-seconds first (common from JS Date.toISOString()), then plain.
        let atString = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        if let atString, !atString.isEmpty {
            guard let date = Bot.parseISO8601(atString) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .lastMessageAt,
                    in: c,
                    debugDescription: "Invalid ISO 8601 date: \(atString)"
                )
            }
            lastMessageAt = date
        } else {
            lastMessageAt = nil
        }
    }

    /// Parses an ISO 8601 date string, trying fractional-seconds and plain variants.
    private static func parseISO8601(_ string: String) -> Date? {
        let fmtFractional = ISO8601DateFormatter()
        fmtFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fmtFractional.date(from: string) { return date }
        let fmtPlain = ISO8601DateFormatter()
        fmtPlain.formatOptions = [.withInternetDateTime]
        return fmtPlain.date(from: string)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(instructions, forKey: .instructions)
        try c.encode(model, forKey: .model)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(lastMessagePreview, forKey: .lastMessagePreview)
        if let lastMessageAt {
            try c.encode(ISO8601DateFormatter().string(from: lastMessageAt), forKey: .lastMessageAt)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, instructions, model, createdAt
        case lastMessagePreview, lastMessageAt
    }
}

// MARK: - Message

public struct Message: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let createdAt: Date

    public init(id: String, role: String, text: String, createdAt: Date) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
    }
}

// MARK: - HelloResult

public struct HelloResult: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let daemonVersion: String
    public let tools: [String]

    public init(protocolVersion: String, daemonVersion: String, tools: [String]) {
        self.protocolVersion = protocolVersion
        self.daemonVersion = daemonVersion
        self.tools = tools
    }
}

// MARK: - ModelDescriptor

public struct ModelDescriptor: Codable, Equatable, Sendable {
    public let provider: String
    public let modelID: String
    public let name: String
    public let `default`: Bool

    public init(provider: String, modelID: String, name: String, default isDefault: Bool) {
        self.provider = provider
        self.modelID = modelID
        self.name = name
        self.default = isDefault
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case modelID = "modelId"
        case name
        case `default`
    }
}

// MARK: - AuthStatusResult

public struct AuthStatusResult: Codable, Equatable, Sendable {
    public let providers: [ProviderStatus]

    public init(providers: [ProviderStatus]) {
        self.providers = providers
    }
}

public struct ProviderStatus: Codable, Equatable, Sendable {
    public let providerID: String
    public let type: String?
    public let source: String?

    public init(providerID: String, type: String?, source: String?) {
        self.providerID = providerID
        self.type = type
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case providerID = "providerId"
        case type
        case source
    }
}

// MARK: - Connector

public enum ConnectorStatus: String, Codable, Equatable, Sendable {
    case signedOut = "signed_out"
    case connecting
    case connected
    case needsSignIn = "needs_sign_in"
    case error
}

/// An MCP connector as returned by `connectors.list` and `connector.updated`.
public struct Connector: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let status: ConnectorStatus
    /// Short user-facing text; present for `error` and after a failed sign-in.
    public let error: String?

    public init(id: String, name: String, status: ConnectorStatus, error: String? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.error = error
    }
}

// MARK: - BotActivity

public enum BotActivity: Equatable, Sendable {
    case thinking
    case tool(name: String, label: String)
    case idle
}

// MARK: - ConnectionStatus

/// Emitted by DaemonController when the daemon exits unexpectedly and the
/// controller attempts to restart it.
public enum ConnectionStatus: Equatable, Sendable {
    /// The daemon exited and a restart is in progress. `attempt` starts at 1.
    case restarting(attempt: Int)
    /// The daemon has been successfully restarted and is ready for requests.
    case reconnected
}

// MARK: - AuthPromptOption

/// One selectable option in an `auth.prompt` event of kind `"select"`.
public struct AuthPromptOption: Equatable, Codable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let description: String?

    public init(id: String, label: String, description: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
    }
}

// MARK: - DaemonEvent

public enum DaemonEvent: Equatable, Sendable {
    case botUpdated(Bot)
    case messageStarted(botID: String, messageID: String)
    case messageDelta(botID: String, messageID: String, text: String)
    case messageCompleted(botID: String, messageID: String, message: Message)
    case botActivity(botID: String, activity: BotActivity)
    case botError(botID: String, code: String, message: String)
    case authURL(loginID: String, url: String, instructions: String?)
    case authInfo(loginID: String, message: String)
    case authPrompt(loginID: String, promptID: String, kind: String, message: String, placeholder: String?, options: [AuthPromptOption]?)
    case authCompleted(loginID: String, providerID: String)
    case authFailed(loginID: String, message: String)
    case connectorSignInURL(connectorID: String, url: String)
    case connectorUpdated(Connector)
    /// Lifecycle events emitted when the daemon exits unexpectedly and is restarted.
    case connectionChanged(ConnectionStatus)
    case unknown(event: String)
}

// MARK: - DaemonError

public struct DaemonError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}
