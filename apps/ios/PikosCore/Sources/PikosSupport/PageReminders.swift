import Foundation

/// A page's own reminder rows, read the way the desktop's reminder menu reads them.
///
/// No rows means the page takes the device's default lead. A single `never` row means it
/// reminds never. Anything else is the page's own leads, which replace the default rather than
/// adding to it. An all-day page has no start to lead from, so its one choice is the day-before
/// anchor, and the default never stands in for it.
public struct PageReminders: Equatable, Sendable {
    public static let never: Int64 = -1
    public static let dayBefore: Int64 = -2
    /// The desktop's per-page choices for a timed page.
    public static let leadChoices: [Int64] = [0, 5, 10, 15, 30, 60, 120, 1440]

    public let stored: [Int64]

    public init(_ stored: [Int64]) {
        self.stored = stored
    }

    public static func choices(allDay: Bool) -> [Int64] {
        allDay ? [dayBefore] : leadChoices
    }

    public var isNever: Bool { stored == [Self.never] }
    public var own: [Int64] { stored.filter { $0 != Self.never }.sorted() }
    public var hasOwn: Bool { !own.isEmpty }

    /// Whether a choice reads as on: the page has it, or it is the default standing in for none.
    public func isOn(_ choice: Int64, allDay: Bool, defaultMinutes: Int64) -> Bool {
        if own.contains(choice) { return true }
        return !allDay && !hasOwn && !isNever && choice == defaultMinutes
    }

    /// The leads that will actually remind.
    public func effective(allDay: Bool, defaultMinutes: Int64) -> [Int64] {
        if isNever { return [] }
        if hasOwn { return own }
        return allDay || defaultMinutes < 0 ? [] : [defaultMinutes]
    }

    public enum Change: Equatable, Sendable {
        case remove(Int64)
        /// `clearingNever` when the page was set to never, which the new lead replaces.
        case add(Int64, clearingNever: Bool)
    }

    /// What tapping a choice writes: a lead the page has comes off, one it lacks goes on.
    public func toggling(_ choice: Int64) -> Change {
        own.contains(choice) ? .remove(choice) : .add(choice, clearingNever: isNever)
    }
}
