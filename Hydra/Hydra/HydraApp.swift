import AppFeature
import ComposableArchitecture
import DaemonClient
import Dependencies
import SwiftUI
import TipKit

// MARK: - AppDelegate

/// Handles synchronous app-lifecycle events that must not use `await`.
///
/// `applicationWillTerminate` closes the daemon's stdin on the main thread so
/// the daemon receives EOF and exits cleanly — without sending SIGTERM, which
/// would bypass the daemon's graceful-drain path.
final class HydraAppDelegate: NSObject, NSApplicationDelegate, Sendable {

    func applicationWillTerminate(_ notification: Notification) {
        // `syncClose` uses a lock-protected `StdinHandleBox` — safe to call
        // synchronously from any thread.  See `StdinHandleBox` in DaemonController.swift.
        @Dependency(\.daemonClient) var daemonClient
        daemonClient.syncClose()
    }

    /// Keep the process alive after the last window is closed so the menu bar
    /// extra and daemon remain available.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Re-open the main window when the user clicks the Dock icon.
    @MainActor
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            AppWindowBus.shared.openMainWindow?()
        }
        return true
    }
}

// MARK: - AppWindowBus

/// Bridges the NSApplicationDelegate (UIKit lifecycle) to SwiftUI's `openWindow` action.
/// The main window's view sets `openMainWindow` in `.onAppear`.
///
/// `@MainActor`-isolated: all accesses are on the main actor, so no `@unchecked Sendable` needed.
/// The `nonisolated init` lets the static `shared` constant be initialised at module-load time
/// without requiring a MainActor hop; the instance is otherwise @MainActor throughout.
@MainActor
final class AppWindowBus {
    static let shared = AppWindowBus()
    // nonisolated so the static `shared` initialiser above can call it without a MainActor hop.
    nonisolated init() {}
    var openMainWindow: (@MainActor () -> Void)?
}

// MARK: - App

@main
struct HydraApp: App {
    @NSApplicationDelegateAdaptor(HydraAppDelegate.self) var appDelegate

    /// Single shared store for both the main window and the menu bar extra.
    /// Guarded by `isTesting` so the test runner never spawns the daemon.
    private let store: StoreOf<AppFeature>?

    init() {
        if !isTesting {
            prepareDependencies {
                // Wire the AppWindowClient dependency to AppWindowBus so that
                // AppFeature can open the main window (e.g. on notification tap)
                // without directly referencing app-target types.
                $0.appWindowClient.openMain = {
                    await MainActor.run { AppWindowBus.shared.openMainWindow?() }
                }
                // EnvironmentValues().openURL returns false for https URLs on macOS and
                // never opens the browser. NSWorkspace.shared.open is the correct AppKit
                // API for opening URLs from a macOS app.
                $0.openURL = OpenURLEffect { url in
                    await MainActor.run { NSWorkspace.shared.open(url) }
                }
            }
        }
        if !isTesting {
            do {
                try Tips.configure()
            } catch {
                FileHandle.standardError.write(Data("Tips.configure failed: \(error)\n".utf8))
            }
        }
        store = isTesting ? nil : Store(initialState: AppFeature.State()) {
            AppFeature()
        }
        if !isTesting, let store {
            // Start app-lifetime effects (daemon connect, event stream, notification taps,
            // activity changes) once for the store's lifetime so that closing and reopening
            // the window does not cancel them or trigger a reconnect.
            // The Task is not tied to any view lifecycle; it runs until the app quits.
            Task { await store.send(.appLaunched).finish() }
        }
    }

    var body: some Scene {
        mainWindowScene
        menuBarScene
    }

    // MARK: - Main window

    private var mainWindowScene: some Scene {
        Window("Hydra", id: "main") {
            if let store {
                AppFeatureView(store: store)
                    .frame(minWidth: 600, minHeight: 400)
                    .registerWindowOpener()
            }
        }
        .defaultSize(width: 1000, height: 650)
    }

    // MARK: - Menu bar

    private var menuBarScene: some Scene {
        MenuBarExtra("Hydra", systemImage: "bubble.left.and.bubble.right") {
            MenuBarContentView()
        }
    }
}

// MARK: - MenuBarContentView

private struct MenuBarContentView: View {
    @Environment(\.openWindow) var openWindow

    var body: some View {
        Button("Open Hydra") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("Quit") {
            NSApp.terminate(nil)
        }
    }
}

// MARK: - RegisterWindowOpener view modifier

private struct RegisterWindowOpener: ViewModifier {
    @Environment(\.openWindow) var openWindow

    func body(content: Content) -> some View {
        content
            .onAppear {
                AppWindowBus.shared.openMainWindow = {
                    openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                }
            }
    }
}

extension View {
    fileprivate func registerWindowOpener() -> some View {
        modifier(RegisterWindowOpener())
    }
}
