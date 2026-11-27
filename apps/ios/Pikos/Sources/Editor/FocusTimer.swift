import ActivityKit
import PikosCore
import PikosSupport
import SwiftUI

/// Timing how long you actually sat with a page.
///
/// Nothing is persisted while a session runs, since a session whose end the app never saw is a
/// guess, and a session under the floor is discarded rather than written. Neither the floor nor
/// the wording lives here: both are `pikos-core`'s, shared with the desktop.
///
/// Elapsed time is recomputed from the start instant on every tick rather than incremented: the
/// timer stops firing in the background, and a counter would come back light.
///
/// A running session is also a Live Activity, counted by the system from the same start instant
/// and ended with the session by whichever route.
///
/// A modifier on the page rather than a toolbar view: a toolbar item's `onAppear` never fires and
/// an alert attached there never shows.
struct FocusTimer: ViewModifier {
    let pageId: String
    /// The page's title, for the island. Read once at the start of a session.
    let title: String
    /// Held by the page, which hides its header while a session runs.
    @Binding var startedAt: Date?

    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(\.scenePhase) private var scenePhase

    @State private var elapsed = 0
    @State private var notice: String?
    /// The running session's Live Activity, held by id: `Activity` is not `Sendable` and ending
    /// one leaves the main actor, so a string crosses cleanly and the object is found again there.
    @State private var activityID: String?

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { control }
            }
            // Ticks only while a session runs. Keyed on the start instant, so starting cancels
            // nothing and stopping cancels the loop, rather than waking every second on every
            // open page.
            .task(id: startedAt) {
                guard let startedAt else { return }
                while !Task.isCancelled {
                    elapsed = Int(Date().timeIntervalSince(startedAt))
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            .onAppear {
                guard route.focusPageId == pageId else { return }
                route.focusPageId = nil
                if startedAt == nil { start() }
            }
            .onChange(of: scenePhase) { _, phase in
                // Coming back from the background: the ticks stopped, the clock did
                // not. Catch up before the next second would.
                if phase == .active, let startedAt {
                    elapsed = Int(Date().timeIntervalSince(startedAt))
                }
            }
            // Leaving the page banks the session where it is. `onDisappear` is the only hook that
            // fires for a back-swipe, and the work is detached because a Task tied to a view that
            // is going away may not finish.
            .onDisappear {
                guard let began = startedAt else { return }
                startedAt = nil
                endActivity()
                let id = pageId
                Task { await store.recordFocusSession(pageId: id, from: began, to: Date()) }
            }
            .alert(
                "Focus", isPresented: hasNotice,
                actions: { Button("OK", role: .cancel) { notice = nil } },
                message: { Text(notice ?? "") })
    }

    @ViewBuilder
    private var control: some View {
        if let startedAt {
            HStack(spacing: 6) {
                Text(store.focusElapsedLabel(seconds: elapsed))
                    .font(.pkUISm)
                    .monospacedDigit()
                    .foregroundStyle(.textAction)
                Button {
                    Task { await stop(began: startedAt) }
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .foregroundStyle(.textAction)
                }
                .accessibilityLabel("Stop timing")
            }
        } else {
            Button {
                start()
            } label: {
                Image(systemName: "timer")
                    .foregroundStyle(.textSecondary)
            }
            .accessibilityLabel("Start timing this page")
        }
    }

    private var hasNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }

    private func start() {
        let now = Date()
        startedAt = now
        elapsed = 0
        startActivity(from: now)
    }

    private func stop(began: Date) async {
        startedAt = nil
        elapsed = 0
        endActivity()
        // Stopping is otherwise invisible, and a silent discard below the floor reads like a
        // silent success.
        notice = await store.recordFocusSession(pageId: pageId, from: began, to: Date())
    }

    /// Put the session in the Dynamic Island. Best-effort: Live Activities can be switched off or
    /// refused by the system, and neither is a reason to refuse to time the page.
    private func startActivity(from began: Date) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = FocusActivityAttributes(
            pageId: pageId, title: title.isEmpty ? String(localized: "Untitled") : title)
        let content = ActivityContent(
            state: FocusActivityAttributes.ContentState(startedAt: began), staleDate: nil)
        activityID = (try? Activity.request(attributes: attributes, content: content, pushType: nil))?
            .id
    }

    /// Take it down immediately rather than on the system's schedule.
    private func endActivity() {
        guard let id = activityID else { return }
        activityID = nil
        Task { await Self.endActivity(id: id) }
    }

    /// Off the main actor deliberately, so the activity is looked up and ended
    /// in one isolation domain and never crosses one.
    private nonisolated static func endActivity(id: String) async {
        guard
            let running = Activity<FocusActivityAttributes>.activities
                .first(where: { $0.id == id })
        else { return }
        await running.end(nil, dismissalPolicy: .immediate)
    }
}
