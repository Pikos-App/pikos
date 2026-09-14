import PikosEditorBridge
import SwiftUI

/// The formatting controls above the keyboard.
///
/// Native, driven in both directions: active states come from the editor's
/// `selectionChanged` messages, and taps go back through `EditorController`.
/// The editor reports on focus as well as on movement precisely so this can be
/// correct the moment the user taps in — a toolbar that only heard about
/// movement would show the previous page's state.
///
/// What is on the bar itself is what a phone reaches for while typing a note:
/// bold, italic, a bullet list, a checklist, a photo. Everything else —
/// underline, strikethrough, inline code, headings, numbered lists, quotes,
/// code blocks — is one tap away under "Aa", the way Notes arranges it. All
/// fourteen in a row was 616 points of controls on a 390-point screen, with
/// strikethrough and inline code on the first screen and the checklist off it.
///
/// The last control puts the keyboard away. A webview's keyboard has no
/// "Done" of its own, and a text surface that fills the screen leaves nowhere
/// else to tap to dismiss it — so without this the only way to see the whole
/// page again is to scroll the keyboard off interactively, which nobody
/// discovers by accident.
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
            .foregroundStyle(Color.primary)
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
            .foregroundStyle(Color.primary)
            .accessibilityLabel("Hide keyboard")
        }
        .padding(.horizontal, 4)
    }

    /// The rest of the formatting, with the current state ticked.
    ///
    /// A menu rather than a second row: it costs one tap for the rarer
    /// controls and nothing for the common ones, and it stays readable at
    /// the accessibility text sizes, where a second row of icons would not
    /// fit either.
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
                    hasActiveExtra ? Color.accentColor.opacity(0.15) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .foregroundStyle(hasActiveExtra ? Color.accentColor : Color.primary)
        .accessibilityLabel("More formatting")
    }

    /// Whether something behind the menu is active at the caret, so the
    /// button can say so without being opened — a heading the bar would
    /// otherwise show no sign of.
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
