import Foundation

/// Which words of a quick-add line the parser took, so the field can colour them where they were
/// typed.
///
/// The parser reports what it understood, not where. What it leaves behind is the title, so the
/// words of the line that are not in the title, in order, are the ones it read. A word-level
/// longest common subsequence finds them without a second grammar on this side.
public enum QuickAddHighlight {
    public enum Kind: Equatable, Sendable {
        /// A date, a time, a repeat or a reminder: everything the parser reads that has no sigil.
        case when
        case priority
        case tag
        case folder
        /// Everything after `//`.
        case note
    }

    public struct Token: Equatable, Sendable {
        public let range: Range<String.Index>
        public let kind: Kind
    }

    public static func tokens(in line: String, title: String) -> [Token] {
        let words = split(line)
        guard !words.isEmpty else { return [] }

        var tokens: [Token] = []
        var considered = words
        if let marker = line.range(of: "//") {
            tokens.append(Token(range: marker.lowerBound..<line.endIndex, kind: .note))
            considered = words.filter { $0.range.upperBound <= marker.lowerBound }
        }

        let titleWords = split(title).map { normalised(String(title[$0.range])) }
        let lineWords = considered.map { normalised(String(line[$0.range])) }
        let kept = commonSubsequence(lineWords, titleWords)

        for (index, word) in considered.enumerated() where !kept.contains(index) {
            tokens.append(Token(range: word.range, kind: kind(of: line[word.range])))
        }
        return tokens.sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    private struct Word {
        let range: Range<String.Index>
    }

    private static func split(_ text: String) -> [Word] {
        var words: [Word] = []
        var start: String.Index?
        for index in text.indices {
            if text[index].isWhitespace {
                if let begun = start { words.append(Word(range: begun..<index)) }
                start = nil
            } else if start == nil {
                start = index
            }
        }
        if let begun = start { words.append(Word(range: begun..<text.endIndex)) }
        return words
    }

    private static func normalised(_ word: String) -> String {
        word.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    private static func kind(of word: Substring) -> Kind {
        switch word.first {
        case "#": return .tag
        case "~": return .folder
        case "!": return .priority
        default: return .when
        }
    }

    /// Indices into `a` of one longest subsequence shared with `b`.
    private static func commonSubsequence(_ a: [String], _ b: [String]) -> Set<Int> {
        guard !a.isEmpty, !b.isEmpty else { return [] }
        var lengths = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                lengths[i][j] = a[i] == b[j] ? lengths[i + 1][j + 1] + 1 : max(lengths[i + 1][j], lengths[i][j + 1])
            }
        }
        var kept: Set<Int> = []
        var i = 0
        var j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] {
                kept.insert(i)
                i += 1
                j += 1
            } else if lengths[i + 1][j] >= lengths[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return kept
    }
}
