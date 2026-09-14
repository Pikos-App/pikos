import SwiftUI

/// The bar that says what just happened, and offers the way back.
///
/// Drawn over the bottom of whichever screen is up, from `WorkspaceStore.notice`.
/// It is one view because it is one behaviour: a sentence, an optional action,
/// and a countdown. Two screens each drawing their own copy is how the undo
/// window comes to be six seconds on one and eight on the other, and a reader
/// who has learned one is wrong-footed by the other.
///
/// It clears itself rather than waiting to be dismissed. A bar sitting over the
/// bottom of a list until somebody notices it is worse than a missed undo —
/// every action it describes is reversible from elsewhere in the app, and the
/// bar is a convenience, not the only way back.
struct NoticeBar: View {
    let notice: WorkspaceStore.Notice
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(notice.message)
                .font(.subheadline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action = notice.action {
                Button(action.title) {
                    Task {
                        await action.perform()
                        onDismiss()
                    }
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        // Keyed on the notice, so a second one restarts the countdown instead
        // of inheriting the first one's remaining time.
        .task(id: notice) {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            onDismiss()
        }
    }
}

extension View {
    /// Show the store's current notice over this view.
    ///
    /// Applied to each tab's root screen rather than to the `TabView`: an
    /// overlay on the tab view would sit over the tab bar, and one on the
    /// screen sits just above it, which is where a bar the user might tap
    /// belongs.
    func noticeOverlay() -> some View {
        modifier(NoticeOverlay())
    }
}

private struct NoticeOverlay: ViewModifier {
    @Environment(WorkspaceStore.self) private var store

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let notice = store.notice {
                NoticeBar(notice: notice) {
                    // Only clear the notice this bar was drawn for. By the time
                    // the countdown ends a newer one may have replaced it, and
                    // clearing that would cut its window short.
                    if store.notice == notice {
                        withAnimation(.snappy) { store.notice = nil }
                    }
                }
            }
        }
        .animation(.snappy, value: store.notice)
        // Said aloud as well as shown. A bar that appears for six seconds at
        // the bottom of the screen is one VoiceOver would only find by
        // sweeping down to it, and "Deleted — Undo" is exactly the sentence
        // that has to reach the person before it goes.
        .onChange(of: store.notice) { _, notice in
            guard let notice else { return }
            var spoken = notice.message
            if let action = notice.action { spoken += ". \(action.title) available." }
            AccessibilityNotification.Announcement(spoken).post()
        }
    }
}
