import Foundation

// MARK: - MessageTimestamp

/// Formats the small time caption shown under each chat message.
enum MessageTimestamp {

    /// - Same day as `now`: time only (e.g. `14:32`, or `2:32 PM` in a 12-hour locale).
    /// - Previous day: `Yesterday, 14:32`.
    /// - Earlier in the same year: `12 Oct, 14:32`.
    /// - Another year: `12 Oct 2025, 14:32`.
    ///
    /// The 12/24-hour presentation comes from the locale's hour/minute skeleton, so the
    /// autoupdating locale follows the system setting.
    static func format(
        _ date: Date,
        now: Date,
        calendar: Calendar = .current,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        // Hour + minute skeleton: the locale picks 12/24-hour and zero padding (en_GB: 00:01).
        let time = date.formatted(
            Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .hour()
                .minute()
        )

        if calendar.isDate(date, inSameDayAs: now) {
            return time
        }

        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)
        if let yesterday, calendar.isDate(date, inSameDayAs: yesterday) {
            let prefix = String(localized: "Yesterday", locale: locale)
            return "\(prefix), \(time)"
        }

        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        var dayStyle = Date.FormatStyle(
            locale: locale,
            calendar: calendar,
            timeZone: calendar.timeZone
        )
        .day()
        .month(.abbreviated)
        if !sameYear {
            dayStyle = dayStyle.year()
        }
        return "\(date.formatted(dayStyle)), \(time)"
    }
}
