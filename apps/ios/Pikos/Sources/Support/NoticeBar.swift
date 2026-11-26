import SwiftUI

/// The bar that says what just happened, and offers the way back, drawn from
/// `WorkspaceStore.notice` over the bottom of whichever screen is up.
///
/// One view so the undo window can't differ between screens; it is the desktop's eight seconds.
/// It clears itself: every action it describes is reversible from elsewhere in the app, so a bar
/// waiting to be dismissed is worse than a missed undo.
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
    /// Show the store's current notice over this view.
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
                        // Only clear the notice this bar was drawn for: a newer one may have replaced it by the
                        // time the countdown ends.
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
        // Said aloud as well as shown: VoiceOver would only find the bar by sweeping down to it,
        // and "Deleted, Undo" has to reach the person before it goes.
        .onChange(of: store.notice) { _, notice in
            guard let notice else { return }
            var spoken = notice.message
            if let action = notice.action { spoken += ". \(action.title) available." }
            AccessibilityNotification.Announcement(spoken).post()
        }
    }
}
