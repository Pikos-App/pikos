import PikosEditorBridge
import SwiftUI

/// The formatting controls above the keyboard.
///
/// Active states come from the editor's `selectionChanged` messages, which it reports on focus as
/// well as movement so the bar is right the moment the user taps in. Taps go back through
/// `EditorController`. The bar holds what a phone reaches for while typing and the rest is under
/// "Aa", as in Notes: all fourteen in a row was 616 points on a 390-point screen. The last
/// control puts the keyboard away, since a webview's keyboard has no "Done" and the text surface
/// fills the screen.
struct FormattingToolbar: View {
    let selection: EditorSelection
    let controller: EditorController
    /// Open the photo picker. The editor inserts what the host writes; see
    /// `EditorScreen.insert(photo:)`.
    let onInsertImage: () -> Void
    let onDismissKeyboard: () -> Void

    var body: some View {
        HStack(spacing: 2) {
            markButton(.bold, systemImage: "bold")
            markButton(.italic, systemImage: "italic")
            blockButton(.bulletList, label: "Bulleted list", systemImage: "list.bullet")
            blockButton(.taskList, label: "Task list", systemImage: "checklist")

            Divider().frame(height: 22).padding(.horizontal, 2)

            Button(action: onInsertImage) {
                Image(systemName: "photo")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.textSecondary)
            .accessibilityLabel("Insert photo")

            moreMenu

            Spacer(minLength: 0)

            Divider().frame(height: 22)

            // Pinned at the end so it is always where the thumb expects it.
            Button(action: onDismissKeyboard) {
                Image(systemName: "keyboard.chevron.compact.down")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.textSecondary)
            .accessibilityLabel("Hide keyboard")
        }
        .padding(.horizontal, 4)
    }

    /// The rest of the formatting, with the current state ticked. A menu, not a second row, which
    /// would not fit at the accessibility text sizes either.
    private var moreMenu: some View {
        Menu {
            Section("Text") {
                markItem(.underline, label: "Underline", systemImage: "underline")
                markItem(.strike, label: "Strikethrough", systemImage: "strikethrough")
                markItem(.code, label: "Inline code", systemImage: "curlybraces")
            }
            Section("Block") {
                blockItem(.heading(level: 1), label: "Heading", systemImage: "textformat.size")
                blockItem(.orderedList, label: "Numbered list", systemImage: "list.number")
                blockItem(.blockquote, label: "Quote", systemImage: "text.quote")
                blockItem(
                    .codeBlock, label: "Code block",
                    systemImage: "chevron.left.forwardslash.chevron.right")
            }
        } label: {
            Image(systemName: "textformat")
                .frame(minWidth: 44, minHeight: 44)
                .background(
                    hasActiveExtra ? Color.surfaceSelected : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .foregroundStyle(hasActiveExtra ? Color.textAction : Color.textSecondary)
        .accessibilityLabel("More formatting")
    }

    /// Whether something behind the menu is active at the caret, so the button shows it unopened.
    private var hasActiveExtra: Bool {
        let extraMarks: [EditorController.Mark] = [.underline, .strike, .code]
        if extraMarks.contains(where: { selection.marks.contains($0.rawValue) }) { return true }
        let extraBlocks: [EditorController.Block] = [
            .heading(level: 1), .orderedList, .blockquote, .codeBlock,
        ]
        return extraBlocks.contains { $0.matchingNodeType == selection.nodeType }
    }

    // MARK: - Bar buttons

    private func markButton(_ mark: EditorController.Mark, systemImage: String) -> some View {
        let active = selection.marks.contains(mark.rawValue)
        return Button {
            controller.toggleMark(mark)
        } label: {
            Image(systemName: systemImage)
                .frame(minWidth: 44, minHeight: 44)
                .background(
                    active ? Color.surfaceSelected : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.textAction : Color.textSecondary)
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
                    active ? Color.surfaceSelected : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.textAction : Color.textSecondary)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: - Menu items

    private func markItem(_ mark: EditorController.Mark, label: String, systemImage: String)
        -> some View
    {
        let active = selection.marks.contains(mark.rawValue)
        return Button {
            controller.toggleMark(mark)
        } label: {
            Label(label, systemImage: active ? "checkmark" : systemImage)
        }
    }

    private func blockItem(_ block: EditorController.Block, label: String, systemImage: String)
        -> some View
    {
        let active = selection.nodeType == block.matchingNodeType
        return Button {
            controller.toggleBlock(block)
        } label: {
            Label(label, systemImage: active ? "checkmark" : systemImage)
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
