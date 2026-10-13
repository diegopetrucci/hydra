import AppFeature
import ComposableArchitecture
import DaemonClient
import Foundation
import Testing

// MARK: - Test fixtures (top-level: Sendable, accessible from @Sendable closures)

private let stubHello = HelloResult(
    protocolVersion: "1",
    daemonVersion: "0.1.0",
    tools: ["web_search"]
)

private let stubBots: [Bot] = [
    Bot(
        id: "1",
        name: "Helper",
        instructions: "Be helpful.",
        model: "anthropic/claude-sonnet-5-5",
        createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    ),
    Bot(
        id: "2",
        name: "Coder",
        instructions: "Write code.",
        model: "anthropic/claude-sonnet-5-5",
        createdAt: Date(timeIntervalSince1970: 1_700_001_000)
    ),
]

private let stubAuthStatus = AuthStatusResult(
    providers: [ProviderStatus(providerID: "anthropic", type: "api_key", source: "stored")]
)

private let stubNoCredentialStatus = AuthStatusResult(
    providers: [ProviderStatus(providerID: "anthropic", type: nil, source: nil)]
)

// MARK: - AppFeatureTests

@Suite("AppFeature")
@MainActor
struct AppFeatureTests {

    // MARK: - Launch

    /// Gap (7): replaced withMainSerialExecutor + reverse-merge-order reliance with
    /// test-controlled continuations that release one response at a time, each received exhaustively.
    @Test("launch connects then loads hello and bots")
    func launchLoadsBotsAndHello() async {
        let (events, eventCont) = AsyncStream<DaemonEvent>.makeStream()
        let (helloStream, helloCont) = AsyncStream<HelloResult>.makeStream()
        let (botsStream, botsCont) = AsyncStream<[Bot]>.makeStream()
        let (authStream, authCont) = AsyncStream<AuthStatusResult>.makeStream()

        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.events = { events }
            $0.daemonClient.hello = { for await v in helloStream { return v }; fatalError() }
            $0.daemonClient.botsList = { for await v in botsStream { return v }; fatalError() }
            $0.daemonClient.authStatus = { for await v in authStream { return v }; fatalError() }
        }

        await store.send(.connectSucceeded) { $0.daemonStatus = .connected }

        // Release auth first — credentials present, no login shown.
        authCont.yield(stubAuthStatus)
        authCont.finish()
        await store.receive(\.authStatusReceived) { $0.isSignedIn = true }

        // Release bots.
        botsCont.yield(stubBots)
        botsCont.finish()
        await store.receive(\.botsLoaded) {
            $0.bots = IdentifiedArray(uniqueElements: stubBots)
            $0.hasLoadedBots = true
        }

        // Release hello.
        helloCont.yield(stubHello)
        helloCont.finish()
        await store.receive(\.helloReceived) { $0.helloResult = stubHello }

        // End event stream.
        eventCont.finish()
        await store.receive(\.daemonStreamEnded) {
            $0.daemonStatus = .error("Daemon disconnected unexpectedly.")
        }
        await store.finish()
    }

    @Test("connect failure surfaces error state")
    func connectFailureSurfacesError() async {
        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.connect = {
                throw DaemonError(code: "node_not_found", message: "Node not found")
            }
            $0.notificationsClient.requestAuthorization = { false }
            // Streams that finish immediately so the test is fully exhaustive.
            $0.notificationsClient.tappedBotIDs = { AsyncStream { $0.finish() } }
            $0.appActivityClient.changes = { AsyncStream { $0.finish() } }
        }

        await store.send(.appLaunched) { $0.isLaunched = true }
        await store.receive(\.connectFailed) {
            $0.daemonStatus = .error("Node not found")
        }
        // requestAuthorization and the two now-finite streams complete; no effects remain.
        await store.finish()
    }

    @Test("appLaunched twice is a no-op (idempotency)")
    func appLaunchedTwiceIsNoop() async {
        // Count how many times connect() is called.
        let connectCount = LockIsolated(0)

        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.connect = {
                connectCount.withValue { $0 += 1 }
                throw DaemonError(code: "node_not_found", message: "Node not found")
            }
            $0.notificationsClient.requestAuthorization = { false }
            // Streams that finish immediately so the test is fully exhaustive.
            $0.notificationsClient.tappedBotIDs = { AsyncStream { $0.finish() } }
            $0.appActivityClient.changes = { AsyncStream { $0.finish() } }
        }

        // First launch: sets isLaunched, starts effects.
        await store.send(.appLaunched) { $0.isLaunched = true }
        await store.receive(\.connectFailed) {
            $0.daemonStatus = .error("Node not found")
        }
        await store.finish()

        // Second launch: isLaunched is already true → no state change, no effects.
        await store.send(.appLaunched)
        await store.finish()

        #expect(connectCount.value == 1, "connect() must only be called once")
    }

    /// Gap (7): replaced withMainSerialExecutor with continuation-based control.
    @Test("hello failure surfaces error state")
    func helloFailureSurfacesError() async {
        let (events, eventCont) = AsyncStream<DaemonEvent>.makeStream()
        let (botsStream, botsCont) = AsyncStream<[Bot]>.makeStream()
        let (authStream, authCont) = AsyncStream<AuthStatusResult>.makeStream()

        let (helloErrStream, helloErrCont) = AsyncStream<DaemonError>.makeStream()

        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.events = { events }
            // Suspend hello so delivery order is fully controlled (gap 7).
            $0.daemonClient.hello = { for await e in helloErrStream { throw e }; fatalError() }
            $0.daemonClient.botsList = { for await v in botsStream { return v }; fatalError() }
            $0.daemonClient.authStatus = { for await v in authStream { return v }; fatalError() }
        }

        await store.send(.connectSucceeded) { $0.daemonStatus = .connected }

        // Release auth first.
        authCont.yield(stubAuthStatus)
        authCont.finish()
        await store.receive(\.authStatusReceived) { $0.isSignedIn = true }

        // Release bots.
        botsCont.yield([])
        botsCont.finish()
        await store.receive(\.botsLoaded) { $0.hasLoadedBots = true }

        // Release hello error last, in controlled order.
        helloErrCont.yield(DaemonError(code: "internal_error", message: "Oops"))
        helloErrCont.finish()
        await store.receive(\.helloFailed) { $0.daemonStatus = .error("Oops") }

        eventCont.finish()
        await store.receive(\.daemonStreamEnded) {
            $0.daemonStatus = .error("Daemon disconnected unexpectedly.")
        }
        await store.finish()
    }

    /// Gap (7): replaced withMainSerialExecutor with continuation-based control.
    @Test("bots load failure surfaces error state")
    func botsLoadFailureSurfacesError() async {
        let (events, eventCont) = AsyncStream<DaemonEvent>.makeStream()
        let (helloStream, helloCont) = AsyncStream<HelloResult>.makeStream()
        let (authStream, authCont) = AsyncStream<AuthStatusResult>.makeStream()
        let (botsErrStream, botsErrCont) = AsyncStream<DaemonError>.makeStream()

        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.events = { events }
            $0.daemonClient.hello = { for await v in helloStream { return v }; fatalError() }
            $0.daemonClient.botsList = { for await e in botsErrStream { throw e }; fatalError() }
            $0.daemonClient.authStatus = { for await v in authStream { return v }; fatalError() }
        }

        await store.send(.connectSucceeded) { $0.daemonStatus = .connected }

        // Release auth first.
        authCont.yield(stubAuthStatus)
        authCont.finish()
        await store.receive(\.authStatusReceived) { $0.isSignedIn = true }

        // Release bots error.
        botsErrCont.yield(DaemonError(code: "internal_error", message: "DB error"))
        botsErrCont.finish()
        await store.receive(\.botsLoadFailed) { $0.daemonStatus = .error("DB error") }

        // Release hello.
        helloCont.yield(stubHello)
        helloCont.finish()
        await store.receive(\.helloReceived) { $0.helloResult = stubHello }

        eventCont.finish()
        await store.receive(\.daemonStreamEnded) {
            $0.daemonStatus = .error("Daemon disconnected unexpectedly.")
        }
        await store.finish()
    }

    // MARK: - Events

    @Test("bot.updated event refreshes bot in state")
    func botUpdatedEventRefreshesBot() async {
        let updatedBot = Bot(
            id: "1",
            name: "Helper (updated)",
            instructions: "Be helpful.",
            model: "anthropic/claude-sonnet-5-5",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastMessagePreview: "Hi there!"
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected
            )
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.botUpdated(updatedBot))) {
            $0.bots[id: "1"] = updatedBot
        }
    }

    @Test("daemon stream ended sets error state")
    func daemonStreamEndedSetsError() async {
        let store = TestStore(
            initialState: AppFeature.State(daemonStatus: .connected)
        ) {
            AppFeature()
        }

        await store.send(.daemonStreamEnded) {
            $0.daemonStatus = .error("Daemon disconnected unexpectedly.")
        }
    }

    // MARK: - Restart flow

    @Test("connectionChanged(.restarting) updates status")
    func connectionChangedRestartingUpdatesStatus() async {
        let store = TestStore(
            initialState: AppFeature.State(daemonStatus: .connected)
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.connectionChanged(.restarting(attempt: 1)))) {
            $0.daemonStatus = .restarting(attempt: 1)
        }
    }

    /// Gap (7): replaced withMainSerialExecutor with continuation-based control.
    @Test("connectionChanged(.reconnected) re-runs hello and bots.list")
    func connectionChangedReconnectedRefreshes() async {
        let (helloStream, helloCont) = AsyncStream<HelloResult>.makeStream()
        let (botsStream, botsCont) = AsyncStream<[Bot]>.makeStream()

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .restarting(attempt: 1)
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.hello = { for await v in helloStream { return v }; fatalError() }
            $0.daemonClient.botsList = { for await v in botsStream { return v }; fatalError() }
        }

        await store.send(.daemonEvent(.connectionChanged(.reconnected))) {
            $0.daemonStatus = .connected
        }

        // Release hello first.
        helloCont.yield(stubHello)
        helloCont.finish()
        await store.receive(\.helloReceived) { $0.helloResult = stubHello }

        // Release bots.
        botsCont.yield(stubBots)
        botsCont.finish()
        await store.receive(\.botsLoaded) { $0.hasLoadedBots = true }
        await store.finish()
    }

    @Test("successive restarting events increment attempt")
    func successiveRestartingEventsIncrementAttempt() async {
        let store = TestStore(
            initialState: AppFeature.State(daemonStatus: .connected)
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.connectionChanged(.restarting(attempt: 1)))) {
            $0.daemonStatus = .restarting(attempt: 1)
        }
        await store.send(.daemonEvent(.connectionChanged(.restarting(attempt: 2)))) {
            $0.daemonStatus = .restarting(attempt: 2)
        }
    }

    // MARK: - Bot selection

    @Test("selecting a bot creates chat state")
    func selectingBotCreatesChatState() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected
            )
        ) {
            AppFeature()
        }

        await store.send(.botSelected("1")) {
            $0.selectedBotID = "1"
            $0.chat = ChatFeature.State(botID: "1", botName: "Helper")
        }
    }

    @Test("selecting nil clears chat state")
    func selectingNilClearsChatState() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        }

        await store.send(.botSelected(nil)) {
            $0.selectedBotID = nil
            $0.chat = nil
        }
    }

    @Test("selecting the same bot ID is a no-op")
    func selectingSameBotIsNoop() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        }
        // Exhaustive: botSelected("1") early-returns .none, so no state change and no effects.
        await store.send(.botSelected("1"))
    }

    // MARK: - New bot

    @Test("newBotSheetDismissed re-requests composer focus only when a chat is open")
    func newBotSheetDismissedRefocusesChat() async {
        let withChat = TestStore(
            initialState: AppFeature.State(chat: ChatFeature.State(botID: "1", botName: "Helper"))
        ) {
            AppFeature()
        }
        await withChat.send(.newBotSheetDismissed)
        await withChat.receive(\.chat.composerFocusRequested) {
            $0.chat?.focus = .composer
        }

        let withoutChat = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        }
        await withoutChat.send(.newBotSheetDismissed)
    }

    @Test("newBotButtonTapped presents new bot sheet")
    func newBotButtonTappedPresentsSheet() async {
        let store = TestStore(
            initialState: AppFeature.State(daemonStatus: .connected)
        ) {
            AppFeature()
        }

        await store.send(.newBotButtonTapped) {
            $0.newBot = NewBotFeature.State()
        }
    }

    @Test("new bot created selects the new bot and dismisses sheet")
    func newBotCreatedSelectsBot() async {
        let newBot = Bot(
            id: "99",
            name: "Fresh Bot",
            instructions: "",
            model: "anthropic/claude-sonnet-5-5",
            createdAt: Date(timeIntervalSince1970: 1_700_002_000)
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected,
                newBot: NewBotFeature.State()
            )
        ) {
            AppFeature()
        }

        // The delegate action inserts the bot and nils the sheet synchronously,
        // then dispatches .botSelected("99") as an Effect.send (received next).
        await store.send(.newBot(.presented(.delegate(.botCreated(newBot))))) {
            $0.bots[id: "99"] = newBot
            $0.newBot = nil
        }
        await store.receive(\.botSelected) {
            $0.selectedBotID = "99"
            $0.chat = ChatFeature.State(botID: "99", botName: "Fresh Bot")
        }
    }

    @Test("new bot create validates empty name")
    func newBotValidatesEmptyName() async {
        let store = TestStore(
            initialState: NewBotFeature.State()
        ) {
            NewBotFeature()
        }

        await store.send(.createButtonTapped) {
            $0.nameError = "Name is required."
        }
    }

    // MARK: - New bot tip eligibility

    @Test("tip eligible after signed-in launch with no bots")
    func tipEligibleAfterSignedInLaunchWithNoBots() async {
        let store = TestStore(initialState: AppFeature.State(daemonStatus: .connected)) {
            AppFeature()
        }

        await store.send(.authStatusReceived(stubAuthStatus)) { $0.isSignedIn = true }
        #expect(!store.state.isNewBotTipEligible)  // bot list not loaded yet
        await store.send(.botsLoaded([])) { $0.hasLoadedBots = true }
        #expect(store.state.isNewBotTipEligible)
    }

    @Test("tip not eligible when bots exist")
    func tipNotEligibleWithBots() async {
        let store = TestStore(initialState: AppFeature.State(daemonStatus: .connected)) {
            AppFeature()
        }

        await store.send(.authStatusReceived(stubAuthStatus)) { $0.isSignedIn = true }
        await store.send(.botsLoaded(stubBots)) {
            $0.bots = IdentifiedArray(uniqueElements: stubBots)
            $0.hasLoadedBots = true
        }
        #expect(!store.state.isNewBotTipEligible)
    }

    @Test("tip becomes eligible after login authenticates")
    func tipEligibleAfterLoginAuthenticated() async {
        let store = TestStore(
            initialState: AppFeature.State(
                daemonStatus: .connected,
                hasLoadedBots: true,
                login: LoginFeature.State()
            )
        ) {
            AppFeature()
        }

        #expect(!store.state.isNewBotTipEligible)
        await store.send(.login(.presented(.delegate(.authenticated)))) {
            $0.isSignedIn = true
            $0.login = nil
        }
        #expect(store.state.isNewBotTipEligible)
    }

    @Test("tip not eligible after sign out")
    func tipNotEligibleAfterSignOut() async {
        let store = TestStore(
            initialState: AppFeature.State(
                daemonStatus: .connected,
                isSignedIn: true,
                hasLoadedBots: true
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.authLogout = { _ in true }
        }

        #expect(store.state.isNewBotTipEligible)
        await store.send(.signOutMenuItemTapped) { $0.isSignedIn = false }
        #expect(!store.state.isNewBotTipEligible)
    }

    @Test("tip not eligible after auth_required")
    func tipNotEligibleAfterAuthRequired() async {
        let store = TestStore(
            initialState: AppFeature.State(
                daemonStatus: .connected,
                isSignedIn: true,
                hasLoadedBots: true
            )
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.botError(botID: "1", code: "auth_required", message: "No credentials"))) {
            $0.isSignedIn = false
            $0.login = LoginFeature.State()
        }
        #expect(!store.state.isNewBotTipEligible)
    }

    @Test("tip not eligible after a bot is created")
    func tipNotEligibleAfterBotCreated() async {
        let newBot = Bot(
            id: "99",
            name: "Fresh Bot",
            instructions: "",
            model: "anthropic/claude-sonnet-5-5",
            createdAt: Date(timeIntervalSince1970: 1_700_002_000)
        )
        let store = TestStore(
            initialState: AppFeature.State(
                daemonStatus: .connected,
                isSignedIn: true,
                hasLoadedBots: true,
                newBot: NewBotFeature.State()
            )
        ) {
            AppFeature()
        }

        #expect(store.state.isNewBotTipEligible)
        await store.send(.newBot(.presented(.delegate(.botCreated(newBot))))) {
            $0.bots[id: "99"] = newBot
            $0.newBot = nil
        }
        await store.receive(\.botSelected) {
            $0.selectedBotID = "99"
            $0.chat = ChatFeature.State(botID: "99", botName: "Fresh Bot")
        }
        #expect(!store.state.isNewBotTipEligible)
    }

    // MARK: - Auth required → login

    @Test("auth_required bot.error presents login sheet")
    func authRequiredBotErrorPresentsLogin() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected,
                isSignedIn: true
            )
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.botError(botID: "1", code: "auth_required", message: "No credentials"))) {
            $0.isSignedIn = false
            $0.login = LoginFeature.State()
        }
    }

    @Test("auth_required via chat delegate presents login")
    func chatDelegateAuthRequiredPresentsLogin() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                isSignedIn: true,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        }

        await store.send(.chat(.delegate(.authRequired))) {
            $0.isSignedIn = false
            $0.login = LoginFeature.State()
        }
    }

    @Test("API key path: save key completes and dismisses login")
    func apiKeyPathSavesAndDismissesLogin() async {
        var initial = LoginFeature.State()
        initial.screen = .apiKeyEntry
        let store = TestStore(
            initialState: initial
        ) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authSetAPIKey = { _, _ in true }
        }

        await store.send(.set(\.apiKey, "sk-ant-test")) {
            $0.apiKey = "sk-ant-test"
        }
        await store.send(.submitAPIKeyButtonTapped) {
            $0.isLoading = true
            $0.errorMessage = nil
        }
        await store.receive(\._apiKeySaved) {
            $0.isLoading = false
            $0.isCompleted = true
        }
        await store.receive(\.delegate)  // .authenticated
    }

    /// Gap (7): replaced withMainSerialExecutor with continuation-based control.
    @Test("no-credential auth.status presents login at launch")
    func noCredentialAuthStatusPresentsLogin() async {
        let (events, eventCont) = AsyncStream<DaemonEvent>.makeStream()
        let (helloStream, helloCont) = AsyncStream<HelloResult>.makeStream()
        let (botsStream, botsCont) = AsyncStream<[Bot]>.makeStream()
        let (authStream, authCont) = AsyncStream<AuthStatusResult>.makeStream()

        let store = TestStore(initialState: AppFeature.State()) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.events = { events }
            $0.daemonClient.hello = { for await v in helloStream { return v }; fatalError() }
            $0.daemonClient.botsList = { for await v in botsStream { return v }; fatalError() }
            $0.daemonClient.authStatus = { for await v in authStream { return v }; fatalError() }
        }

        await store.send(.connectSucceeded) { $0.daemonStatus = .connected }

        // Release auth — no credentials → login sheet presented.
        authCont.yield(stubNoCredentialStatus)
        authCont.finish()
        await store.receive(\.authStatusReceived) { $0.login = LoginFeature.State() }

        // Release bots.
        botsCont.yield([])
        botsCont.finish()
        await store.receive(\.botsLoaded) { $0.hasLoadedBots = true }

        // Release hello.
        helloCont.yield(stubHello)
        helloCont.finish()
        await store.receive(\.helloReceived) { $0.helloResult = stubHello }

        eventCont.finish()
        await store.receive(\.daemonStreamEnded) {
            $0.daemonStatus = .error("Daemon disconnected unexpectedly.")
        }
        await store.finish()
    }

    // MARK: - Notifications

    @Test("message.completed for unselected bot increments unread and posts notification")
    func messageCompletedForUnselectedBotIncrementsUnread() async {
        let notifPosted = LockIsolated(false)
        let completedMessage = Message(
            id: "101",
            role: "assistant",
            text: "Hello!",
            createdAt: Date(timeIntervalSince1970: 1_700_000_100)
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",   // Bot "2" is NOT selected
                daemonStatus: .connected
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.notificationsClient.post = { _, _, _, _ in notifPosted.setValue(true) }
        }

        await store.send(.daemonEvent(.messageCompleted(botID: "2", messageID: "msg-abc", message: completedMessage))) {
            $0.unreadCounts["2"] = 1
        }

        // Notification should have been posted (effect runs async)
        await store.finish()
        #expect(notifPosted.value)
    }

    @Test("message.completed for selected bot with app active does NOT post notification")
    func messageCompletedForSelectedBotDoesNotNotify() async {
        let notifPosted = LockIsolated(false)
        let completedMessage = Message(
            id: "102",
            role: "assistant",
            text: "Hello!",
            createdAt: Date(timeIntervalSince1970: 1_700_000_100)
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                isAppActive: true,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.notificationsClient.post = { _, _, _, _ in notifPosted.setValue(true) }
        }

        // Bot "1" IS selected and app IS active: no unread increment, no notification.
        // The message is still forwarded to the chat child via Effect.send.
        await store.send(.daemonEvent(.messageCompleted(botID: "1", messageID: "msg-xyz", message: completedMessage)))
        await store.receive(\.chat) {
            $0.chat?.messages.append(ChatMessage.from(completedMessage))
        }
        await store.finish()

        // No notification for the currently selected, active bot.
        #expect(!notifPosted.value)
    }

    @Test("message.completed for selected bot but app inactive DOES post notification")
    func messageCompletedAppInactiveNotifies() async {
        let notifPosted = LockIsolated(false)
        let completedMessage = Message(
            id: "103",
            role: "assistant",
            text: "Hello!",
            createdAt: Date(timeIntervalSince1970: 1_700_000_100)
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                isAppActive: false,  // App is in background
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.notificationsClient.post = { _, _, _, _ in notifPosted.setValue(true) }
        }

        // Bot IS selected but app is inactive: unread increments and notification fires.
        // The message is also forwarded to the chat child via Effect.send.
        await store.send(.daemonEvent(.messageCompleted(botID: "1", messageID: "msg-xyz2", message: completedMessage))) {
            $0.unreadCounts["1"] = 1
        }
        await store.receive(\.chat) {
            $0.chat?.messages.append(ChatMessage.from(completedMessage))
        }
        await store.finish()

        #expect(notifPosted.value)
    }

    // MARK: - App activity & unread

    @Test("becoming active clears unread for selected bot")
    func becomingActiveClearsUnread() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "2",
                daemonStatus: .connected,
                unreadCounts: ["2": 3],
                isAppActive: false
            )
        ) {
            AppFeature()
        }

        await store.send(.appActivityChanged(true)) {
            $0.isAppActive = true
            $0.unreadCounts["2"] = nil
        }
    }

    // MARK: - Activity status line

    @Test("bot.activity event updates chat activity state")
    func botActivityUpdatesChat() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.botActivity(botID: "1", activity: .thinking))) {
            $0.botActivities["1"] = .thinking
        }
        await store.receive(\.chat) {
            $0.chat?.activity = .thinking
        }
    }

    @Test("bot.activity event for OTHER bot does not affect chat")
    func botActivityForOtherBotDoesNotAffectChat() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        }

        // Bot "2" is not selected for chat, but botActivities is still updated for sidebar.
        await store.send(.daemonEvent(.botActivity(botID: "2", activity: .thinking))) {
            $0.botActivities["2"] = .thinking
        }
    }

    // MARK: - Per-bot activity tracking

    @Test("bot.activity tracked in botActivities for sidebar")
    func botActivityTrackedPerBot() async {
        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected
            )
        ) {
            AppFeature()
        }

        await store.send(.daemonEvent(.botActivity(botID: "2", activity: .thinking))) {
            $0.botActivities["2"] = .thinking
        }
        await store.send(.daemonEvent(.botActivity(botID: "2", activity: .idle))) {
            $0.botActivities.removeValue(forKey: "2")
        }
    }

    // MARK: - Unread when inactive

    @Test("message.completed for selected bot but app inactive increments unread")
    func messageCompletedInactiveSelectedBotIncrementsUnread() async {
        let completedMessage = Message(
            id: "104",
            role: "assistant",
            text: "Hello!",
            createdAt: Date(timeIntervalSince1970: 1_700_000_100)
        )

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .connected,
                isAppActive: false,
                chat: ChatFeature.State(botID: "1", botName: "Helper")
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.notificationsClient.post = { _, _, _, _ in }
        }

        await store.send(.daemonEvent(.messageCompleted(botID: "1", messageID: "msg-inc", message: completedMessage))) {
            // Bot IS selected but app is inactive — unread should increment.
            $0.unreadCounts["1"] = 1
        }
        // Effect.send dispatches asynchronously; receive the forwarded chat action.
        await store.receive(\.chat) {
            $0.chat?.messages.append(ChatMessage.from(completedMessage))
        }
        // Notification effect runs asynchronously; wait for it to complete.
        await store.finish()
    }

    // MARK: - Reconnect history reload

    /// Gap (7): replaced withMainSerialExecutor with continuation-based control.
    @Test("connectionChanged(.reconnected) notifies chat to reload history")
    func reconnectedNotifiesChatToReload() async {
        let (helloStream, helloCont) = AsyncStream<HelloResult>.makeStream()
        let (botsStream, botsCont) = AsyncStream<[Bot]>.makeStream()
        let (historyStream, historyCont) = AsyncStream<[Message]>.makeStream()

        var chatState = ChatFeature.State(botID: "1", botName: "Helper")
        chatState.isHistoryLoading = false

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                selectedBotID: "1",
                daemonStatus: .restarting(attempt: 1),
                chat: chatState
            )
        ) {
            AppFeature()
        } withDependencies: { [historyStream] in
            $0.daemonClient.hello = { for await v in helloStream { return v }; fatalError() }
            $0.daemonClient.botsList = { for await v in botsStream { return v }; fatalError() }
            $0.daemonClient.botsHistory = { _ in
                for await v in historyStream { return v }
                fatalError()
            }
        }

        await store.send(.daemonEvent(.connectionChanged(.reconnected))) {
            $0.daemonStatus = .connected
        }

        // chat(.reconnected) is dispatched via Effect.send — arrives before the suspended effects.
        await store.receive(\.chat) { $0.chat?.isHistoryLoading = true }

        // Release hello then bots in an explicit order (no reverse-merge-order assumption).
        helloCont.yield(stubHello)
        helloCont.finish()
        await store.receive(\.helloReceived) { $0.helloResult = stubHello }

        botsCont.yield(stubBots)
        botsCont.finish()
        await store.receive(\.botsLoaded) { $0.hasLoadedBots = true }

        // History reload completes with empty snapshot.
        historyCont.yield([])
        historyCont.finish()
        await store.receive(\.chat) { $0.chat?.isHistoryLoading = false }
        await store.finish()
    }

    // MARK: - Login session dismiss cancels login

    @Test("dismissing login sheet (not via Cancel) sends auth.cancel")
    func loginSheetDismissSendsAuthCancel() async {
        let cancelCalled = LockIsolated(false)

        var loginState = LoginFeature.State()
        loginState.loginID = "login-dismiss-1"
        loginState.screen = .oauthInProgress

        let store = TestStore(
            initialState: AppFeature.State(
                bots: IdentifiedArray(uniqueElements: stubBots),
                daemonStatus: .connected,
                login: loginState
            )
        ) {
            AppFeature()
        } withDependencies: {
            $0.daemonClient.authCancel = { _ in cancelCalled.setValue(true); return true }
        }

        // Simulate external sheet dismiss (e.g., drag-to-dismiss).
        await store.send(.login(.dismiss)) {
            $0.login = nil
        }
        await store.finish()
        #expect(cancelCalled.value)
    }

    // MARK: - Connectors sheet

    @Test("Connectors menu item presents the sheet")
    func connectorsMenuPresentsSheet() async {
        let store = TestStore(initialState: AppFeature.State(daemonStatus: .connected)) {
            AppFeature()
        }
        await store.send(.connectorsMenuItemTapped) {
            $0.connectors = ConnectorsFeature.State()
        }
    }

    @Test("connector events are forwarded only while the sheet is presented")
    func connectorEventsForwardedWhilePresented() async {
        let opened = LockIsolated<[URL]>([])
        let updated = Connector(id: "sentry", name: "Sentry", status: .connected)

        // Not presented: events are dropped.
        let closed = TestStore(initialState: AppFeature.State(daemonStatus: .connected)) {
            AppFeature()
        } withDependencies: {
            $0.openURL = OpenURLEffect { url in
                opened.withValue { $0.append(url) }
                return true
            }
        }
        await closed.send(.daemonEvent(.connectorSignInURL(connectorID: "sentry", url: "https://example.com/a")))
        await closed.send(.daemonEvent(.connectorUpdated(updated)))
        #expect(opened.value.isEmpty)

        // Presented: updates and the URL reach the child.
        var connectors = ConnectorsFeature.State()
        connectors.signingInID = "sentry"
        let open = TestStore(initialState: AppFeature.State(daemonStatus: .connected, connectors: connectors)) {
            AppFeature()
        } withDependencies: {
            $0.openURL = OpenURLEffect { url in
                opened.withValue { $0.append(url) }
                return true
            }
        }
        await open.send(.daemonEvent(.connectorSignInURL(connectorID: "sentry", url: "https://example.com/a")))
        await open.receive(\.connectors.presented.signInURLReceived)
        await open.send(.daemonEvent(.connectorUpdated(updated)))
        await open.receive(\.connectors.presented.connectorUpdated) {
            $0.connectors?.connectors = [updated]
            $0.connectors?.signingInID = nil
        }
        await open.finish()
        #expect(opened.value.map(\.absoluteString) == ["https://example.com/a"])
    }
}
