import ComposableArchitecture
import DaemonClient
import Foundation
import SwiftUI

// MARK: - ConnectorsFeature

@Reducer
public struct ConnectorsFeature {

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        public var connectors: IdentifiedArrayOf<Connector> = []
        public var isLoading: Bool = false
        /// Set when `connectors.list` fails.
        public var loadErrorMessage: String?
        /// The connector whose sign-in was started from this sheet. Only a
        /// `connector.signInUrl` for this connector opens the browser.
        public var signingInID: String?
        /// Per-connector errors from failed sign-in / sign-out requests.
        public var actionErrors: [String: String] = [:]

        public init() {}
    }

    // MARK: - Action

    public enum Action {
        // User intent
        case onAppear
        case signInButtonTapped(id: String)
        case cancelButtonTapped(id: String)
        case signOutButtonTapped(id: String)
        case doneButtonTapped

        // Daemon events forwarded from AppFeature
        case signInURLReceived(connectorID: String, url: String)
        case connectorUpdated(Connector)

        // Effects
        case _loaded([Connector])
        case _loadFailed(String)
        case _signInFailed(id: String, message: String)
        case _signOutFailed(id: String, message: String)
    }

    // MARK: - Dependencies

    @Dependency(\.daemonClient) var daemonClient
    @Dependency(\.openURL) var openURL
    @Dependency(\.dismiss) var dismiss

    // MARK: - Init

    public init() {}

    // MARK: - Body

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {

            case .onAppear:
                state.isLoading = true
                state.loadErrorMessage = nil
                return .run { [daemonClient] send in
                    do {
                        await send(._loaded(try await daemonClient.connectorsList()))
                    } catch {
                        await send(._loadFailed(error.localizedDescription))
                    }
                }

            case ._loaded(let connectors):
                state.isLoading = false
                // Merge so events that arrived while loading are not clobbered by a stale list.
                for connector in connectors where state.connectors[id: connector.id] == nil {
                    state.connectors.append(connector)
                }
                return .none

            case ._loadFailed(let message):
                state.isLoading = false
                state.loadErrorMessage = message
                return .none

            case .signInButtonTapped(let id):
                guard state.signingInID == nil else { return .none }
                state.signingInID = id
                state.actionErrors[id] = nil
                return .run { [daemonClient] send in
                    do {
                        _ = try await daemonClient.connectorsSignIn(id)
                    } catch {
                        await send(._signInFailed(id: id, message: Self.message(for: error)))
                    }
                }

            case ._signInFailed(let id, let message):
                if state.signingInID == id { state.signingInID = nil }
                state.actionErrors[id] = message
                return .none

            case .cancelButtonTapped(let id), .signOutButtonTapped(let id):
                // Cancelling a pending sign-in is a sign-out: the daemon aborts the flow.
                if state.signingInID == id { state.signingInID = nil }
                state.actionErrors[id] = nil
                return .run { [daemonClient] send in
                    do {
                        _ = try await daemonClient.connectorsSignOut(id)
                    } catch {
                        await send(._signOutFailed(id: id, message: Self.message(for: error)))
                    }
                }

            case ._signOutFailed(let id, let message):
                state.actionErrors[id] = message
                return .none

            case .doneButtonTapped:
                return .run { [dismiss] _ in await dismiss() }

            case .signInURLReceived(let connectorID, let url):
                // Ignore stray events: only a sign-in started from this sheet opens the browser.
                guard state.signingInID == connectorID,
                      let url = URL(string: url),
                      url.scheme == "https" || url.scheme == "http" else { return .none }
                return .run { [openURL] _ in await openURL(url) }

            case .connectorUpdated(let connector):
                state.connectors[id: connector.id] = connector
                if connector.status != .connecting, state.signingInID == connector.id {
                    state.signingInID = nil
                }
                if connector.status == .connected {
                    state.actionErrors[connector.id] = nil
                }
                return .none
            }
        }
    }

    // MARK: - Helpers

    /// Friendly text for daemon error codes; otherwise the daemon's own message.
    static func message(for error: Error) -> String {
        guard let daemonError = error as? DaemonError else { return error.localizedDescription }
        switch daemonError.code {
        case "sign_in_busy":
            return "Another connector sign-in is already in progress. Finish or cancel it first."
        case "port_busy":
            return "Port 47619 is in use by another app. Quit it and try again."
        default:
            return daemonError.message
        }
    }
}

// MARK: - ConnectorsFeatureView

public struct ConnectorsFeatureView: View {
    let store: StoreOf<ConnectorsFeature>

    public init(store: StoreOf<ConnectorsFeature>) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle("Connectors")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { store.send(.doneButtonTapped) }
                    }
                }
        }
        .frame(minWidth: 420, minHeight: 280)
        .task { store.send(.onAppear) }
    }

    @ViewBuilder
    private var content: some View {
        if store.connectors.isEmpty {
            VStack(spacing: 12) {
                if store.isLoading {
                    ProgressView("Loading connectors…")
                } else if let error = store.loadErrorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                    Button("Retry") { store.send(.onAppear) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else {
            List(store.connectors) { connector in
                row(connector)
            }
        }
    }

    private func row(_ connector: Connector) -> some View {
        // A sign-in started from this sheet. A `connecting` status without it is the
        // daemon's own background reconnect, which must not offer Cancel.
        let isSigningIn = store.signingInID == connector.id
        let isReconnecting = connector.status == .connecting && !isSigningIn
        let errorText = store.actionErrors[connector.id] ?? connector.error
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(connector.name).font(.headline)
                if isSigningIn {
                    Text("Connecting… finish signing in in your browser.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(statusText(connector.status))
                        .font(.caption)
                        .foregroundStyle(connector.status == .connected ? .green : .secondary)
                }
                if !isSigningIn || store.actionErrors[connector.id] != nil, let errorText {
                    Text(errorText)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            if isSigningIn {
                ProgressView().controlSize(.small)
                Button("Cancel") { store.send(.cancelButtonTapped(id: connector.id)) }
            } else if isReconnecting {
                ProgressView().controlSize(.small)
                Button("Sign Out") { store.send(.signOutButtonTapped(id: connector.id)) }
            } else if connector.status == .connected {
                Button("Sign Out") { store.send(.signOutButtonTapped(id: connector.id)) }
            } else {
                Button(connector.status == .needsSignIn ? "Sign In Again" : "Sign In") {
                    store.send(.signInButtonTapped(id: connector.id))
                }
                .buttonStyle(.borderedProminent)
                // The daemon runs one sign-in at a time (sign_in_busy has a friendly message).
                .disabled(store.signingInID != nil)
            }
        }
        .padding(.vertical, 4)
    }

    private func statusText(_ status: ConnectorStatus) -> String {
        switch status {
        case .signedOut: "Not connected"
        case .connecting: "Connecting…"
        case .connected: "Connected"
        case .needsSignIn: "Needs sign-in — your saved sign-in was refused."
        case .error: "Error"
        }
    }
}
