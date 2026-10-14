import ComposableArchitecture
import DaemonClient
import Foundation
import SwiftUI

// MARK: - LoginFeature

@Reducer
public struct LoginFeature {

    // MARK: - Screen

    public enum Screen: Equatable, Sendable {
        case chooser
        case oauthInProgress
        case apiKeyEntry
    }

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        public var screen: Screen = .chooser

        // OAuth
        public var loginID: String?
        /// True while `auth.login` is still in flight (no loginID yet).
        /// Prevents stale auth events from a previous session being accepted as wildcards.
        public var isPendingLoginStart: Bool = false
        /// True when the user cancelled while `auth.login` was still in flight.
        /// `_loginStarted` will cancel the returned loginID immediately.
        public var shouldCancelOnStart: Bool = false
        public var oauthURL: String?
        public var oauthInstructions: String?
        public var pendingPromptID: String?
        public var pendingPromptMessage: String?
        public var pendingPromptKind: String?
        public var pendingPromptPlaceholder: String?
        /// Non-nil for `kind == "select"` prompts.
        public var pendingOptions: [AuthPromptOption]?
        public var promptResponse: String = ""

        // API key
        public var apiKey: String = ""

        // Common
        public var isLoading: Bool = false
        public var errorMessage: String?
        public var isCompleted: Bool = false

        public init() {}
    }

    // MARK: - Action

    public enum Action: BindableAction {
        case binding(BindingAction<State>)

        // User intent
        case signInWithClaudeButtonTapped
        case useAPIKeyButtonTapped
        case openInBrowserButtonTapped
        case submitAPIKeyButtonTapped
        case submitPromptButtonTapped
        case cancelButtonTapped

        // Daemon events forwarded from AppFeature
        case authURLReceived(loginID: String, url: String, instructions: String?)
        case promptReceived(loginID: String, promptID: String, kind: String, message: String, placeholder: String?, options: [AuthPromptOption]?)
        case completed(loginID: String, providerID: String)
        case loginFailed(loginID: String, message: String)

        // OAuth select-prompt option tapped
        case selectOptionTapped(id: String)

        // Effects
        case _loginStarted(loginID: String)
        case _loginStartFailed(String)
        case _apiKeySaved
        case _apiKeySaveFailed(String)
        /// Carries the promptID that was responded to; only clears prompt fields
        /// if the current pendingPromptID still matches (no racing new prompt).
        case _promptSent(promptID: String)
        case _promptSendFailed(String)

        // Delegate
        case delegate(Delegate)

        public enum Delegate: Equatable {
            case authenticated
        }
    }

    // MARK: - Dependencies

    @Dependency(\.daemonClient) var daemonClient
    @Dependency(\.openURL) var openURL
    @Dependency(\.dismiss) var dismiss

    // MARK: - Init

    public init() {}

    // MARK: - Body

    public var body: some Reducer<State, Action> {
        BindingReducer()
        Reduce { state, action in
            switch action {

            case .binding:
                return .none

            // MARK: OAuth

            case .signInWithClaudeButtonTapped:
                state.screen = .oauthInProgress
                state.isLoading = true
                state.isPendingLoginStart = true
                state.errorMessage = nil
                let client = daemonClient
                return .run { send in
                    do {
                        let loginID = try await client.authLogin("anthropic", "oauth")
                        await send(._loginStarted(loginID: loginID))
                    } catch {
                        await send(._loginStartFailed(error.localizedDescription))
                    }
                }

            case ._loginStarted(let loginID):
                state.isPendingLoginStart = false
                if state.shouldCancelOnStart {
                    // The user cancelled before we got the loginID. Cancel it immediately.
                    state.shouldCancelOnStart = false
                    let client = daemonClient
                    return .run { _ in _ = try? await client.authCancel(loginID) }
                }
                state.loginID = loginID
                state.isLoading = false
                return .none

            case ._loginStartFailed(let message):
                state.isPendingLoginStart = false
                state.shouldCancelOnStart = false
                state.isLoading = false
                state.errorMessage = message
                return .none

            case .openInBrowserButtonTapped:
                guard let urlString = state.oauthURL,
                      let url = URL(string: urlString) else { return .none }
                let openURL = openURL
                return .run { _ in await openURL(url) }

            case .submitPromptButtonTapped:
                guard let loginID = state.loginID,
                      let promptID = state.pendingPromptID else { return .none }
                let value = state.promptResponse
                state.isLoading = true
                let client = daemonClient
                return .run { send in
                    do {
                        _ = try await client.authRespond(loginID, promptID, value)
                        await send(._promptSent(promptID: promptID))
                    } catch {
                        await send(._promptSendFailed(error.localizedDescription))
                    }
                }

            case ._promptSent(let respondedPromptID):
                state.isLoading = false
                state.promptResponse = ""
                // Only clear prompt fields if they still correspond to the prompt we responded to.
                // A racing auth.prompt event may have already stored a new prompt; preserve it.
                if state.pendingPromptID == respondedPromptID {
                    state.pendingPromptID = nil
                    state.pendingPromptMessage = nil
                    state.pendingPromptKind = nil
                    state.pendingPromptPlaceholder = nil
                    state.pendingOptions = nil
                }
                return .none

            case ._promptSendFailed(let message):
                state.isLoading = false
                state.errorMessage = message
                return .none

            // MARK: API Key

            case .useAPIKeyButtonTapped:
                state.screen = .apiKeyEntry
                state.errorMessage = nil
                return .none

            case .submitAPIKeyButtonTapped:
                let key = state.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty else {
                    state.errorMessage = "API key is required."
                    return .none
                }
                state.isLoading = true
                state.errorMessage = nil
                let client = daemonClient
                return .run { send in
                    do {
                        _ = try await client.authSetAPIKey("anthropic", key)
                        await send(._apiKeySaved)
                    } catch {
                        await send(._apiKeySaveFailed(error.localizedDescription))
                    }
                }

            case ._apiKeySaved:
                state.isLoading = false
                state.isCompleted = true
                let dismiss = dismiss
                return .run { send in
                    await send(.delegate(.authenticated))
                    await dismiss()
                }

            case ._apiKeySaveFailed(let message):
                state.isLoading = false
                state.errorMessage = message
                return .none

            // MARK: Cancel

            case .cancelButtonTapped:
                let loginIDToCancel = state.loginID
                // Nil the loginID synchronously so AppFeature's .login(.dismiss) handler
                // does not issue a double auth.cancel.
                state.loginID = nil
                if loginIDToCancel == nil && state.isPendingLoginStart {
                    // auth.login is still in flight; mark that we should cancel the
                    // returned loginID when _loginStarted fires.
                    state.shouldCancelOnStart = true
                }
                let client = daemonClient
                let dismiss = dismiss
                return .run { _ in
                    if let loginID = loginIDToCancel {
                        _ = try? await client.authCancel(loginID)
                    }
                    await dismiss()
                }

            case .selectOptionTapped(let optionID):
                guard let loginID = state.loginID,
                      let promptID = state.pendingPromptID else { return .none }
                state.isLoading = true
                // Clear the select prompt fields synchronously so the UI updates immediately.
                // Note: _promptSent carries this promptID and will NOT re-clear a racing
                // new prompt that may arrive before the acknowledgement.
                state.pendingPromptID = nil
                state.pendingPromptKind = nil
                state.pendingPromptMessage = nil
                state.pendingOptions = nil
                let selectClient = daemonClient
                return .run { send in
                    do {
                        _ = try await selectClient.authRespond(loginID, promptID, optionID)
                        await send(._promptSent(promptID: promptID))
                    } catch {
                        await send(._promptSendFailed(error.localizedDescription))
                    }
                }

            // MARK: Daemon events (from AppFeature)

            case .authURLReceived(let loginID, let url, let instructions):
                // Accept if loginID matches, or if we're still waiting for our loginID
                // (isPendingLoginStart guards against wildcard matches before login starts).
                guard state.loginID == loginID || (state.loginID == nil && state.isPendingLoginStart) else { return .none }
                state.oauthURL = url
                state.oauthInstructions = instructions
                // Gap (5): automatically open the browser when the URL arrives.
                guard let urlObj = URL(string: url) else { return .none }
                let openURL = openURL
                return .run { _ in await openURL(urlObj) }

            case .promptReceived(let loginID, let promptID, let kind, let message, let placeholder, let options):
                guard state.loginID == loginID || (state.loginID == nil && state.isPendingLoginStart) else { return .none }
                state.pendingPromptID = promptID
                state.pendingPromptKind = kind
                state.pendingPromptMessage = message
                state.pendingPromptPlaceholder = placeholder
                state.pendingOptions = options
                state.isLoading = false
                return .none

            case .completed(let loginID, _):
                // Ignore when no login is in progress: loginID must be known OR a start is pending.
                guard state.loginID == loginID || (state.loginID == nil && state.isPendingLoginStart) else { return .none }
                state.isCompleted = true
                let dismiss = dismiss
                return .run { send in
                    await send(.delegate(.authenticated))
                    await dismiss()
                }

            case .loginFailed(let loginID, let message):
                // Ignore when no login is in progress: loginID must be known OR a start is pending.
                guard state.loginID == loginID || (state.loginID == nil && state.isPendingLoginStart) else { return .none }
                state.isLoading = false
                state.errorMessage = message
                return .none

            case .delegate:
                // Handled by parent
                return .none
            }
        }
    }
}

// MARK: - LoginFeatureView

public struct LoginFeatureView: View {
    @Bindable var store: StoreOf<LoginFeature>

    public init(store: StoreOf<LoginFeature>) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            Group {
                switch store.screen {
                case .chooser:
                    chooserView
                case .oauthInProgress:
                    oauthView
                case .apiKeyEntry:
                    apiKeyView
                }
            }
            .navigationTitle("Sign In")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { store.send(.cancelButtonTapped) }
                }
            }
        }
        .frame(minWidth: 360, minHeight: 240)
    }

    // MARK: Chooser

    private var chooserView: some View {
        VStack(spacing: 20) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.system(size: 48))
                .foregroundStyle(.blue)

            Text("Sign in to use Claude")
                .font(.headline)

            VStack(spacing: 10) {
                Button("Sign in with Claude") {
                    store.send(.signInWithClaudeButtonTapped)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button("Use API Key") {
                    store.send(.useAPIKeyButtonTapped)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }

            if let error = store.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.caption)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(40)
    }

    // MARK: OAuth in progress

    private var oauthView: some View {
        VStack(spacing: 16) {
            // Show a spinner only while waiting for the first event from the daemon.
            if store.isLoading && store.oauthURL == nil && store.pendingPromptKind == nil {
                ProgressView("Starting login…")
            } else {
                // "select" prompt: shown before auth.url so the user can pick a login method.
                if store.pendingPromptKind == "select",
                   let options = store.pendingOptions {
                    if let msg = store.pendingPromptMessage {
                        Text(msg).font(.subheadline).multilineTextAlignment(.center)
                    }
                    ForEach(options) { option in
                        VStack(spacing: 2) {
                            Button(option.label) { store.send(.selectOptionTapped(id: option.id)) }
                                .buttonStyle(.bordered)
                                .controlSize(.large)
                            if let desc = option.description {
                                Text(desc).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if store.isLoading { ProgressView() }
                }

                // URL section — shown after the user has chosen a browser-flow option.
                // The browser is opened automatically when auth.url is received; this
                // button lets the user re-open it if needed.
                if store.oauthURL != nil {
                    Text(store.oauthInstructions ?? "Open the link below to sign in.")
                        .multilineTextAlignment(.center)
                        .font(.subheadline)

                    Button("Open in Browser") {
                        store.send(.openInBrowserButtonTapped)
                    }
                    .buttonStyle(.borderedProminent)
                }

                // Gap (5): text / secret / manual_code prompts are shown whether or not
                // a URL has arrived, because they may race the auth.url event.
                if let promptMessage = store.pendingPromptMessage,
                   store.pendingPromptKind != "select" {
                    Divider()
                    Text(promptMessage)
                        .font(.subheadline)
                    if store.pendingPromptKind == "secret" {
                        SecureField(store.pendingPromptPlaceholder ?? "", text: $store.promptResponse)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        TextField(store.pendingPromptPlaceholder ?? "", text: $store.promptResponse)
                            .textFieldStyle(.roundedBorder)
                    }
                    if store.isLoading {
                        ProgressView()
                    } else {
                        Button("Submit") { store.send(.submitPromptButtonTapped) }
                            .buttonStyle(.bordered)
                            .disabled(store.promptResponse.isEmpty)
                    }
                } else if store.isLoading && store.oauthURL != nil {
                    ProgressView("Completing…")
                }

                if let url = store.oauthURL {
                    Text(url)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .textSelection(.enabled)
                }
            }

            if let error = store.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.caption)
            }
        }
        .padding(32)
    }

    // MARK: API key

    private var apiKeyView: some View {
        VStack(spacing: 16) {
            Text("Paste your Anthropic API key below.")
                .font(.subheadline)
                .multilineTextAlignment(.center)

            SecureField("sk-ant-…", text: $store.apiKey)
                .textFieldStyle(.roundedBorder)

            if store.isLoading {
                ProgressView()
            } else {
                Button("Save API Key") { store.send(.submitAPIKeyButtonTapped) }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let error = store.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.caption)
            }
        }
        .padding(32)
    }
}
