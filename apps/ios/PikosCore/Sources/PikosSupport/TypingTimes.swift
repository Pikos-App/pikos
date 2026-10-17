import Foundation

/// The editor's keystroke timings over a session, from the batches it reports after each pause.
///
/// The median is the median of the batches' medians, weighted by how many keystrokes each held:
/// the editor sends a summary rather than every sample, and a long burst should count for more
/// than one stray keystroke.
public struct TypingTimes: Equatable, Sendable {
    public private(set) var count = 0
    public private(set) var worstMs = 0.0
    private var batches: [(medianMs: Double, count: Int)] = []

    public init() {}

    public mutating func add(count: Int, medianMs: Double, worstMs: Double) {
        guard count > 0 else { return }
        self.count += count
        self.worstMs = max(self.worstMs, worstMs)
        batches.append((medianMs, count))
    }

    public var medianMs: Double {
        let sorted = batches.sorted { $0.medianMs < $1.medianMs }
        var seen = 0
        for batch in sorted {
            seen += batch.count
            if seen * 2 > count { return batch.medianMs }
        }
        return 0
    }

    /// "Typing: 9 ms median, 31 ms worst, 120 keys".
    public var summary: String {
        "Typing: \(Int(medianMs.rounded())) ms median, \(Int(worstMs.rounded())) ms worst, \(count) keys"
    }

    public static func == (lhs: TypingTimes, rhs: TypingTimes) -> Bool {
        lhs.count == rhs.count && lhs.worstMs == rhs.worstMs && lhs.medianMs == rhs.medianMs
    }
}
