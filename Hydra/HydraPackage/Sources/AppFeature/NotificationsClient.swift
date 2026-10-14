import Dependencies
import DependenciesMacros
import Foundation

#if canImport(AppKit)
import AppKit
import UserNotifications

// MARK: - NotificationsClient

/// A dependency that wraps `UNUserNotificationCenter`.
///
/// - `requestAuthorization`: requests `.alert`, `.sound`, and `.badge` permissions.
/// - `post`: fires a local notification carrying a `botID` in userInfo.
/// - `tappedBotIDs`: a stream of bot IDs emitted when the user taps a notification.
@DependencyClient
public struct NotificationsClient: Sendable {
    public var requestAuthorization: @Sendable () async throws -> Bool = { false }
    public var post: @Sendable (
        _ notificationID: String,
        _ title: String,
        _ body: String,
        _ botID: String
    ) async -> Void = { _, _, _, _ in }
    public var tappedBotIDs: @Sendable () -> AsyncStream<String> = { .never }
}

// MARK: - DependencyKey

extension NotificationsClient: DependencyKey {
    public static var liveValue: NotificationsClient {
        let delegate = _NotificationDelegate.shared
        UNUserNotificationCenter.current().delegate = delegate
        return NotificationsClient(
            requestAuthorization: {
                try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
            },
            post: { notificationID, title, body, botID in
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.userInfo = ["botID": botID]
                let request = UNNotificationRequest(
                    identifier: notificationID,
                    content: content,
                    trigger: nil
                )
                try? await UNUserNotificationCenter.current().add(request)
            },
            tappedBotIDs: { delegate.stream }
        )
    }

    public static var testValue: NotificationsClient { Self() }
}

// MARK: - DependencyValues

extension DependencyValues {
    public var notificationsClient: NotificationsClient {
        get { self[NotificationsClient.self] }
        set { self[NotificationsClient.self] = newValue }
    }
}

// MARK: - Delegate

/// Receives notification response events and forwards bot IDs to the async stream.
private final class _NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = _NotificationDelegate()
    private override init() { super.init() }

    private let (streamInternal, continuation) = AsyncStream<String>.makeStream()
    var stream: AsyncStream<String> { streamInternal }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let botID = response.notification.request.content.userInfo["botID"] as? String {
            // Activate the app on the main actor (NSApp is @MainActor-isolated).
            Task { @MainActor in NSApp.activate(ignoringOtherApps: true) }
            continuation.yield(botID)
        }
        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The reducer only posts notifications when the bot is unselected or the app is inactive,
        // so allow the system to display any notification that reaches this delegate.
        completionHandler([.banner, .sound])
    }
}

#else
// MARK: - Stub (non-macOS)

@DependencyClient
public struct NotificationsClient: Sendable {
    public var requestAuthorization: @Sendable () async throws -> Bool = { false }
    public var post: @Sendable (
        _ notificationID: String,
        _ title: String,
        _ body: String,
        _ botID: String
    ) async -> Void = { _, _, _, _ in }
    public var tappedBotIDs: @Sendable () -> AsyncStream<String> = { .never }
}

extension NotificationsClient: DependencyKey {
    public static var liveValue: NotificationsClient { Self() }
    public static var testValue: NotificationsClient { Self() }
}

extension DependencyValues {
    public var notificationsClient: NotificationsClient {
        get { self[NotificationsClient.self] }
        set { self[NotificationsClient.self] = newValue }
    }
}
#endif
