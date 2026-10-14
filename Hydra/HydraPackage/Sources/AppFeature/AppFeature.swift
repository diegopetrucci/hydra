import ComposableArchitecture
import DaemonClient
import IdentifiedCollections
import SwiftUI
import TipKit

// MARK: - AppFeature

@Reducer
public struct AppFeature {

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        public var bots: IdentifiedArrayOf<Bot> = []
        public var selectedBotID: String?
        public var daemonStatus: DaemonStatus = .connecting
        public var helloResult: HelloResult?
        public var unreadCounts: [String: Int] = [:]
        public var isAppActive: Bool = true
        /// Per-bot activity state for the sidebar activity indicator.
        public var botActivities: [String: BotActivity] = [:]
        /// True once `appLaunched` has been sent; makes the action idempotent so
        /// reopening the window (or a second send) does not reconnect the daemon.
        public var isLaunched: Bool = false
        /// True while a provider credential is believed to exist; drives the new-bot tip.
        public var isSignedIn: Bool = false
        /// True once the first bot list has arrived, so an empty `bots` is trustworthy.
        public var hasLoadedBots: Bool = false

        // Child features
        public var chat: ChatFeature.State?
        @Presents public var newBot: NewBotFeature.State?
        @Presents public var login: LoginFeature.State?
        @Presents public var connectors: ConnectorsFeature.State?

        public enum DaemonStatus: Equatable {
            case connecting
            case connected
            /// Daemon exited unexpectedly; a restart is in progress.
            case restarting(attempt: Int)
            case error(String)
        }

        public init(
            bots: IdentifiedArrayOf<Bot> = [],
            selectedBotID: String? = nil,
            daemonStatus: DaemonStatus = .connecting,
            helloResult: HelloResult? = nil,
            unreadCounts: [String: Int] = [:],
            isAppActive: Bool = true,
            botActivities: [String: BotActivity] = [:],
            isLaunched: Bool = false,
            isSignedIn: Bool = false,
            hasLoadedBots: Bool = false,
            chat: ChatFeature.State? = nil,
            newBot: NewBotFeature.State? = nil,
            login: LoginFeature.State? = nil,
            connectors: ConnectorsFeature.State? = nil
        ) {
            self.bots = bots
            self.selectedBotID = selectedBotID
            self.daemonStatus = daemonStatus
            self.helloResult = helloResult
            self.unreadCounts = unreadCounts
            self.isAppActive = isAppActive
            self.botActivities = botActivities
            self.isLaunched = isLaunched
            self.isSignedIn = isSignedIn
            self.hasLoadedBots = hasLoadedBots
            self.chat = chat
            self.newBot = newBot
            self.login = login
            self.connectors = connectors
        }

        /// Whether the "Create a bot" tip should show: signed in, bot list loaded, no bots.
        public var isNewBotTipEligible: Bool {
            isSignedIn && hasLoadedBots && bots.isEmpty
        }
    }

    // MARK: - Action

    public enum Action {
        // Lifecycle
        /// Sent once at store creation (from HydraApp.init, behind isTesting).
        /// Idempotent: a second send is a no-op, so reopening the window never
        /// reconnects the daemon or resubscribes to long-lived streams.
        case appLaunched
        case appActivityChanged(Bool)
        case connectSucceeded
        case connectFailed(String)
        case helloReceived(HelloResult)
        case helloFailed(String)
        case botsLoaded([Bot])
        case botsLoadFailed(String)
        case authStatusReceived(AuthStatusResult)
        case daemonEvent(DaemonEvent)
        case daemonStreamEnded

        // Navigation
        case botSelected(String?)
        case notificationTapped(botID: String)

        // Menu / toolbar
        case newBotButtonTapped
        case newBotSheetDismissed
        case signOutMenuItemTapped
        case connectorsMenuItemTapped

        // Child features
        case chat(ChatFeature.Action)
        case newBot(PresentationAction<NewBotFeature.Action>)
        case login(PresentationAction<LoginFeature.Action>)
        case connectors(PresentationAction<ConnectorsFeature.Action>)
    }

    // MARK: - Dependencies

    @Dependency(\.daemonClient) var daemonClient
    @Dependency(\.notificationsClient) var notificationsClient
    @Dependency(\.appActivityClient) var appActivityClient
    @Dependency(\.appWindowClient) var appWindowClient
    @Dependency(\.date.now) var now

    // MARK: - Cancel IDs

    private enum CancelID { case eventStream, activityStream, notificationTaps }

    // MARK: - Init

    public init() {}

    // MARK: - Body

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            reduceCore(into: &state, action: action)
        }
        .ifLet(\.chat, action: \.chat) {
            ChatFeature()
        }
        .ifLet(\.$newBot, action: \.newBot) {
            NewBotFeature()
        }
        .ifLet(\.$login, action: \.login) {
            LoginFeature()
        }
        .ifLet(\.$connectors, action: \.connectors) {
            ConnectorsFeature()
        }
    }

    // MARK: - Core reducer

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func reduceCore(into state: inout State, action: Action) -> Effect<Action> {
        switch action {

        // MARK: Lifecycle

        case .appLaunched:
            // Idempotent: only run effects once for the store's lifetime.
            // A second call (e.g. window reopened) must not reconnect or resubscribe.
            guard !state.isLaunched else { return .none }
            state.isLaunched = true
            return .merge(
                .run { [daemonClient] send in
                    do {
                        try await daemonClient.connect()
                        await send(.connectSucceeded)
                    } catch {
                        await send(.connectFailed(error.localizedDescription))
                    }
                },
                .run { [notificationsClient] _ in
                    _ = try? await notificationsClient.requestAuthorization()
                },
                .run { [notificationsClient] send in
                    for await botID in notificationsClient.tappedBotIDs() {
                        await send(.notificationTapped(botID: botID))
                    }
                }
                .cancellable(id: CancelID.notificationTaps),
                .run { [appActivityClient] send in
                    for await isActive in appActivityClient.changes() {
                        await send(.appActivityChanged(isActive))
                    }
                }
                .cancellable(id: CancelID.activityStream)
            )

        case .appActivityChanged(let isActive):
            state.isAppActive = isActive
            // Clear unread for the selected bot when app becomes active
            if isActive, let selectedID = state.selectedBotID {
                state.unreadCounts[selectedID] = nil
            }
            return .none

        case .connectSucceeded:
            state.daemonStatus = .connected
            return launchDaemonEffects()

        case .connectFailed(let message):
            state.daemonStatus = .error(message)
            return .none

        case .helloReceived(let result):
            state.helloResult = result
            return .none

        case .helloFailed(let message):
            state.daemonStatus = .error(message)
            return .none

        case .botsLoaded(let bots):
            state.bots = IdentifiedArray(uniqueElements: bots)
            state.hasLoadedBots = true
            return .none

        case .botsLoadFailed(let message):
            state.daemonStatus = .error(message)
            return .none

        case .authStatusReceived(let status):
            let hasCredential = status.providers.contains { $0.type != nil }
            state.isSignedIn = hasCredential
            if !hasCredential {
                state.login = LoginFeature.State()
            }
            return .none

        // MARK: Navigation

        case .botSelected(let botID):
            guard state.selectedBotID != botID else { return .none }
            state.selectedBotID = botID
            if let id = botID, let bot = state.bots[id: id] {
                state.chat = ChatFeature.State(botID: id, botName: bot.name)
                // Clear unread if app is active
                if state.isAppActive {
                    state.unreadCounts[id] = nil
                }
            } else {
                state.chat = nil
            }
            return .none

        case .notificationTapped(let botID):
            return .merge(
                .run { [appWindowClient] _ in await appWindowClient.openMain() },
                .send(.botSelected(botID))
            )

        // MARK: Menu / toolbar

        case .newBotSheetDismissed:
            // The sheet may have taken keyboard focus; hand it back to the open chat.
            guard state.chat != nil else { return .none }
            return .send(.chat(.composerFocusRequested))

        case .newBotButtonTapped:
            state.newBot = NewBotFeature.State()
            return .none

        case .signOutMenuItemTapped:
            state.isSignedIn = false
            return .run { [daemonClient] _ in
                _ = try? await daemonClient.authLogout("anthropic")
            }

        case .connectorsMenuItemTapped:
            state.connectors = ConnectorsFeature.State()
            return .none

        // MARK: Daemon events

        case .daemonEvent(let event):
            return reduceDaemonEvent(into: &state, event: event)

        case .daemonStreamEnded:
            state.daemonStatus = .error("Daemon disconnected unexpectedly.")
            return .none

        // MARK: Child: chat delegate

        case .chat(.delegate(.authRequired)):
            state.isSignedIn = false
            state.login = LoginFeature.State()
            return .none

        // MARK: Child: newBot delegate

        case .newBot(.presented(.delegate(.botCreated(let bot)))):
            state.bots[id: bot.id] = bot
            state.newBot = nil
            return .send(.botSelected(bot.id))

        // MARK: Child: login delegate

        case .login(.presented(.delegate(.authenticated))):
            state.isSignedIn = true
            state.login = nil
            return .none

        // MARK: Pass-through child actions

        case .login(.dismiss):
            // Sheet dismissed by any means (drag, system, or Cancel button).
            // Cancel the in-flight login if a loginID exists AND Cancel didn't already clear it.
            if let loginID = state.login?.loginID {
                let client = daemonClient
                return .run { _ in _ = try? await client.authCancel(loginID) }
            }
            return .none

        case .chat, .newBot, .login, .connectors:
            return .none
        }
    }

    // MARK: - Daemon event routing

    private func reduceDaemonEvent(into state: inout State, event: DaemonEvent) -> Effect<Action> {
        switch event {

        case .botUpdated(let bot):
            state.bots[id: bot.id] = bot
            return .none

        case .messageStarted(let botID, let messageID):
            guard state.chat?.botID == botID else { return .none }
            return .send(.chat(.messageStarted(messageID: messageID)))

        case .messageDelta(let botID, let messageID, let text):
            guard state.chat?.botID == botID else { return .none }
            return .send(.chat(.messageDeltaReceived(messageID: messageID, text: text)))

        case .messageCompleted(let botID, let messageID, let message):
            var effects: [Effect<Action>] = []

            // Route to chat if selected
            if state.chat?.botID == botID {
                effects.append(.send(.chat(.messageCompleted(messageID: messageID, message: message))))
            }

            // Unread count: increment when bot is not selected OR app is inactive
            let isSelected = state.selectedBotID == botID
            if !isSelected || !state.isAppActive {
                state.unreadCounts[botID, default: 0] += 1
            }

            // Notification: post when not selected or app is inactive
            if !isSelected || !state.isAppActive {
                let botName = state.bots[id: botID]?.name ?? "Bot"
                let body = String(message.text.prefix(120))
                let notifID = message.id
                effects.append(.run { [notificationsClient, botName, body, notifID, botID] _ in
                    await notificationsClient.post(notifID, botName, body, botID)
                })
            }

            return effects.isEmpty ? .none : .merge(effects)

        case .botActivity(let botID, let activity):
            // Track per-bot activity for sidebar indicator.
            if activity == .idle {
                state.botActivities.removeValue(forKey: botID)
            } else {
                state.botActivities[botID] = activity
            }
            guard state.chat?.botID == botID else { return .none }
            return .send(.chat(.activityChanged(activity)))

        case .botError(let botID, let code, let message):
            var effects: [Effect<Action>] = []
            if state.chat?.botID == botID {
                effects.append(.send(.chat(.botErrorReceived(code: code, message: message))))
            }
            if code == "auth_required" {
                state.isSignedIn = false
                state.login = LoginFeature.State()
            }
            return effects.isEmpty ? .none : .merge(effects)

        case .authURL(let loginID, let url, let instructions):
            guard state.login != nil else { return .none }
            // Filter stale events: accept when loginID matches or is not yet known in the child.
            let activeLoginID = state.login?.loginID
            guard activeLoginID == nil || activeLoginID == loginID else { return .none }
            return .send(.login(.presented(.authURLReceived(loginID: loginID, url: url, instructions: instructions))))

        case .authPrompt(let loginID, let promptID, let kind, let message, let placeholder, let options):
            guard state.login != nil else { return .none }
            let activeLoginID = state.login?.loginID
            guard activeLoginID == nil || activeLoginID == loginID else { return .none }
            return .send(.login(.presented(.promptReceived(
                loginID: loginID,
                promptID: promptID,
                kind: kind,
                message: message,
                placeholder: placeholder,
                options: options
            ))))

        case .authCompleted(let loginID, let providerID):
            guard state.login != nil else { return .none }
            let activeLoginID = state.login?.loginID
            guard activeLoginID == nil || activeLoginID == loginID else { return .none }
            return .send(.login(.presented(.completed(loginID: loginID, providerID: providerID))))

        case .authFailed(let loginID, let message):
            guard state.login != nil else { return .none }
            let activeLoginID = state.login?.loginID
            guard activeLoginID == nil || activeLoginID == loginID else { return .none }
            return .send(.login(.presented(.loginFailed(loginID: loginID, message: message))))

        case .authInfo:
            return .none

        case .connectorSignInURL(let connectorID, let url):
            guard state.connectors != nil else { return .none }
            return .send(.connectors(.presented(.signInURLReceived(connectorID: connectorID, url: url))))

        case .connectorUpdated(let connector):
            guard state.connectors != nil else { return .none }
            return .send(.connectors(.presented(.connectorUpdated(connector))))

        case .connectionChanged(.restarting(let attempt)):
            state.daemonStatus = .restarting(attempt: attempt)
            return .none

        case .connectionChanged(.reconnected):
            state.daemonStatus = .connected
            // Clear per-bot transient activity (streaming / tool states are invalid after reconnect).
            state.botActivities = [:]
            var effects: [Effect<Action>] = [
                .run { [daemonClient] send in
                    do {
                        let result = try await daemonClient.hello()
                        await send(.helloReceived(result))
                    } catch {
                        await send(.helloFailed(error.localizedDescription))
                    }
                },
                .run { [daemonClient] send in
                    do {
                        let bots = try await daemonClient.botsList()
                        await send(.botsLoaded(bots))
                    } catch {
                        await send(.botsLoadFailed(error.localizedDescription))
                    }
                },
            ]
            // Notify the chat feature so it clears transient state and reloads history.
            if state.chat != nil {
                effects.append(.send(.chat(.reconnected)))
            }
            return .merge(effects)

        case .unknown:
            return .none
        }
    }

    // MARK: - Helpers

    private func launchDaemonEffects() -> Effect<Action> {
        .merge(
            .run { [daemonClient] send in
                let stream = daemonClient.events()
                for await event in stream {
                    await send(.daemonEvent(event))
                }
                await send(.daemonStreamEnded)
            }
            .cancellable(id: CancelID.eventStream),

            .run { [daemonClient] send in
                do {
                    let result = try await daemonClient.hello()
                    await send(.helloReceived(result))
                } catch {
                    await send(.helloFailed(error.localizedDescription))
                }
            },

            .run { [daemonClient] send in
                do {
                    let bots = try await daemonClient.botsList()
                    await send(.botsLoaded(bots))
                } catch {
                    await send(.botsLoadFailed(error.localizedDescription))
                }
            },

            .run { [daemonClient] send in
                do {
                    let status = try await daemonClient.authStatus()
                    await send(.authStatusReceived(status))
                } catch {
                    // Non-critical; skip the login prompt if status check fails.
                }
            }
        )
    }
}

// MARK: - AppFeatureView

public struct AppFeatureView: View {
    @Bindable var store: StoreOf<AppFeature>
    private let newBotTip = NewBotTip()

    public init(store: StoreOf<AppFeature>) {
        self.store = store
    }

    public var body: some View {
        Group {
            switch store.daemonStatus {
            case .connecting:
                ProgressView("Connecting to daemon…").padding()

            case .connected, .restarting:
                mainView

            case .error(let message):
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.red)
                    Text("Daemon Error").font(.headline)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding()
            }
        }
        // NOTE: .appLaunched is fired once from HydraApp.init (store lifetime),
        // not here, so closing the window cannot cancel long-lived app effects.
        .sheet(
            item: $store.scope(state: \.newBot, action: \.newBot),
            onDismiss: { store.send(.newBotSheetDismissed) }
        ) { newBotStore in
            NewBotFeatureView(store: newBotStore)
        }
        .sheet(item: $store.scope(state: \.login, action: \.login)) { loginStore in
            LoginFeatureView(store: loginStore)
        }
        .sheet(item: $store.scope(state: \.connectors, action: \.connectors)) { connectorsStore in
            ConnectorsFeatureView(store: connectorsStore)
        }
    }

    // MARK: - Main NavigationSplitView

    private var mainView: some View {
        NavigationSplitView {
            sidebarView
        } detail: {
            if let chatStore = store.scope(state: \.chat, action: \.chat) {
                ChatFeatureView(store: chatStore)
            } else if store.bots.isEmpty {
                ContentUnavailableView(
                    "No Bots Yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Create a bot to get started.")
                )
            } else {
                ContentUnavailableView(
                    "Select a Bot",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Choose a bot from the sidebar, or create a new one.")
                )
            }
        }
        .overlay(alignment: .top) {
            if case .restarting(let attempt) = store.daemonStatus {
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.7)
                    Text("Reconnecting… (attempt \(attempt))")
                        .font(.footnote)
                }
                .padding(8)
                .background(.regularMaterial)
                .clipShape(Capsule())
                .padding(.top, 8)
            }
        }
    }

    // MARK: - Sidebar

    private var sidebarView: some View {
        List(store.bots.sorted(by: sortByLastActivity)) { bot in
            Button {
                store.send(.botSelected(bot.id))
            } label: {
                BotRowView(
                    bot: bot,
                    isSelected: store.selectedBotID == bot.id,
                    unreadCount: store.unreadCounts[bot.id] ?? 0,
                    isActive: store.botActivities[bot.id] != nil
                )
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .listRowBackground(store.selectedBotID == bot.id ? Color.accentColor.opacity(0.15) : Color.clear)
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        .navigationTitle("Bots")
        .onChange(of: store.isNewBotTipEligible, initial: true) { _, isEligible in
            NewBotTip.isEligible = isEligible
        }
        .toolbar {
            ToolbarItem {
                Button {
                    newBotTip.invalidate(reason: .actionPerformed)
                    store.send(.newBotButtonTapped)
                } label: {
                    Image(systemName: "plus")
                }
                .popoverTip(newBotTip, arrowEdge: .top)
            }
            ToolbarItem {
                Menu {
                    Button("Connectors…") { store.send(.connectorsMenuItemTapped) }
                    Button("Sign Out") { store.send(.signOutMenuItemTapped) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    private func sortByLastActivity(_ a: Bot, _ b: Bot) -> Bool {
        let aDate = a.lastMessageAt ?? a.createdAt
        let bDate = b.lastMessageAt ?? b.createdAt
        return aDate > bDate
    }
}

// MARK: - BotRowView

private struct BotRowView: View {
    let bot: Bot
    let isSelected: Bool
    let unreadCount: Int
    let isActive: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            BotAvatar(id: bot.id, name: bot.name, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                    .font(.headline)
                    .lineLimit(1)
                if let preview = bot.lastMessagePreview {
                    Text(plainPreview(preview))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let date = bot.lastMessageAt {
                    Text(date.formatted(.relative(presentation: .named)))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if isActive {
                ProgressView()
                    .scaleEffect(0.65)
                    .frame(width: 16, height: 16)
            }
            if unreadCount > 0 {
                Text("\(unreadCount)")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.blue, in: Capsule())
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Connected — bots") {
    AppFeatureView(
        store: Store(
            initialState: AppFeature.State(
                bots: [
                    Bot(
                        id: "1",
                        name: "Helper Bot",
                        instructions: "Be helpful.",
                        model: "anthropic/claude-sonnet-5-5",
                        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                        lastMessagePreview: "Hello! How can I help?"
                    ),
                ],
                daemonStatus: .connected
            )
        ) {
            AppFeature()
        }
    )
}

#Preview("Connected — no bots") {
    AppFeatureView(
        store: Store(
            initialState: AppFeature.State(
                daemonStatus: .connected,
                isSignedIn: true,
                hasLoadedBots: true
            )
        ) {
            AppFeature()
        }
    )
}

#Preview("Connecting") {
    AppFeatureView(
        store: Store(initialState: AppFeature.State(daemonStatus: .connecting)) {
            AppFeature()
        }
    )
}

#Preview("Restarting") {
    AppFeatureView(
        store: Store(initialState: AppFeature.State(daemonStatus: .restarting(attempt: 2))) {
            AppFeature()
        }
    )
}

#Preview("Error") {
    AppFeatureView(
        store: Store(
            initialState: AppFeature.State(
                daemonStatus: .error("Run `npm run build` in daemon/.")
            )
        ) {
            AppFeature()
        }
    )
}
#endif
