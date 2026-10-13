import AppFeature
import ComposableArchitecture
import DaemonClient
import Foundation
import Testing

// MARK: - LoginFeatureTests

@Suite("LoginFeature")
@MainActor
struct LoginFeatureTests {

    // MARK: - API Key path

    @Test("API key: submit saves key and signals authenticated")
    func apiKeySubmitSavesAndAuthenticates() async {
        var initial = LoginFeature.State()
        initial.screen = .apiKeyEntry

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authSetAPIKey = { _, _ in true }
        }

        await store.send(.set(\.apiKey, "sk-ant-key")) {
            $0.apiKey = "sk-ant-key"
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

    @Test("API key: empty key shows validation error")
    func apiKeyEmptyShowsError() async {
        var initial = LoginFeature.State()
        initial.screen = .apiKeyEntry

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.submitAPIKeyButtonTapped) {
            $0.errorMessage = "API key is required."
        }
    }

    @Test("API key: save failure shows error")
    func apiKeySaveFailureShowsError() async {
        var initial = LoginFeature.State()
        initial.screen = .apiKeyEntry

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authSetAPIKey = { _, _ in
                throw DaemonError(code: "internal_error", message: "Invalid key")
            }
        }

        await store.send(.set(\.apiKey, "bad-key")) {
            $0.apiKey = "bad-key"
        }
        await store.send(.submitAPIKeyButtonTapped) {
            $0.isLoading = true
        }
        await store.receive(\._apiKeySaveFailed) {
            $0.isLoading = false
            $0.errorMessage = "Invalid key"
        }
    }

    // MARK: - OAuth path

    @Test("OAuth: sign-in starts login and emits loginID")
    func oauthStartsLogin() async {
        let store = TestStore(initialState: LoginFeature.State()) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authLogin = { _, _ in "login-uuid-1" }
        }

        await store.send(.signInWithClaudeButtonTapped) {
            $0.screen = .oauthInProgress
            $0.isLoading = true
            $0.isPendingLoginStart = true
            $0.errorMessage = nil
        }
        await store.receive(\._loginStarted) {
            $0.loginID = "login-uuid-1"
            $0.isLoading = false
            $0.isPendingLoginStart = false
        }
    }

    @Test("OAuth: auth.url event stores URL and opens browser automatically (gap 5)")
    func oauthURLEventStoresURLAndOpensBrowser() async {
        let openedURLs = LockIsolated<[URL]>([])

        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.openURL = OpenURLEffect { url in
                openedURLs.withValue { $0.append(url) }
                return true
            }
        }

        await store.send(.authURLReceived(
            loginID: "login-1",
            url: "https://claude.ai/authorize",
            instructions: "Open this URL."
        )) {
            $0.oauthURL = "https://claude.ai/authorize"
            $0.oauthInstructions = "Open this URL."
        }
        await store.finish()

        #expect(openedURLs.value.first?.absoluteString == "https://claude.ai/authorize",
                "Browser must be opened automatically when auth.url is received")
    }

    @Test("OAuth: auth.prompt event stores prompt fields")
    func oauthPromptEventStoresFields() async {
        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.promptReceived(
            loginID: "login-1",
            promptID: "prompt-1",
            kind: "manual_code",
            message: "Paste the redirect URL:",
            placeholder: "https://...",
            options: nil
        )) {
            $0.pendingPromptID = "prompt-1"
            $0.pendingPromptKind = "manual_code"
            $0.pendingPromptMessage = "Paste the redirect URL:"
            $0.pendingPromptPlaceholder = "https://..."
            $0.pendingOptions = nil
            $0.isLoading = false
        }
    }

    @Test("OAuth: submit prompt sends authRespond and scopes ack to promptID (gap 3)")
    func oauthSubmitPrompt() async {
        let respondCalled = LockIsolated(false)

        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"
        initial.pendingPromptID = "prompt-1"
        initial.pendingPromptKind = "manual_code"
        initial.pendingPromptMessage = "Paste:"
        initial.promptResponse = "code-123"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authRespond = { _, _, _ in respondCalled.setValue(true); return true }
        }

        await store.send(.submitPromptButtonTapped) {
            $0.isLoading = true
        }
        await store.receive(\._promptSent) {
            $0.isLoading = false
            $0.promptResponse = ""
            $0.pendingPromptID = nil
            $0.pendingPromptMessage = nil
            $0.pendingPromptKind = nil
            $0.pendingPromptPlaceholder = nil
        }
        #expect(respondCalled.value)
    }

    @Test("OAuth: _promptSent does not clear a racing new prompt (gap 3)")
    func promptSentDoesNotClearRacingPrompt() async {
        // The select prompt's ack (_promptSent) should not clear the manual_code prompt
        // that arrived before the ack returned.
        let (respondStream, respondCont) = AsyncStream<Bool>.makeStream()

        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"
        initial.pendingPromptID = "prompt-sel-1"
        initial.pendingPromptKind = "select"
        initial.pendingPromptMessage = "Choose:"
        initial.pendingOptions = [AuthPromptOption(id: "browser", label: "Browser")]

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authRespond = { _, _, _ in
                for await result in respondStream { return result }
                return false
            }
            $0.openURL = OpenURLEffect { _ in return true }
        }

        // 1. User taps "Browser" option — clears select prompt synchronously, suspends ack.
        await store.send(.selectOptionTapped(id: "browser")) {
            $0.isLoading = true
            $0.pendingPromptID = nil
            $0.pendingPromptKind = nil
            $0.pendingPromptMessage = nil
            $0.pendingOptions = nil
        }

        // 2. auth.url arrives before the ack — browser opened automatically.
        await store.send(.authURLReceived(loginID: "login-1", url: "https://claude.ai/auth", instructions: nil)) {
            $0.oauthURL = "https://claude.ai/auth"
        }
        // openURL fires in background (no dispatched action); no finish() needed here.

        // 3. manual_code prompt arrives before the ack.
        await store.send(.promptReceived(
            loginID: "login-1",
            promptID: "prompt-code-1",
            kind: "manual_code",
            message: "Paste code:",
            placeholder: "https://...",
            options: nil
        )) {
            $0.pendingPromptID = "prompt-code-1"
            $0.pendingPromptKind = "manual_code"
            $0.pendingPromptMessage = "Paste code:"
            $0.pendingPromptPlaceholder = "https://..."
            $0.isLoading = false
        }

        // 4. Ack arrives for the SELECT prompt. _promptSent carries "prompt-sel-1".
        //    Since pendingPromptID is now "prompt-code-1" (≠ "prompt-sel-1"), the
        //    manual_code prompt fields must NOT be cleared. isLoading was already false
        //    (set by promptReceived), so _promptSent causes no observable state change.
        respondCont.yield(true)
        respondCont.finish()
        await store.receive(\._promptSent)
        // Assert manual_code prompt is still showing.
        #expect(store.state.pendingPromptID == "prompt-code-1")
        #expect(store.state.pendingPromptKind == "manual_code")
        await store.finish()
    }

    @Test("OAuth: auth.completed signals authenticated")
    func oauthCompleted() async {
        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.completed(loginID: "login-1", providerID: "anthropic")) {
            $0.isCompleted = true
        }
        await store.receive(\.delegate)  // .authenticated
    }

    @Test("OAuth: auth.failed shows error")
    func oauthFailed() async {
        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.loginFailed(loginID: "login-1", message: "Login cancelled")) {
            $0.isLoading = false
            $0.errorMessage = "Login cancelled"
        }
    }

    // MARK: - Real OAuth sequence (select → respond → auth.url → manual_code → completed)

    @Test("OAuth: real select-prompt sequence — next prompt before ack, browser opened (gaps 3, 5)")
    func oauthRealSelectSequence() async {
        let respondCalled = LockIsolated<[String]>([])
        let openedURLs = LockIsolated<[URL]>([])
        let (respondStream, respondCont) = AsyncStream<Bool>.makeStream()

        let store = TestStore(initialState: LoginFeature.State()) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authLogin = { _, _ in "login-seq-1" }
            $0.daemonClient.authRespond = { _, _, value in
                // Record AFTER the stream yields so the suspension check is valid.
                for await result in respondStream {
                    respondCalled.withValue { $0.append(value) }
                    return result
                }
                return false
            }
            $0.openURL = OpenURLEffect { url in
                openedURLs.withValue { $0.append(url) }
                return true
            }
        }

        // 1. Sign in tapped
        await store.send(.signInWithClaudeButtonTapped) {
            $0.screen = .oauthInProgress
            $0.isLoading = true
            $0.isPendingLoginStart = true
            $0.errorMessage = nil
        }
        await store.receive(\._loginStarted) {
            $0.loginID = "login-seq-1"
            $0.isLoading = false
            $0.isPendingLoginStart = false
        }

        // 2. auth.prompt(select) arrives — before auth.url
        let selectOptions = [
            AuthPromptOption(id: "browser", label: "Browser login"),
            AuthPromptOption(id: "code", label: "Copy code login"),
        ]
        await store.send(.promptReceived(
            loginID: "login-seq-1",
            promptID: "prompt-sel-1",
            kind: "select",
            message: "Choose a login method:",
            placeholder: nil,
            options: selectOptions
        )) {
            $0.pendingPromptID = "prompt-sel-1"
            $0.pendingPromptKind = "select"
            $0.pendingPromptMessage = "Choose a login method:"
            $0.pendingOptions = selectOptions
            $0.isLoading = false
        }

        // 3. User taps "Browser login" — authRespond is now suspended (continuation-controlled).
        await store.send(.selectOptionTapped(id: "browser")) {
            $0.isLoading = true
            $0.pendingPromptID = nil
            $0.pendingPromptKind = nil
            $0.pendingPromptMessage = nil
            $0.pendingOptions = nil
        }
        #expect(respondCalled.value.isEmpty, "authRespond is still in flight (suspended)")

        // 4. auth.url arrives BEFORE the ack — browser is opened automatically (gap 5).
        await store.send(.authURLReceived(
            loginID: "login-seq-1",
            url: "https://claude.ai/authorize?foo=bar",
            instructions: nil
        )) {
            $0.oauthURL = "https://claude.ai/authorize?foo=bar"
        }
        // openURL fires asynchronously in the background (dispatches no action).

        // 5. manual_code prompt arrives BEFORE the select ack (races the browser callback).
        await store.send(.promptReceived(
            loginID: "login-seq-1",
            promptID: "prompt-code-1",
            kind: "manual_code",
            message: "Paste the redirect URL or auth code:",
            placeholder: "https://...",
            options: nil
        )) {
            $0.pendingPromptID = "prompt-code-1"
            $0.pendingPromptKind = "manual_code"
            $0.pendingPromptMessage = "Paste the redirect URL or auth code:"
            $0.pendingPromptPlaceholder = "https://..."
            $0.pendingOptions = nil
            $0.isLoading = false
        }

        // 6. Release the select ack — _promptSent carries "prompt-sel-1" and must NOT
        //    clear the racing manual_code prompt (gap 3). isLoading was already false from
        //    step 5 (promptReceived), so _promptSent causes no observable state change.
        respondCont.yield(true)
        respondCont.finish()
        await store.receive(\._promptSent)
        #expect(respondCalled.value == ["browser"], "authRespond must be called with the option id")
        #expect(store.state.pendingPromptID == "prompt-code-1", "manual_code prompt must survive the select ack")

        // 7. auth.completed arrives (browser callback won the race).
        await store.send(.completed(loginID: "login-seq-1", providerID: "anthropic")) {
            $0.isCompleted = true
        }
        await store.receive(\.delegate)  // .authenticated
        await store.finish()
        // openURL was called automatically when auth.url arrived (gap 5).
        #expect(openedURLs.value.first?.absoluteString == "https://claude.ai/authorize?foo=bar",
                "Browser must open automatically when auth.url arrives")
    }

    // MARK: - Login session isolation (gap 4)

    @Test("OAuth: auth events only accepted while login is pending (gap 4)")
    func oauthEventsNotAcceptedWithoutPendingLogin() async {
        // loginID is nil AND isPendingLoginStart is false — no login in progress.
        // Auth events must NOT be accepted (guards against stale events from a previous session).
        let store = TestStore(initialState: LoginFeature.State()) {
            LoginFeature()
        }

        // No state change expected — isPendingLoginStart is false, loginID is nil.
        await store.send(.promptReceived(
            loginID: "login-stale",
            promptID: "prompt-stale",
            kind: "manual_code",
            message: "Code?",
            placeholder: nil,
            options: nil
        ))
    }

    /// Gap (9): auth.completed and auth.failed must also be ignored when no login is in progress.
    @Test("OAuth: auth.completed and auth.failed ignored when no login in progress (gap 9)")
    func authCompletedAndFailedIgnoredWithoutLogin() async {
        // loginID is nil AND isPendingLoginStart is false \
        // \ no login in progress; stale events must be silently dropped.
        let store = TestStore(initialState: LoginFeature.State()) {
            LoginFeature()
        }

        // No state change or effects expected from either action.
        await store.send(.completed(loginID: "login-stale", providerID: "anthropic"))
        await store.send(.loginFailed(loginID: "login-stale", message: "something went wrong"))
    }

    @Test("OAuth: auth.prompt arriving before _loginStarted (isPendingLoginStart) is accepted (gap 4)")
    func oauthPromptBeforeLoginIDAccepted() async {
        // Simulate the race: auth.login is still in flight (isPendingLoginStart = true, loginID = nil).
        var initial = LoginFeature.State()
        initial.isPendingLoginStart = true

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.promptReceived(
            loginID: "login-any",
            promptID: "prompt-early",
            kind: "manual_code",
            message: "Code?",
            placeholder: nil,
            options: nil
        )) {
            $0.pendingPromptID = "prompt-early"
            $0.pendingPromptKind = "manual_code"
            $0.pendingPromptMessage = "Code?"
            $0.isLoading = false
        }
    }

    @Test("OAuth: auth events with a different loginID are ignored (gap 4)")
    func oauthEventsWithWrongLoginIDIgnored() async {
        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-correct"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        // Event from a stale login — must produce no state change.
        await store.send(.promptReceived(
            loginID: "login-stale",
            promptID: "prompt-stale",
            kind: "manual_code",
            message: "Stale code?",
            placeholder: nil,
            options: nil
        ))
        // No state mutation expected; exhaustive store would fail if there were any.
    }

    /// Gap (4): Two tests verify the cancel-before-loginID scenario.
    ///
    /// Test A: cancelButtonTapped sets shouldCancelOnStart synchronously when loginID is nil.
    @Test("OAuth: cancelButtonTapped while pending sets shouldCancelOnStart (gap 4)")
    func cancelButtonWhilePendingSetsShouldCancel() async {
        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.isLoading = true
        initial.isPendingLoginStart = true

        let store = TestStore(initialState: initial) {
            LoginFeature()
        }

        await store.send(.cancelButtonTapped) {
            $0.shouldCancelOnStart = true
        }
        await store.finish()
    }

    /// Test B: when _loginStarted arrives with shouldCancelOnStart=true, the loginID is cancelled.
    @Test("OAuth: _loginStarted with shouldCancelOnStart cancels the loginID (gap 4)")
    func loginStartedWithCancelFlagCancels() async {
        let cancelCalled = LockIsolated<String?>(nil)

        var initial = LoginFeature.State()
        initial.isPendingLoginStart = true   // auth.login was in flight
        initial.shouldCancelOnStart = true   // user cancelled before loginID arrived

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authCancel = { id in cancelCalled.setValue(id); return true }
        }

        // The loginID arrives from the still-running auth.login effect.
        await store.send(._loginStarted(loginID: "login-late-1")) {
            $0.isPendingLoginStart = false
            $0.shouldCancelOnStart = false
            // loginID is NOT stored (immediate cancel)
        }
        await store.finish()
        #expect(cancelCalled.value == "login-late-1", "The late loginID must be cancelled immediately")
    }

    // MARK: - Cancel

    @Test("cancel with in-flight login calls authCancel then dismisses")
    func cancelCallsAuthCancel() async {
        let cancelCalled = LockIsolated(false)

        var initial = LoginFeature.State()
        initial.screen = .oauthInProgress
        initial.loginID = "login-1"

        let store = TestStore(initialState: initial) {
            LoginFeature()
        } withDependencies: {
            $0.daemonClient.authCancel = { _ in cancelCalled.setValue(true); return true }
        }

        // Cancel nils the loginID synchronously to prevent double-cancel from the parent's
        // .login(.dismiss) handler. The async effect then calls authCancel + dismiss.
        // @Dependency(\.dismiss).testValue is a no-op, so no extra actions are dispatched.
        await store.send(.cancelButtonTapped) {
            $0.loginID = nil  // cleared synchronously
        }
        // Wait for the effect to complete (authCancel is called, then dismiss no-ops).
        await store.finish()
        #expect(cancelCalled.value)
    }
}
