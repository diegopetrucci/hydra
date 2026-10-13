import AppFeature
import ComposableArchitecture
import DaemonClient
import Foundation
import IdentifiedCollections
import Testing

// MARK: - Fixtures

private let stubBot = Bot(
    id: "1",
    name: "Helper",
    instructions: "Be helpful.",
    model: "anthropic/claude-sonnet-5-5",
    createdAt: Date(timeIntervalSince1970: 1_700_000_000)
)

private let stubMessages: [Message] = [
    Message(id: "10", role: "user", text: "Hello", createdAt: Date(timeIntervalSince1970: 1_700_000_001)),
    Message(id: "11", role: "assistant", text: "Hi!", createdAt: Date(timeIntervalSince1970: 1_700_000_002)),
]

private let fixedDate = Date(timeIntervalSince1970: 1_700_100_000)
private let fixedClientID = "00000000-0000-0000-0000-000000000001"

// MARK: - ChatFeatureTests

@Suite("ChatFeature")
@MainActor
struct ChatFeatureTests {

    // MARK: - History loading

    @Test("task loads history")
    func taskLoadsHistory() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsHistory = { _ in stubMessages }
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // isHistoryLoading is already true by default; .task starts the load.
        await store.send(.task) {
            $0.focus = .composer
        }
        await store.receive(\.historyLoaded) {
            $0.isHistoryLoading = false
            $0.messages = IdentifiedArray(uniqueElements: stubMessages.map(ChatMessage.from))
        }
    }

    @Test("composerFocusRequested focuses the composer")
    func composerFocusRequested() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        }

        await store.send(.composerFocusRequested) {
            $0.focus = .composer
        }
    }

    @Test("history load failure sets error")
    func historyLoadFailed() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsHistory = { _ in
                throw DaemonError(code: "not_found", message: "Bot not found")
            }
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.task) {
            $0.focus = .composer
        }
        await store.receive(\.historyLoadFailed) {
            $0.isHistoryLoading = false
            $0.historyError = "Bot not found"
        }
    }

    @Test("historyLoaded drops stale response for a different botID (gap 1)")
    func historyLoadedDropsStale() async {
        var initialState = ChatFeature.State(botID: "2", botName: "Coder")
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // Deliver historyLoaded for bot "1" while bot "2" is selected — must be a no-op.
        await store.send(.historyLoaded(botID: "1", messages: stubMessages))
        // No state change expected.
    }

    @Test("historyLoadFailed drops stale failure for a different botID (gap 1)")
    func historyLoadFailedDropsStale() async {
        var initialState = ChatFeature.State(botID: "2", botName: "Coder")
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.historyLoadFailed(botID: "1", error: "Not found"))
        // No state change expected.
    }

    // MARK: - History merge (gap 2)

    @Test("historyLoaded keeps streaming bubble that arrived after snapshot (gap 2)")
    func historyLoadedKeepsStreaming() async {
        let clientID = "00000000-0000-0000-0000-000000000020"
        let streamingID = "msg-stream-live"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "Hey", now: fixedDate)
        let streamingMsg = ChatMessage.streaming(streamingID: streamingID, now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg, streamingMsg]
        initialState.isHistoryLoading = true
        initialState.isStreaming = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // Snapshot only has the user message committed (before the reply finished).
        let snapshot = [Message(id: "50", role: "user", text: "Hey", createdAt: fixedDate)]
        await store.send(.historyLoaded(botID: "1", messages: snapshot)) {
            $0.isHistoryLoading = false
            // The committed user message appears first; streaming bubble is kept.
            // The optimistic bubble is reconciled (heuristic: same role + text) → dropped.
            $0.messages = IdentifiedArray(uniqueElements: [
                ChatMessage.from(snapshot[0]),
                streamingMsg,
            ])
        }
    }

    @Test("historyLoaded keeps post-snapshot persisted message and upserts by id (gap 2)")
    func historyLoadedKeepsPostSnapshotPersisted() async {
        // A message.completed arrived after the snapshot was requested.
        let postSnapshotMsg = ChatMessage(
            id: "99",
            role: "assistant",
            text: "Done!",
            createdAt: fixedDate,
            kind: .persisted
        )

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [postSnapshotMsg]
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // Snapshot does NOT include msg "99" (it arrived after snapshot was requested).
        let snapshot = [Message(id: "50", role: "user", text: "Hello", createdAt: fixedDate)]
        await store.send(.historyLoaded(botID: "1", messages: snapshot)) {
            $0.isHistoryLoading = false
            $0.messages = IdentifiedArray(uniqueElements: [
                ChatMessage.from(snapshot[0]),
                postSnapshotMsg,
            ])
        }
    }

    @Test("historyLoaded heuristic reconciles optimistic user message with persisted (gap 2)")
    func historyLoadedReconcilesOptimistic() async {
        let clientID = "00000000-0000-0000-0000-000000000021"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "Hello there", now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg]
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // Snapshot contains the committed version of the user message with same text.
        let committed = Message(id: "51", role: "user", text: "Hello there", createdAt: fixedDate)
        await store.send(.historyLoaded(botID: "1", messages: [committed])) {
            $0.isHistoryLoading = false
            // Optimistic bubble is reconciled (same user text found in snapshot) — dropped.
            $0.messages = [ChatMessage.from(committed)]
        }
    }

    @Test("historyLoaded reconciles at most once per persisted user message (gap 2)")
    func historyLoadedReconcilesAtMostOnce() async {
        let clientID1 = "00000000-0000-0000-0000-000000000022"
        let clientID2 = "00000000-0000-0000-0000-000000000023"
        let opt1 = ChatMessage.optimistic(clientMessageID: clientID1, text: "Hi", now: fixedDate)
        let opt2 = ChatMessage.optimistic(clientMessageID: clientID2, text: "Hi", now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [opt1, opt2]
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // Only one "Hi" committed — reconcile removes one optimistic bubble, keeps the other.
        let committed = Message(id: "52", role: "user", text: "Hi", createdAt: fixedDate)
        await store.send(.historyLoaded(botID: "1", messages: [committed])) {
            $0.isHistoryLoading = false
            // One matched → dropped; one remains (the second optimistic, clientID2).
            $0.messages = IdentifiedArray(uniqueElements: [
                ChatMessage.from(committed),
                opt2,
            ])
        }
    }

    // MARK: - Send flow

    @Test("sendButtonTapped inserts optimistic message and calls botsSend")
    func sendInsertOptimistic() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsSend = { _, _, _ in true }
            $0.date.now = fixedDate
            $0.uuid = .constant(UUID(uuidString: fixedClientID)!)
        }

        await store.send(.set(\.composerText, "Hello bot")) {
            $0.composerText = "Hello bot"
        }
        await store.send(.sendButtonTapped) {
            $0.composerText = ""
            $0.messages = [
                ChatMessage.optimistic(clientMessageID: fixedClientID, text: "Hello bot", now: fixedDate),
            ]
        }
        await store.receive(\._sendAccepted) {
            $0.lastUserClientMessageID = fixedClientID
        }
    }

    @Test("send rejected marks message failed and emits delegate")
    func sendRejectedMarksFailed() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsSend = { _, _, _ in false }  // accepted = false
            $0.date.now = fixedDate
            $0.uuid = .constant(UUID(uuidString: fixedClientID)!)
        }

        await store.send(.set(\.composerText, "Hi")) {
            $0.composerText = "Hi"
        }
        await store.send(.sendButtonTapped) {
            $0.composerText = ""
            $0.messages = [
                ChatMessage.optimistic(clientMessageID: fixedClientID, text: "Hi", now: fixedDate),
            ]
        }
        await store.receive(\._sendRejected) {
            $0.messages[id: fixedClientID]?.kind = .failed(
                clientMessageID: fixedClientID,
                reason: "Authentication required"
            )
        }
        await store.receive(\.delegate)  // .authRequired
    }

    @Test("delta events accumulate text in streaming bubble")
    func deltaAccumulates() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        let streamingID = "msg-stream-1"

        await store.send(.messageStarted(messageID: streamingID)) {
            $0.isStreaming = true
            $0.messages = [ChatMessage.streaming(streamingID: streamingID, now: fixedDate)]
        }
        await store.send(.messageDeltaReceived(messageID: streamingID, text: "Hello")) {
            $0.messages[id: streamingID]?.text = "Hello"
        }
        await store.send(.messageDeltaReceived(messageID: streamingID, text: " world")) {
            $0.messages[id: streamingID]?.text = "Hello world"
        }
    }

    @Test("message.completed finalizes streaming bubble with persisted message")
    func messageCompletedFinalizes() async {
        let streamingID = "msg-stream-2"
        let finalMessage = Message(
            id: "55",
            role: "assistant",
            text: "Done!",
            createdAt: Date(timeIntervalSince1970: 1_700_000_099)
        )
        let streamingMsg = ChatMessage.streaming(streamingID: streamingID, now: fixedDate)
        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [streamingMsg]
        initialState.isHistoryLoading = false
        initialState.isStreaming = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.messageCompleted(messageID: streamingID, message: finalMessage)) {
            $0.isStreaming = false
            $0.messages = [ChatMessage.from(finalMessage)]
        }
    }

    @Test("full send–stream–complete cycle")
    func fullSendCycle() async {
        let streamingID = "msg-stream-3"
        let persistedMessage = Message(
            id: "77",
            role: "assistant",
            text: "Hello!",
            createdAt: fixedDate
        )

        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsSend = { _, _, _ in true }
            $0.date.now = fixedDate
            $0.uuid = .constant(UUID(uuidString: fixedClientID)!)
        }

        // 1. Send message — inserts optimistic bubble
        await store.send(.set(\.composerText, "Hey")) {
            $0.composerText = "Hey"
        }
        await store.send(.sendButtonTapped) {
            $0.composerText = ""
            $0.messages = [
                ChatMessage.optimistic(clientMessageID: fixedClientID, text: "Hey", now: fixedDate),
            ]
        }
        await store.receive(\._sendAccepted) {
            $0.lastUserClientMessageID = fixedClientID
        }

        // 2. Streaming starts
        await store.send(.messageStarted(messageID: streamingID)) {
            $0.isStreaming = true
            $0.messages.append(ChatMessage.streaming(streamingID: streamingID, now: fixedDate))
        }

        // 3. Delta
        await store.send(.messageDeltaReceived(messageID: streamingID, text: "Hello!")) {
            $0.messages[id: streamingID]?.text = "Hello!"
        }

        // 4. Completed — streaming bubble replaced by persisted message
        await store.send(.messageCompleted(messageID: streamingID, message: persistedMessage)) {
            $0.isStreaming = false
            $0.messages = [
                ChatMessage.optimistic(clientMessageID: fixedClientID, text: "Hey", now: fixedDate),
                ChatMessage.from(persistedMessage),
            ]
        }
    }

    // MARK: - Stop

    @Test("stopButtonTapped calls botsStop")
    func stopButtonTapped() async {
        let stopped = LockIsolated(false)
        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.isHistoryLoading = false
        initialState.isStreaming = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsStop = { _ in stopped.setValue(true); return true }
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.stopButtonTapped)
        await store.receive(\._stopResponse)
        #expect(stopped.value)
    }

    // MARK: - Activity status line

    @Test("activityChanged updates activity state")
    func activityChangedUpdatesActivity() async {
        let store = TestStore(
            initialState: ChatFeature.State(botID: "1", botName: "Helper")
        ) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.activityChanged(.thinking)) {
            $0.activity = .thinking
        }
        await store.send(.activityChanged(.tool(name: "web_search", label: "Searching the web"))) {
            $0.activity = .tool(name: "web_search", label: "Searching the web")
        }
        await store.send(.activityChanged(.idle)) {
            $0.activity = .idle
            $0.isStreaming = false
        }
    }

    // MARK: - Retry

    @Test("retry re-sends failed message with same clientMessageID")
    func retryResendsFailed() async {
        let clientID = "00000000-0000-0000-0000-000000000002"
        var failedMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "Retry me", now: fixedDate)
        failedMsg.kind = .failed(clientMessageID: clientID, reason: "Authentication required")

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [failedMsg]
        initialState.isHistoryLoading = false

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsSend = { _, _, _ in true }
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.retryTapped(clientMessageID: clientID)) {
            $0.messages[id: clientID]?.kind = .optimistic(clientMessageID: clientID)
        }
        await store.receive(\._sendAccepted) {
            $0.lastUserClientMessageID = "00000000-0000-0000-0000-000000000002"
        }
    }

    // MARK: - Generation error inline

    @Test("generation_failed bot.error shown inline with retry, streaming cleared")
    func generationFailedShownInline() async {
        let clientID = "00000000-0000-0000-0000-000000000003"
        let streamingID = "msg-stream-err"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "Hello", now: fixedDate)
        let streamingMsg = ChatMessage.streaming(streamingID: streamingID, now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg, streamingMsg]
        initialState.isHistoryLoading = false
        initialState.isStreaming = true
        initialState.activity = .thinking
        initialState.lastUserClientMessageID = clientID

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .constant(UUID(uuidString: "00000000-0000-0000-0000-000000000099")!)
        }

        await store.send(.botErrorReceived(code: "generation_failed", message: "Model failed to respond.")) {
            $0.isStreaming = false
            $0.activity = .idle
            // The streaming bubble is replaced by the inline error using the same ID.
            $0.messages[id: streamingID] = ChatMessage(
                id: streamingID,
                role: "assistant",
                text: "Model failed to respond.",
                createdAt: fixedDate,
                kind: .botError(message: "Model failed to respond.", retryClientMessageID: clientID)
            )
        }
    }

    @Test("generation_failed retry uses a fresh clientMessageId and re-keys the optimistic bubble")
    func generationFailedRetry() async {
        // Set up state via the inline-error flow so the errorMsg id is the streaming id.
        let originalClientID = "00000000-0000-0000-0000-000000000004"
        // The uuid dependency is .constant, so the retry will receive this fresh id.
        let newClientID = "00000000-0000-0000-0000-000000000099"
        let streamingID = "msg-stream-retry"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: originalClientID, text: "Retry this", now: fixedDate)
        let streamingMsg = ChatMessage.streaming(streamingID: streamingID, now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = IdentifiedArray(uniqueElements: [optimisticMsg, streamingMsg])
        initialState.isHistoryLoading = false
        initialState.isStreaming = true
        initialState.activity = .thinking
        initialState.lastUserClientMessageID = originalClientID

        let sentClientID = LockIsolated<String?>(nil)

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsSend = { _, _, clientID in
                sentClientID.setValue(clientID)
                return true
            }
            $0.date.now = fixedDate
            // .constant so the retry always draws the same predictable fresh UUID.
            $0.uuid = .constant(UUID(uuidString: newClientID)!)
        }

        // 1. Bot error replaces the streaming bubble with an inline error.
        await store.send(.botErrorReceived(code: "generation_failed", message: "Model failed.")) {
            $0.isStreaming = false
            $0.activity = .idle
            $0.messages[id: streamingID] = ChatMessage(
                id: streamingID,
                role: "assistant",
                text: "Model failed.",
                createdAt: fixedDate,
                kind: .botError(message: "Model failed.", retryClientMessageID: originalClientID)
            )
        }

        // Rekeyed optimistic bubble (old id removed, new id inserted at same position).
        let rekeyed = ChatMessage(
            id: newClientID,
            role: "user",
            text: "Retry this",
            createdAt: fixedDate,
            kind: .optimistic(clientMessageID: newClientID)
        )

        // 2. Retry tapped: error bubble removed, optimistic bubble re-keyed to fresh id,
        //    bots.send called with the new id so pi-durable starts a new generation.
        await store.send(.retryGenerationTapped(errorMessageID: streamingID)) {
            // Error message gone; only the rekeyed optimistic bubble remains.
            $0.messages = IdentifiedArray(uniqueElements: [rekeyed])
        }

        // 3. Send accepted updates lastUserClientMessageID to the NEW id.
        await store.receive(\._sendAccepted) {
            $0.lastUserClientMessageID = newClientID
        }

        #expect(sentClientID.value != originalClientID, "Retry must not reuse the original clientMessageId")
        #expect(sentClientID.value == newClientID, "Retry must use the UUID drawn from the uuid dependency")
    }

    @Test("auth_required bot.error clears streaming state and emits delegate")
    func authRequiredBotError() async {
        let streamingMsg = ChatMessage.streaming(streamingID: "msg-s", now: fixedDate)
        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [streamingMsg]
        initialState.isHistoryLoading = false
        initialState.isStreaming = true
        initialState.activity = .thinking

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.botErrorReceived(code: "auth_required", message: "No credentials.")) {
            $0.isStreaming = false
            $0.activity = .idle
            $0.messages = []  // streaming bubble removed
        }
        await store.receive(\.delegate)  // .authRequired
    }

    // MARK: - History merge

    @Test("historyLoaded preserves unresolved optimistic messages not in the snapshot")
    func historyLoadedPreservesOptimistic() async {
        let clientID = "00000000-0000-0000-0000-000000000005"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "In flight", now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg]
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        // History arrives with no committed messages yet.
        await store.send(.historyLoaded(botID: "1", messages: [])) {
            $0.isHistoryLoading = false
            // The optimistic message is kept.
            $0.messages = [optimisticMsg]
        }
    }

    @Test("historyLoaded merges history with optimistic, deduplicating by id")
    func historyLoadedMergesWithOptimistic() async {
        let clientID = "00000000-0000-0000-0000-000000000006"
        let historyMsg = stubMessages[1]  // id "11", assistant
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "New send", now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg]
        initialState.isHistoryLoading = true

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.historyLoaded(botID: "1", messages: [historyMsg])) {
            $0.isHistoryLoading = false
            // History comes first, then the optimistic message.
            $0.messages = [
                ChatMessage.from(historyMsg),
                optimisticMsg,
            ]
        }
    }

    // MARK: - Reconnect

    @Test("reconnected clears streaming state and reloads history")
    func reconnectedClearsAndReloads() async {
        let streamingMsg = ChatMessage.streaming(streamingID: "msg-r", now: fixedDate)
        let clientID = "00000000-0000-0000-0000-000000000007"
        let optimisticMsg = ChatMessage.optimistic(clientMessageID: clientID, text: "Pending", now: fixedDate)

        var initialState = ChatFeature.State(botID: "1", botName: "Helper")
        initialState.messages = [optimisticMsg, streamingMsg]
        initialState.isHistoryLoading = false
        initialState.isStreaming = true
        initialState.activity = .thinking
        initialState.lastUserClientMessageID = clientID

        let store = TestStore(initialState: initialState) {
            ChatFeature()
        } withDependencies: {
            $0.daemonClient.botsHistory = { _ in [] }
            $0.date.now = fixedDate
            $0.uuid = .incrementing
        }

        await store.send(.reconnected) {
            $0.activity = .idle
            $0.isStreaming = false
            $0.isHistoryLoading = true
            $0.historyError = nil
            // Streaming bubble removed; optimistic send kept.
            $0.messages = [optimisticMsg]
        }
        await store.receive(\.historyLoaded) {
            $0.isHistoryLoading = false
            // Empty history + optimistic message preserved.
            $0.messages = [optimisticMsg]
        }
    }
}
