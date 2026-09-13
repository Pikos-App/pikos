import SwiftUI

/// The formatting controls above the keyboard.
///
/// Native, and driven by the editor's `selectionChanged` messages — which is
/// why the editor reports on focus as well as on movement: a toolbar that only
/// heard about movement would show the previous page's state until the user
/// moved the caret.
///
/// Commands are not yet wired back to the editor. The bridge is one-directional
/// for formatting today, and adding the return path is M3 work; the toolbar
/// exists now because it is what makes `selectionChanged` worth having, and
/// because its active states are the visible proof the messages arrive.
struct FormattingToolbar: View {
    let selection: EditorSelection

    var body: some View {
        HStack(spacing: 4) {
            toggle("Bold", systemImage: "bold", mark: "bold")
            toggle("Italic", systemImage: "italic", mark: "italic")
            toggle("Underline", systemImage: "underline", mark: "underline")
            toggle("Strikethrough", systemImage: "strikethrough", mark: "strike")
            toggle("Code", systemImage: "chevron.left.forwardslash.chevron.right", mark: "code")

            Divider().frame(height: 20)

            // Node-level state, which is a different question from marks: the
            // caret is inside exactly one block, but can carry several marks.
            blockIndicator("Heading", systemImage: "textformat.size", nodeType: "heading")
            blockIndicator("List", systemImage: "list.bullet", nodeType: "listItem")
            blockIndicator("Task", systemImage: "checklist", nodeType: "taskItem")
            blockIndicator("Quote", systemImage: "text.quote", nodeType: "blockquote")

            Spacer()
        }
    }

    private func toggle(_ label: String, systemImage: String, mark: String) -> some View {
        let active = selection.marks.contains(mark)
        return Button {
            // Intentionally inert — see the note above.
        } label: {
            Label(label, systemImage: systemImage)
                .labelStyle(.iconOnly)
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private func blockIndicator(_ label: String, systemImage: String, nodeType: String) -> some View {
        let active = selection.nodeType == nodeType
        return Label(label, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .foregroundStyle(active ? Color.accentColor : Color.secondary)
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityLabel(label)
            .accessibilityAddTraits(active ? .isSelected : [])
    }
}
