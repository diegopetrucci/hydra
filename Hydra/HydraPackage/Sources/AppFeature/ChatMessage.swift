import DaemonClient
import Foundation

// MARK: - ChatMessage

/// A message as displayed in the chat thread.
///
/// Wraps both persisted daemon messages and transient UI states
/// (optimistic user messages, streaming assistant bubbles, failed messages).
public struct ChatMessage: Equatable, Identifiable, Sendable {

    // MARK: - Kind

    public enum Kind: Equatable, Sendable {
        /// Committed to daemon storage; `id` is the durable message id.
        case persisted
        /// Assistant reply is streaming; `id` is the transient streaming id from `message.started`.
        case streaming
        /// User message inserted before daemon confirmation; `id` is the clientMessageID.
        case optimistic(clientMessageID: String)
        /// Send failed (e.g. `auth_required` or network error); retry is shown.
        case failed(clientMessageID: String, reason: String)
        /// Bot generation failed (e.g. `generation_failed`); shown inline with a retry option.
        /// `retryClientMessageID` is the clientMessageID of the user message that triggered
        /// this generation, used to re-send on retry.
        case botError(message: String, retryClientMessageID: String?)
    }

    // MARK: - Properties

    public var id: String
    public var role: String   // "user" | "assistant"
    public var text: String
    public var createdAt: Date
    public var kind: Kind

    // MARK: - Init

    public init(id: String, role: String, text: String, createdAt: Date, kind: Kind) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.kind = kind
    }

    // MARK: - Factories

    public static func from(_ message: Message) -> ChatMessage {
        ChatMessage(
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            kind: .persisted
        )
    }

    public static func optimistic(clientMessageID: String, text: String, now: Date) -> ChatMessage {
        ChatMessage(
            id: clientMessageID,
            role: "user",
            text: text,
            createdAt: now,
            kind: .optimistic(clientMessageID: clientMessageID)
        )
    }

    public static func streaming(streamingID: String, now: Date) -> ChatMessage {
        ChatMessage(
            id: streamingID,
            role: "assistant",
            text: "",
            createdAt: now,
            kind: .streaming
        )
    }
}
