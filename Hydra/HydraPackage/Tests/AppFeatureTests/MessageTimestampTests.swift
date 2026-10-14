import Foundation
import Testing

@testable import AppFeature

@Suite struct MessageTimestampTests {
    private static let london = TimeZone(identifier: "Europe/London")!
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = london
        return calendar
    }()
    private static let gb = Locale(identifier: "en_GB")
    private static let us = Locale(identifier: "en_US")

    private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Date {
        Self.calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
    }

    private func format(_ date: Date, now: Date, locale: Locale = gb) -> String {
        MessageTimestamp.format(date, now: now, calendar: Self.calendar, locale: locale)
    }

    private let now = Calendar(identifier: .gregorian).date(
        from: DateComponents(
            timeZone: TimeZone(identifier: "Europe/London"),
            year: 2026, month: 10, day: 13, hour: 16, minute: 0
        )
    )!

    @Test func today() {
        #expect(format(date(2026, 10, 13, 14, 32), now: now) == "14:32")
    }

    @Test func yesterday() {
        #expect(format(date(2026, 10, 12, 14, 32), now: now) == "Yesterday, 14:32")
    }

    @Test func aroundMidnight() {
        let justAfterMidnight = date(2026, 10, 13, 0, 1)
        #expect(format(date(2026, 10, 12, 23, 59), now: justAfterMidnight) == "Yesterday, 23:59")
        #expect(format(justAfterMidnight, now: justAfterMidnight) == "00:01")
    }

    @Test func earlierThisYear() {
        #expect(format(date(2026, 3, 12, 14, 32), now: now) == "12 Mar, 14:32")
    }

    @Test func anotherYear() {
        #expect(format(date(2025, 10, 12, 14, 32), now: now) == "12 Oct 2025, 14:32")
    }

    @Test func twelveHourLocale() {
        let result = format(date(2026, 10, 13, 14, 32), now: now, locale: Self.us)
        // Newer ICU uses a narrow no-break space before "PM".
        #expect(result.replacingOccurrences(of: "\u{202F}", with: " ") == "2:32 PM")
    }
}
