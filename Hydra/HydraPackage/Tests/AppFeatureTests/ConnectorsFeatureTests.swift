import AppFeature
import ComposableArchitecture
import DaemonClient
import Foundation
import Testing

// MARK: - ConnectorsFeatureTests

@Suite("ConnectorsFeature")
@MainActor
struct ConnectorsFeatureTests {

    private let sentry = Connector(id: "sentry", name: "Sentry", status: .signedOut)
    private let notion = Connector(id: "notion", name: "Notion", status: .signedOut)

    private func state(_ connectors: [Connector], signingInID: String? = nil) -> ConnectorsFeature.State {
        var state = ConnectorsFeature.State()
        state.connectors = IdentifiedArray(uniqueElements: connectors)
        state.signingInID = signingInID
        return state
    }

    // MARK: Load

    @Test("onAppear loads the connector list")
    func loadsList() async {
        let store = TestStore(initialState: ConnectorsFeature.State()) {
            ConnectorsFeature()
        } withDependencies: { [sentry, notion] in
            $0.daemonClient.connectorsList = { [sentry, notion] }
        }

        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\._loaded) {
            $0.isLoading = false
            $0.connectors = [self.sentry, self.notion]
        }
    }

    @Test("load failure shows the error")
    func loadFailure() async {
        let store = TestStore(initialState: ConnectorsFeature.State()) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsList = {
                throw DaemonError(code: "unavailable", message: "Connectors are not available.")
            }
        }

        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\._loadFailed) {
            $0.isLoading = false
            $0.loadErrorMessage = "Connectors are not available."
        }
    }

    // MARK: Sign in

    @Test("sign in starts the flow and opens the URL for that connector")
    func signInOpensURL() async {
        let opened = LockIsolated<[URL]>([])
        let signedIn = LockIsolated<[String]>([])
        let store = TestStore(initialState: state([sentry, notion])) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsSignIn = { id in
                signedIn.withValue { $0.append(id) }
                return true
            }
            $0.openURL = OpenURLEffect { url in
                opened.withValue { $0.append(url) }
                return true
            }
        }

        await store.send(.signInButtonTapped(id: "sentry")) { $0.signingInID = "sentry" }
        await store.send(.signInURLReceived(connectorID: "sentry", url: "https://mcp.sentry.dev/authorize?x=1"))
        await store.finish()
        #expect(signedIn.value == ["sentry"])
        #expect(opened.value.map(\.absoluteString) == ["https://mcp.sentry.dev/authorize?x=1"])

        // Outcome arrives as connector.updated; the pending sign-in is cleared.
        await store.send(.connectorUpdated(Connector(id: "sentry", name: "Sentry", status: .connecting)))  {
            $0.connectors[id: "sentry"] = Connector(id: "sentry", name: "Sentry", status: .connecting)
        }
        let connected = Connector(id: "sentry", name: "Sentry", status: .connected)
        await store.send(.connectorUpdated(connected)) {
            $0.connectors[id: "sentry"] = connected
            $0.signingInID = nil
        }
    }

    @Test("stray sign-in URLs are ignored")
    func ignoresStrayURLs() async {
        let store = TestStore(initialState: state([sentry, notion], signingInID: "sentry")) {
            ConnectorsFeature()
        } withDependencies: {
            $0.openURL = OpenURLEffect { _ in
                Issue.record("Browser must not open for a stray URL")
                return true
            }
        }

        // Different connector than the one signing in.
        await store.send(.signInURLReceived(connectorID: "notion", url: "https://example.com/a"))
        // Non-web scheme.
        await store.send(.signInURLReceived(connectorID: "sentry", url: "file:///etc/passwd"))

        // Nothing signing in at all.
        let idle = TestStore(initialState: state([sentry])) { ConnectorsFeature() }
        await idle.send(.signInURLReceived(connectorID: "sentry", url: "https://example.com/a"))
    }

    @Test("sign-in errors are friendly: sign_in_busy, port_busy, other")
    func signInErrors() async {
        let codes = LockIsolated(["sign_in_busy", "port_busy", "sign_in_failed"])
        let store = TestStore(initialState: state([sentry])) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsSignIn = { _ in
                let code = codes.withValue { $0.removeFirst() }
                throw DaemonError(code: code, message: "daemon text for \(code)")
            }
        }

        await store.send(.signInButtonTapped(id: "sentry")) { $0.signingInID = "sentry" }
        await store.receive(\._signInFailed) {
            $0.signingInID = nil
            $0.actionErrors["sentry"] = "Another connector sign-in is already in progress. Finish or cancel it first."
        }

        await store.send(.signInButtonTapped(id: "sentry")) {
            $0.signingInID = "sentry"
            $0.actionErrors["sentry"] = nil
        }
        await store.receive(\._signInFailed) {
            $0.signingInID = nil
            $0.actionErrors["sentry"] = "Port 47619 is in use by another app. Quit it and try again."
        }

        await store.send(.signInButtonTapped(id: "sentry")) {
            $0.signingInID = "sentry"
            $0.actionErrors["sentry"] = nil
        }
        await store.receive(\._signInFailed) {
            $0.signingInID = nil
            $0.actionErrors["sentry"] = "daemon text for sign_in_failed"
        }
    }

    // MARK: Cancel / sign out

    @Test("cancel while connecting sends signOut and later URLs are ignored")
    func cancelWhileConnecting() async {
        let signedOut = LockIsolated<[String]>([])
        let store = TestStore(initialState: state(
            [Connector(id: "sentry", name: "Sentry", status: .connecting), notion],
            signingInID: "sentry"
        )) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsSignOut = { id in
                signedOut.withValue { $0.append(id) }
                return true
            }
            $0.openURL = OpenURLEffect { _ in
                Issue.record("Browser must not open after cancel")
                return true
            }
        }

        await store.send(.cancelButtonTapped(id: "sentry")) { $0.signingInID = nil }
        await store.send(.signInURLReceived(connectorID: "sentry", url: "https://example.com/late"))
        await store.finish()
        #expect(signedOut.value == ["sentry"])

        let reset = Connector(id: "sentry", name: "Sentry", status: .signedOut)
        await store.send(.connectorUpdated(reset)) { $0.connectors[id: "sentry"] = reset }
    }

    @Test("background reconnect (connecting without a sheet sign-in) is not a pending sign-in")
    func backgroundReconnectIsNotSigningIn() async {
        let store = TestStore(initialState: state([sentry, notion])) {
            ConnectorsFeature()
        } withDependencies: {
            $0.openURL = OpenURLEffect { _ in
                Issue.record("Browser must not open during a background reconnect")
                return true
            }
        }

        let connecting = Connector(id: "sentry", name: "Sentry", status: .connecting)
        await store.send(.connectorUpdated(connecting)) { $0.connectors[id: "sentry"] = connecting }
        #expect(store.state.signingInID == nil)
        await store.send(.signInURLReceived(connectorID: "sentry", url: "https://example.com/a"))
    }

    @Test("sign out sends signOut and the update shows signed out")
    func signOut() async {
        let signedOut = LockIsolated<[String]>([])
        let connected = Connector(id: "sentry", name: "Sentry", status: .connected)
        let store = TestStore(initialState: state([connected, notion])) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsSignOut = { id in
                signedOut.withValue { $0.append(id) }
                return true
            }
        }

        await store.send(.signOutButtonTapped(id: "sentry"))
        await store.finish()
        #expect(signedOut.value == ["sentry"])

        await store.send(.connectorUpdated(sentry)) { $0.connectors[id: "sentry"] = self.sentry }
    }

    @Test("sign out failure shows the error")
    func signOutFailure() async {
        let store = TestStore(initialState: state([Connector(id: "sentry", name: "Sentry", status: .connected)])) {
            ConnectorsFeature()
        } withDependencies: {
            $0.daemonClient.connectorsSignOut = { _ in
                throw DaemonError(code: "internal_error", message: "Could not delete credentials.")
            }
        }

        await store.send(.signOutButtonTapped(id: "sentry"))
        await store.receive(\._signOutFailed) {
            $0.actionErrors["sentry"] = "Could not delete credentials."
        }
    }

    // MARK: Events

    @Test("connector.updated carries needs-sign-in and error states into the list")
    func updatesShowNeedsSignInAndError() async {
        let store = TestStore(initialState: state([sentry, notion])) {
            ConnectorsFeature()
        }

        let needs = Connector(id: "sentry", name: "Sentry", status: .needsSignIn)
        await store.send(.connectorUpdated(needs)) { $0.connectors[id: "sentry"] = needs }

        let failed = Connector(id: "notion", name: "Notion", status: .signedOut, error: "Sign-in timed out. Try again.")
        await store.send(.connectorUpdated(failed)) { $0.connectors[id: "notion"] = failed }
    }
}
