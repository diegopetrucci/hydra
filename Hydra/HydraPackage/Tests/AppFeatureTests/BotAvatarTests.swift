import AppFeature
import Foundation
import Testing

@Suite struct BotAvatarTests {
    @Test func colorIndexIsStableForKnownID() {
        // FNV-1a 32-bit of "a" is 0xE40C292C (3_826_002_220); % 10 == 0.
        #expect(botAvatarColorIndex(for: "a") == 0)
        #expect(botAvatarColorIndex(for: "bot-1") == botAvatarColorIndex(for: "bot-1"))
    }

    @Test func colorIndexIsWithinPalette() {
        for i in 0..<500 {
            let index = botAvatarColorIndex(for: "id-\(i)")
            #expect((0..<botAvatarPaletteCount).contains(index))
        }
    }

    @Test func colorIndexSpreadsAcrossPalette() {
        let indices = Set((0..<50).map { botAvatarColorIndex(for: "bot-\($0)") })
        #expect(indices.count >= 6)
    }

    @Test func initialIsUppercasedFirstLetter() {
        #expect(botAvatarInitial(for: "helper") == "H")
        #expect(botAvatarInitial(for: "Éclair") == "É")
    }

    @Test func initialIsQuestionMarkForEmptyName() {
        #expect(botAvatarInitial(for: "") == "?")
        #expect(botAvatarInitial(for: "  ") == "?")
    }

    @Test func paletteHasExpectedCount() {
        #expect(botAvatarPaletteRGB.count == botAvatarPaletteCount)
    }

    @Test func paletteHasAtLeast4Point5ContrastWithWhite() {
        func linear(_ v: Double) -> Double {
            v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        for (index, c) in botAvatarPaletteRGB.enumerated() {
            let luminance = 0.2126 * linear(c.red) + 0.7152 * linear(c.green) + 0.0722 * linear(c.blue)
            let ratio = 1.05 / (luminance + 0.05)
            #expect(ratio >= 4.5, "palette entry \(index) has contrast \(ratio)")
        }
    }
}
