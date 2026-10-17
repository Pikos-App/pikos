import Foundation

/// A time of day as Pikos writes it: `3:00pm`, minutes always, the period lowercase and whole.
///
/// Mirror of `formatClockTime` in `packages/core/src/format/formatTime.ts`, so the phone, its
/// widgets and the desktop write the same 8am the same way. The one place that does not use it is
/// an hour gridline ("3 PM"), which is too narrow for the minutes.
public enum ClockTime {
    public static func string(hour: Int, minute: Int) -> String {
        let clock = hour % 12 == 0 ? 12 : hour % 12
        return String(format: "%d:%02d%@", clock, minute, hour < 12 ? "am" : "pm")
    }

    /// The instant's hour and minute in `calendar`'s zone.
    public static func string(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return string(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }
}
