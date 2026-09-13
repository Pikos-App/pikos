import PikosEditorBridge
import SwiftUI

/// The formatting controls above the keyboard.
///
/// Native, driven in both directions: active states come from the editor's
/// `selectionChanged` messages, and taps go back through `EditorController`.
/// The editor reports on focus as well as on movement precisely so this can be
/// correct the moment the user taps in — a toolbar that only heard about
/// movement would show the previous page's state.
struct FormattingToolbar: View {
    let selection: EditorSelection
    let controller: EditorController

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(EditorController.Mark.allCases, id: \.self) { mark in
                    markButton(mark)
                }

                Divider().frame(height: 22).padding(.horizontal, 4)

                blockButton(.heading(level: 1), label: "Heading", systemImage: "textformat.size")
                blockButton(.bulletList, label: "Bulleted list", systemImage: "list.bullet")
                blockButton(.orderedList, label: "Numbered list", systemImage: "list.number")
                blockButton(.taskList, label: "Task list", systemImage: "checklist")
                blockButton(.blockquote, label: "Quote", systemImage: "text.quote")
                blockButton(
                    .codeBlock, label: "Code block",
                    systemImage: "chevron.left.forwardslash.chevron.right")
            }
            // Horizontally scrollable because the full set does not fit at
            // larger Dynamic Type sizes, and dropping controls at those sizes
            // would take formatting away from exactly the people least able to
            // reach for an alternative.
            .padding(.horizontal, 4)
        }
    }

    private func markButton(_ mark: EditorController.Mark) -> some View {
        let active = selection.marks.contains(mark.rawValue)
        return Button {
            controller.toggleMark(mark)
        } label: {
            Image(systemName: symbol(for: mark))
                .frame(minWidth: 44, minHeight: 44)
                .background(
                    active ? Color.accentColor.opacity(0.15) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .accessibilityLabel(label(for: mark))
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private func blockButton(
        _ block: EditorController.Block, label: String, systemImage: String
    ) -> some View {
        let active = selection.nodeType == block.matchingNodeType
        return Button {
            controller.toggleBlock(block)
        } label: {
            Image(systemName: systemImage)
                .frame(minWidth: 44, minHeight: 44)
                .background(
                    active ? Color.accentColor.opacity(0.15) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private func symbol(for mark: EditorController.Mark) -> String {
        switch mark {
        case .bold: return "bold"
        case .italic: return "italic"
        case .underline: return "underline"
        case .strike: return "strikethrough"
        case .code: return "curlybraces"
        }
    }

    private func label(for mark: EditorController.Mark) -> String {
        switch mark {
        case .bold: return "Bold"
        case .italic: return "Italic"
        case .underline: return "Underline"
        case .strike: return "Strikethrough"
        case .code: return "Inline code"
        }
    }
}

extension EditorController.Block {
    /// The node type the editor reports when the caret is inside this block.
    ///
    /// Mostly the same string sent to toggle it, with one exception: a list's
    /// caret sits inside a `listItem` or `taskItem`, not the list itself, so
    /// matching on the toggle name would leave list buttons never looking
    /// active.
    var matchingNodeType: String {
        switch self {
        case .bulletList, .orderedList: return "listItem"
        case .taskList: return "taskItem"
        default: return nodeType
        }
    }
}
