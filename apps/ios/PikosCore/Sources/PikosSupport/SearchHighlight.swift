import Foundation

/// Where a search result's matched words sit in its text.
///
/// Mirrors the desktop palette's highlighter: each term the index matched on is
/// marked wherever it appears, case- and diacritic-insensitively, including
/// inside a longer word, because the last term is a prefix match.
public enum SearchHighlight {
    public static func ranges(in text: String, terms: [String]) -> [Range<String.Index>] {
        var found: [Range<String.Index>] = []
        for term in terms where !term.isEmpty {
            var searchStart = text.startIndex
            while searchStart < text.endIndex,
                let match = text.range(
                    of: term, options: [.caseInsensitive, .diacriticInsensitive],
                    range: searchStart..<text.endIndex)
            {
                found.append(match)
                searchStart = match.upperBound
            }
        }
        return merged(found.sorted { $0.lowerBound < $1.lowerBound })
    }

    /// A passage made to show its match on one line of a phone.
    ///
    /// The data layer centres its excerpt on the match with sixty characters either
    /// side, sized for the desktop palette; a phone row holds under fifty, so the
    /// match would be cut off past the end. Each line of the passage is a block of
    /// the page, so lines are joined with a middle dot rather than run together
    /// into one false sentence, and the lead-in before the first match is cut back
    /// to `context` characters at a word boundary.
    public static func leadIn(_ text: String, terms: [String], context: Int = 24) -> String {
        let flat = text.split(whereSeparator: \.isNewline)
            .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        guard let first = ranges(in: flat, terms: terms).first else { return flat }
        let offset = flat.distance(from: flat.startIndex, to: first.lowerBound)
        guard offset > context else { return flat }
        let target = flat.index(first.lowerBound, offsetBy: -context)
        let cut = flat[target..<first.lowerBound].firstIndex(of: " ").map { flat.index(after: $0) } ?? target
        return "…" + flat[cut...].drop(while: { $0 == "…" || $0 == "·" || $0 == " " })
    }

    public static func attributed(
        _ text: String, terms: [String], apply: (inout AttributeContainer) -> Void
    ) -> AttributedString {
        var result = AttributedString(text)
        var container = AttributeContainer()
        apply(&container)
        for range in ranges(in: text, terms: terms) {
            guard let lower = AttributedString.Index(range.lowerBound, within: result),
                let upper = AttributedString.Index(range.upperBound, within: result)
            else { continue }
            result[lower..<upper].mergeAttributes(container)
        }
        return result
    }

    private static func merged(_ sorted: [Range<String.Index>]) -> [Range<String.Index>] {
        var out: [Range<String.Index>] = []
        for range in sorted {
            if let last = out.last, range.lowerBound <= last.upperBound {
                out[out.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                out.append(range)
            }
        }
        return out
    }
}
