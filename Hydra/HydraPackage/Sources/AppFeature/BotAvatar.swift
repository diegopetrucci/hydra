import SwiftUI

// MARK: - Pure helpers

/// Number of colours in the avatar palette.
public let botAvatarPaletteCount = 10

/// Deterministic palette index for a bot id (FNV-1a over UTF-8 bytes).
/// Never use `hashValue`: it is randomised per launch.
public func botAvatarColorIndex(for id: String) -> Int {
    var hash: UInt32 = 2_166_136_261
    for byte in id.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 16_777_619
    }
    return Int(hash % UInt32(botAvatarPaletteCount))
}

/// Uppercased first letter of the name, or "?" when the name is empty.
public func botAvatarInitial(for name: String) -> String {
    guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "?" }
    return String(first).uppercased()
}

// MARK: - BotAvatar

/// RGB components (0...1) of an avatar palette colour.
public struct BotAvatarRGB: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
}

/// Every entry has at least 4.5:1 contrast (WCAG) with white text.
public let botAvatarPaletteRGB: [BotAvatarRGB] = [
    BotAvatarRGB(red: 0.75, green: 0.15, blue: 0.15),
    BotAvatarRGB(red: 0.69, green: 0.31, blue: 0.00),
    BotAvatarRGB(red: 0.55, green: 0.39, blue: 0.00),
    BotAvatarRGB(red: 0.16, green: 0.46, blue: 0.20),
    BotAvatarRGB(red: 0.00, green: 0.46, blue: 0.46),
    BotAvatarRGB(red: 0.15, green: 0.38, blue: 0.78),
    BotAvatarRGB(red: 0.36, green: 0.30, blue: 0.80),
    BotAvatarRGB(red: 0.60, green: 0.25, blue: 0.74),
    BotAvatarRGB(red: 0.76, green: 0.20, blue: 0.50),
    BotAvatarRGB(red: 0.38, green: 0.42, blue: 0.48),
]

private let botAvatarPalette: [Color] = botAvatarPaletteRGB.map {
    Color(red: $0.red, green: $0.green, blue: $0.blue)
}

/// A filled circle with the bot's initial, coloured deterministically by bot id.
struct BotAvatar: View {
    let id: String
    let name: String
    var size: CGFloat = 28

    var body: some View {
        Text(botAvatarInitial(for: name))
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(botAvatarPalette[botAvatarColorIndex(for: id)], in: Circle())
            .accessibilityHidden(true)
    }
}
