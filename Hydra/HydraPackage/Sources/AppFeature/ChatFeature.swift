import ComposableArchitecture
import DaemonClient
import Foundation
import IdentifiedCollections
import SwiftUI

// MARK: - ChatFeature

@Reducer
public struct ChatFeature {

    /// The app and daemon share the machine clock; the daemon stamps a message after
    /// the send, in whole milliseconds, hence a 1s tolerance when matching bubbles.
    static let historyMatchTolerance: TimeInterval = 1

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        public var botID: String
        public var botName: String
        public var messages: IdentifiedArrayOf<ChatMessage> = []
        public var activity: BotActivity = .idle
        public var composerText: String = ""
        public var focus: Field?
        public var isHistoryLoading: Bool = true
        public var historyError: String?
        /// `true` while the assistant is generating a reply (shows the Stop button).
        public var isStreaming: Bool = false
        /// clientMessageID of the last accepted user send; used to retry after a generation error.
        public var lastUserClientMessageID: String?

        public enum Field: Hashable, Sendable {
            case composer
        }

        public init(botID: String, botName: String) {
            self.botID = botID
            self.botName = botName
        }
    }

    // MARK: - Action

    public enum Action: BindableAction {
        case binding(BindingAction<State>)
        case task
        /// Sent by AppFeature after a sheet closes, which may have taken keyboard focus.
        case composerFocusRequested
        /// Tagged with the botID and a generation counter so stale responses are dropped.
        case historyLoaded(botID: String, messages: [Message])
        case historyLoadFailed(botID: String, error: String)

        // User intent
        case sendButtonTapped
        case stopButtonTapped
        case retryTapped(clientMessageID: String)

        // Effects
        case _sendAccepted(clientMessageID: String)
        case _sendRejected(clientMessageID: String)
        case _sendFailed(clientMessageID: String, error: String)
        case _stopResponse(Bool)

        // Daemon events — dispatched by AppFeature
        case messageStarted(messageID: String)
        case messageDeltaReceived(messageID: String, text: String)
        case messageCompleted(messageID: String, message: Message)
        case activityChanged(BotActivity)
        case botErrorReceived(code: String, message: String)

        // App lifecycle
        /// Sent by AppFeature when the daemon reconnects; clears transient state
        /// and reloads history while keeping unresolved optimistic sends.
        case reconnected
        /// Retry a generation error shown inline in the thread.
        case retryGenerationTapped(errorMessageID: String)

        // Delegate — observed by AppFeature
        case delegate(Delegate)

        public enum Delegate: Equatable {
            /// Sent when `bots.send` returns `accepted: false` (auth_required).
            case authRequired
        }
    }

    // MARK: - Dependencies

    @Dependency(\.daemonClient) var daemonClient
    @Dependency(\.date.now) var now
    @Dependency(\.uuid) var uuid

    // MARK: - Cancel IDs

    private enum CancelID { case history }

    // MARK: - Init

    public init() {}

    // MARK: - Body

    public var body: some Reducer<State, Action> {
        BindingReducer()
        Reduce { state, action in
            switch action {

            case .binding:
                return .none

            case .task:
                state.focus = .composer
                state.isHistoryLoading = true
                state.historyError = nil
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    do {
                        let messages = try await client.botsHistory(botID)
                        await send(.historyLoaded(botID: botID, messages: messages))
                    } catch {
                        await send(.historyLoadFailed(botID: botID, error: error.localizedDescription))
                    }
                }
                .cancellable(id: CancelID.history, cancelInFlight: true)

            case .composerFocusRequested:
                state.focus = .composer
                return .none

            case .historyLoaded(let loadedBotID, let messages):
                // Drop stale responses from a previous bot selection.
                guard loadedBotID == state.botID else { return .none }
                state.isHistoryLoading = false
                let historical = messages.map(ChatMessage.from)
                let snapshotIDs = Set(historical.map(\.id))

                // Categorize existing messages that should survive the merge.
                // Streaming: keep — active generation in progress.
                // Persisted not in snapshot: keep — completed after snapshot was taken.
                // Optimistic/failed not yet committed: keep (pending network send).
                // botError: drop — stale inline error from before the reload.
                var streamingMsgs: [ChatMessage] = []
                var postSnapshotPersisted: [ChatMessage] = []
                var pendingOptimistic: [ChatMessage] = []
                for msg in state.messages {
                    switch msg.kind {
                    case .streaming:
                        streamingMsgs.append(msg)
                    case .persisted:
                        if !snapshotIDs.contains(msg.id) {
                            postSnapshotPersisted.append(msg)
                        }
                    case .optimistic, .failed:
                        if !snapshotIDs.contains(msg.id) {
                            pendingOptimistic.append(msg)
                        }
                    case .botError:
                        break // stale; discard
                    }
                }

                // Build merged array: snapshot first, then post-snapshot persisted,
                // then active streaming, then pending optimistic/failed.
                var merged = IdentifiedArray(uniqueElements: historical)
                for msg in postSnapshotPersisted {
                    if merged[id: msg.id] == nil { merged.append(msg) }
                }
                for msg in streamingMsgs {
                    if merged[id: msg.id] == nil { merged.append(msg) }
                }

                // Heuristic: reconcile optimistic user messages with committed ones.
                // Match by role "user" and identical text, consuming each persisted
                // entry at most once. This is a best-effort approximation — the
                // protocol provides no client-to-durable ID mapping.
                // A historical message only matches if it was stamped no earlier than
                // the bubble (minus tolerance), so older identical texts don't eat it.
                var unmatchedPersistedUsers: [ChatMessage] = historical.filter { $0.role == "user" }
                for msg in pendingOptimistic {
                    if msg.role == "user",
                       let idx = unmatchedPersistedUsers.firstIndex(where: {
                           $0.text == msg.text
                               && $0.createdAt >= msg.createdAt.addingTimeInterval(-Self.historyMatchTolerance)
                       }) {
                        unmatchedPersistedUsers.remove(at: idx)
                        // Already committed; don't re-append the optimistic bubble.
                    } else if merged[id: msg.id] == nil {
                        merged.append(msg)
                    }
                }

                state.messages = merged
                return .none

            case .historyLoadFailed(let loadedBotID, let message):
                guard loadedBotID == state.botID else { return .none }
                state.isHistoryLoading = false
                state.historyError = message
                return .none

            case .sendButtonTapped:
                let text = state.composerText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return .none }
                let clientMessageID = uuid().uuidString
                let optimistic = ChatMessage.optimistic(clientMessageID: clientMessageID, text: text, now: now)
                state.messages.append(optimistic)
                state.composerText = ""
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    do {
                        let accepted = try await client.botsSend(botID, text, clientMessageID)
                        if accepted {
                            await send(._sendAccepted(clientMessageID: clientMessageID))
                        } else {
                            await send(._sendRejected(clientMessageID: clientMessageID))
                        }
                    } catch {
                        await send(._sendFailed(clientMessageID: clientMessageID, error: error.localizedDescription))
                    }
                }

            case ._sendAccepted(let clientMessageID):
                // Optimistic message stays; reply arrives via messageStarted/delta/completed.
                state.lastUserClientMessageID = clientMessageID
                return .none

            case ._sendRejected(let clientMessageID):
                if var msg = state.messages[id: clientMessageID] {
                    msg.kind = .failed(clientMessageID: clientMessageID, reason: "Authentication required")
                    state.messages[id: clientMessageID] = msg
                }
                return .send(.delegate(.authRequired))

            case ._sendFailed(let clientMessageID, let error):
                if var msg = state.messages[id: clientMessageID] {
                    msg.kind = .failed(clientMessageID: clientMessageID, reason: error)
                    state.messages[id: clientMessageID] = msg
                }
                return .none

            case .stopButtonTapped:
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    let stopped = try? await client.botsStop(botID)
                    await send(._stopResponse(stopped ?? false))
                }

            case ._stopResponse:
                // Activity will be updated by the arriving `bot.activity(.idle)` event.
                return .none

            case .retryTapped(let clientMessageID):
                guard let existing = state.messages[id: clientMessageID],
                      case .failed = existing.kind else { return .none }
                let text = existing.text
                var updated = existing
                updated.kind = .optimistic(clientMessageID: clientMessageID)
                state.messages[id: clientMessageID] = updated
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    do {
                        let accepted = try await client.botsSend(botID, text, clientMessageID)
                        if accepted {
                            await send(._sendAccepted(clientMessageID: clientMessageID))
                        } else {
                            await send(._sendRejected(clientMessageID: clientMessageID))
                        }
                    } catch {
                        await send(._sendFailed(clientMessageID: clientMessageID, error: error.localizedDescription))
                    }
                }

            case .retryGenerationTapped(let errorMessageID):
                guard let existing = state.messages[id: errorMessageID] else { return .none }
                guard case .botError(_, let retryClientMessageID) = existing.kind else { return .none }
                guard let oldClientMessageID = retryClientMessageID else { return .none }
                guard let userMsg = state.messages[id: oldClientMessageID] else { return .none }
                // Only retry if the user message is still pending (optimistic).
                let isOptimistic: Bool
                if case .optimistic = userMsg.kind { isOptimistic = true } else { isOptimistic = false }
                guard isOptimistic else { return .none }
                // Remove the inline error bubble.
                state.messages.removeAll(where: { $0.id == errorMessageID })
                // Generate a fresh clientMessageId: pi-durable deduplicates bots.send by
                // requestId, so retrying with the same id is a no-op. Re-keying the optimistic
                // bubble keeps a single user-message copy in the thread. Note: the original
                // message may already be stored in durable history, so history will hold two
                // copies of the user turn after a successful retry — accepted for this spike.
                let newClientMessageID = uuid().uuidString
                if let idx = state.messages.index(id: oldClientMessageID) {
                    let rekeyed = ChatMessage(
                        id: newClientMessageID,
                        role: userMsg.role,
                        text: userMsg.text,
                        createdAt: userMsg.createdAt,
                        kind: .optimistic(clientMessageID: newClientMessageID)
                    )
                    state.messages.remove(at: idx)
                    state.messages.insert(rekeyed, at: idx)
                }
                let text = userMsg.text
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    do {
                        let accepted = try await client.botsSend(botID, text, newClientMessageID)
                        if accepted {
                            await send(._sendAccepted(clientMessageID: newClientMessageID))
                        } else {
                            await send(._sendRejected(clientMessageID: newClientMessageID))
                        }
                    } catch {
                        await send(._sendFailed(clientMessageID: newClientMessageID, error: error.localizedDescription))
                    }
                }

            case .messageStarted(let messageID):
                let bubble = ChatMessage.streaming(streamingID: messageID, now: now)
                state.messages.append(bubble)
                state.isStreaming = true
                return .none

            case .messageDeltaReceived(let messageID, let text):
                if var msg = state.messages[id: messageID] {
                    msg.text += text
                    state.messages[id: messageID] = msg
                }
                return .none

            case .messageCompleted(let messageID, let message):
                let persisted = ChatMessage.from(message)
                if let idx = state.messages.index(id: messageID) {
                    state.messages.remove(at: idx)
                    state.messages.insert(persisted, at: idx)
                } else {
                    state.messages.append(persisted)
                }
                state.isStreaming = false
                return .none

            case .activityChanged(let activity):
                state.activity = activity
                if activity == .idle {
                    state.isStreaming = false
                }
                return .none

            case .botErrorReceived(let code, let message):
                // Clear streaming state regardless of error type.
                state.isStreaming = false
                state.activity = .idle
                if code == "auth_required" {
                    // Remove any stale streaming bubble.
                    state.messages.removeAll(where: { if case .streaming = $0.kind { return true }; return false })
                    return .send(.delegate(.authRequired))
                } else {
                    // generation_failed: replace streaming bubble (if any) with an inline error.
                    let streamingMsg = state.messages.first(where: { if case .streaming = $0.kind { return true }; return false })
                    let errorID = streamingMsg?.id ?? uuid().uuidString
                    let retryClientMessageID = state.lastUserClientMessageID
                    let errorMsg = ChatMessage(
                        id: errorID,
                        role: "assistant",
                        text: message,
                        createdAt: now,
                        kind: .botError(message: message, retryClientMessageID: retryClientMessageID)
                    )
                    if state.messages[id: errorID] != nil {
                        state.messages[id: errorID] = errorMsg
                    } else {
                        state.messages.append(errorMsg)
                    }
                    return .none
                }

            case .reconnected:
                // Clear transient state from an interrupted generation.
                state.activity = .idle
                state.isStreaming = false
                // Remove stale streaming / inline-error bubbles.
                state.messages.removeAll(where: {
                    switch $0.kind {
                    case .streaming, .botError: return true
                    default: return false
                    }
                })
                // Reload history while preserving unresolved optimistic sends.
                state.isHistoryLoading = true
                state.historyError = nil
                let botID = state.botID
                let client = daemonClient
                return .run { send in
                    do {
                        let messages = try await client.botsHistory(botID)
                        await send(.historyLoaded(botID: botID, messages: messages))
                    } catch {
                        await send(.historyLoadFailed(botID: botID, error: error.localizedDescription))
                    }
                }
                .cancellable(id: CancelID.history, cancelInFlight: true)

            case .delegate:
                // Handled by AppFeature
                return .none
            }
        }
    }
}

// MARK: - ChatFeatureView

public struct ChatFeatureView: View {
    @Bindable var store: StoreOf<ChatFeature>
    @FocusState private var focus: ChatFeature.State.Field?

    public init(store: StoreOf<ChatFeature>) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            messagesPane
            activityBar
            composerBar
        }
        // Gap (1): key the task by botID so SwiftUI restarts it whenever the selected
        // bot changes, triggering a fresh history load for the new bot.
        .task(id: store.botID) { await store.send(.task).finish() }
        .bind($store.focus, to: $focus)
        .navigationTitle(store.botName)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                BotAvatar(id: store.botID, name: store.botName, size: 20)
            }
        }
    }

    // MARK: Messages

    @ViewBuilder private var messagesPane: some View {
        if store.isHistoryLoading {
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.historyError {
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                Text(error)
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(store.messages) { message in
                            MessageBubble(
                                message: message,
                                onRetry: { clientMessageID in
                                    store.send(.retryTapped(clientMessageID: clientMessageID))
                                },
                                onRetryGeneration: { errorMessageID in
                                    store.send(.retryGenerationTapped(errorMessageID: errorMessageID))
                                }
                            )
                            .id(message.id)
                        }
                    }
                    .padding()
                }
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .onChange(of: store.messages.count) { _, _ in
                    if let last = store.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
        }
    }

    // MARK: Activity bar

    @ViewBuilder private var activityBar: some View {
        if store.activity != .idle {
            HStack(spacing: 6) {
                ProgressView()
                    .scaleEffect(0.7)
                Text(activityLabel(store.activity))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 4)
            .background(.background)
            Divider()
        }
    }

    // MARK: Composer

    private var composerBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message…", text: $store.composerText, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($focus, equals: .composer)
                .onSubmit {
                    guard !NSEvent.modifierFlags.contains(.shift) else { return }
                    store.send(.sendButtonTapped)
                }

            if store.isStreaming {
                Button {
                    store.send(.stopButtonTapped)
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .imageScale(.large)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
            } else {
                Button {
                    store.send(.sendButtonTapped)
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .imageScale(.large)
                }
                .buttonStyle(.plain)
                .disabled(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(.background)
        .overlay(alignment: .top) { Divider() }
    }

    // MARK: - Helpers

    private func activityLabel(_ activity: BotActivity) -> String {
        switch activity {
        case .thinking: return "Thinking…"
        case .tool(_, let label): return "\(label)…"
        case .idle: return ""
        }
    }
}

// MARK: - MessageBubble

private struct MessageBubble: View {
    let message: ChatMessage
    let onRetry: (String) -> Void
    let onRetryGeneration: (String) -> Void

    var body: some View {
        let isUser = message.role == "user"
        VStack(alignment: isUser ? .trailing : .leading, spacing: 2) {
            HStack(alignment: .top) {
                if isUser {
                    Spacer(minLength: 60)
                    messageContent
                        .padding(10)
                        .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                } else {
                    messageContent
                        .padding(10)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                    Spacer(minLength: 60)
                }
            }
            if showsTimestamp {
                Text(MessageTimestamp.format(message.createdAt, now: Date()))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    /// The time caption appears once the reply is saved, not while it streams.
    private var showsTimestamp: Bool {
        if case .streaming = message.kind { return false }
        return true
    }

    @ViewBuilder private var messageContent: some View {
        switch message.kind {
        case .persisted, .streaming, .optimistic:
            if message.text.isEmpty {
                Text(" ")
                    .textSelection(.enabled)
            } else if message.role == "assistant" {
                Text(renderedMarkdown(message.text))
                    .textSelection(.enabled)
            } else {
                Text(message.text)
                    .textSelection(.enabled)
            }

        case .failed(let clientMessageID, let reason):
            VStack(alignment: .leading, spacing: 4) {
                Text(message.text)
                    .textSelection(.enabled)
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.red)
                Button("Retry") { onRetry(clientMessageID) }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
            }

        case .botError(_, let retryClientMessageID):
            VStack(alignment: .leading, spacing: 4) {
                Text(message.text)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                if retryClientMessageID != nil {
                    Button("Retry") { onRetryGeneration(message.id) }
                        .font(.caption)
                        .buttonStyle(.plain)
                        .foregroundStyle(.blue)
                }
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Long history") {
    let day1 = Date(timeIntervalSince1970: 1_700_000_000)
    let day2 = day1.addingTimeInterval(24 * 3600)
    let oneLiners = [
        "Quick question: what's the capital of Australia?",
        "Thanks, that helps.",
        "Can you summarise that in one line?",
        "Great, and what about next week?",
        "Perfect.",
    ]
    let longReply =
        "Here's a longer answer.\n\nFirst, consider the context: the request touches several moving parts, "
        + "and each of them has its own constraints.\n\nSecond, the practical steps are straightforward — "
        + "start small, verify, then expand.\n\nFinally, let me know if you'd like a deeper dive."
    let shortReplies = ["Canberra.", "Happy to help!", "Sure — done.", "Yes, that works."]
    let messages: [Message] = (0..<30).map { i in
        let isUser = i.isMultiple(of: 2)
        let text: String
        if isUser {
            text = oneLiners[(i / 2) % oneLiners.count]
        } else {
            text = (i / 2).isMultiple(of: 2) ? longReply : shortReplies[(i / 2) % shortReplies.count]
        }
        return Message(
            id: "preview-\(i)",
            role: isUser ? "user" : "assistant",
            text: text,
            createdAt: (i < 15 ? day1 : day2).addingTimeInterval(Double(i) * 300)
        )
    }
    var state = ChatFeature.State(botID: "preview-bot", botName: "Helper Bot")
    state.messages = IdentifiedArray(uniqueElements: messages.map(ChatMessage.from))
    state.isHistoryLoading = false
    // EmptyReducer: static preview snapshots don't wait for effects, so the view's
    // .task (which would reset to "Loading…") must not run the real reducer.
    return ChatFeatureView(store: Store(initialState: state) { EmptyReducer() })
}
#endif
