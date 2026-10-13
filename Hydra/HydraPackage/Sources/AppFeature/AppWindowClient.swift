import Dependencies
import DependenciesMacros
import Foundation

// MARK: - AppWindowClient

/// A dependency for opening or raising the main application window.
///
/// The live value is a no-op in the package; the app target overrides it
/// with `prepareDependencies` to call `AppWindowBus.shared.openMainWindow?()`.
@DependencyClient
public struct AppWindowClient: Sendable {
    /// Opens or raises the main application window.
    public var openMain: @Sendable () async -> Void = {}
}

// MARK: - DependencyKey

extension AppWindowClient: DependencyKey {
    public static var liveValue: AppWindowClient { Self() }
    public static var testValue: AppWindowClient { Self() }
}

// MARK: - DependencyValues

extension DependencyValues {
    public var appWindowClient: AppWindowClient {
        get { self[AppWindowClient.self] }
        set { self[AppWindowClient.self] = newValue }
    }
}
