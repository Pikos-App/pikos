import SwiftUI

/// The bar that says what just happened, and offers the way back.
///
/// Drawn over the bottom of whichever screen is up, from `WorkspaceStore.notice`.
/// It is one view because it is one behaviour: a sentence, an optional action,
/// and a countdown. Two screens each drawing their own copy is how the undo
/// window comes to differ between them, and a reader who has learned one is
/// wrong-footed by the other. The window is the desktop's eight seconds, for
/// the same reason across the two apps.
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
                .font(.pkBodySm)
                .foregroundStyle(.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action = notice.action {
                Button(action.title) {
                    Task {
                        await action.perform()
                        onDismiss()
                    }
                }
                .font(.system(.subheadline, weight: .semibold))
                .foregroundStyle(.textAction)
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
        // Glass on iOS 26, a material elsewhere: the bar floats in the
        // navigation layer over content, which is the one place the new
        // design language puts glass.
        .floatingSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .transition(.opacity)
        .accessibilityElement(children: .contain)
        // Keyed on the notice, so a second one restarts the countdown instead
        // of inheriting the first one's remaining time.
        .task(id: notice) {
            try? await Task.sleep(for: .seconds(8))
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
        bottomChrome { EmptyView() }
    }

    /// The screen's floating bar and its notice, laid out together so the notice sits above the bar
    /// instead of covering it.
    func bottomChrome<Floating: View>(@ViewBuilder floating: @escaping () -> Floating) -> some View {
        modifier(BottomChrome(floating: floating))
    }
}

private struct BottomChrome<Floating: View>: ViewModifier {
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let floating: () -> Floating

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            VStack(spacing: 10) {
                if let notice = store.notice {
                    NoticeBar(notice: notice) {
                        // Only clear the notice this bar was drawn for. By the
                        // time the countdown ends a newer one may have
                        // replaced it, and clearing that would cut its window
                        // short.
                        if store.notice == notice {
                            withAnimation(reduceMotion ? nil : .pkQuick) { store.notice = nil }
                        }
                    }
                }
                floating()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .pkQuick, value: store.notice)
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
