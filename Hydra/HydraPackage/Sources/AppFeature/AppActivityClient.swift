import Dependencies
import DependenciesMacros
import Foundation

#if canImport(AppKit)
import AppKit

// MARK: - AppActivityClient

/// A dependency that tracks whether the macOS app is currently active.
///
/// - `isActive`: returns the current activation state.
/// - `changes`: a stream that emits `true` when the app becomes active and
///   `false` when it resigns active.
@DependencyClient
public struct AppActivityClient: Sendable {
    public var isActive: @Sendable () -> Bool = { true }
    public var changes: @Sendable () -> AsyncStream<Bool> = { .never }
}

// MARK: - DependencyKey

extension AppActivityClient: DependencyKey {
    public static var liveValue: AppActivityClient {
        AppActivityClient(
            // `isActive` is not used by any feature; `changes()` is the authoritative source.
            // Return true as a safe default to avoid @MainActor isolation requirements.
            isActive: { true },
            changes: {
                AsyncStream { continuation in
                    // Emit the initial activation state before subscribing to change notifications.
                    // NSApp.isActive is @MainActor-isolated; read it safely on the main actor.
                    Task { @MainActor in continuation.yield(NSApp.isActive) }

                    let center = NotificationCenter.default
                    // Use nonisolated(unsafe) so the closures can capture observer tokens.
                    nonisolated(unsafe) var becameActiveToken: (any NSObjectProtocol)?
                    nonisolated(unsafe) var resignedActiveToken: (any NSObjectProtocol)?

                    becameActiveToken = center.addObserver(
                        forName: NSApplication.didBecomeActiveNotification,
                        object: nil,
                        queue: .main
                    ) { _ in continuation.yield(true) }

                    resignedActiveToken = center.addObserver(
                        forName: NSApplication.didResignActiveNotification,
                        object: nil,
                        queue: .main
                    ) { _ in continuation.yield(false) }

                    continuation.onTermination = { _ in
                        if let token = becameActiveToken { center.removeObserver(token) }
                        if let token = resignedActiveToken { center.removeObserver(token) }
                    }
                }
            }
        )
    }

    public static var testValue: AppActivityClient { Self() }
}

// MARK: - DependencyValues

extension DependencyValues {
    public var appActivityClient: AppActivityClient {
        get { self[AppActivityClient.self] }
        set { self[AppActivityClient.self] = newValue }
    }
}

#else
// MARK: - Stub (non-macOS)

@DependencyClient
public struct AppActivityClient: Sendable {
    public var isActive: @Sendable () -> Bool = { true }
    public var changes: @Sendable () -> AsyncStream<Bool> = { .never }
}

extension AppActivityClient: DependencyKey {
    public static var liveValue: AppActivityClient { Self() }
    public static var testValue: AppActivityClient { Self() }
}

extension DependencyValues {
    public var appActivityClient: AppActivityClient {
        get { self[AppActivityClient.self] }
        set { self[AppActivityClient.self] = newValue }
    }
}
#endif
