import ActivityKit
import PikosCore
import PikosSupport
import SwiftUI

/// Timing how long you actually sat with a page.
///
/// Two limits so the number stays something its owner can account for: nothing is persisted
/// while a session runs, since a session whose end the app never saw is a guess, and a session
/// under the floor is discarded, since opening a page and tapping play is not focus time. The
/// floor and the wording are `pikos-core`'s, shared with the desktop.
///
/// The elapsed count is recomputed from the start instant on every tick, not incremented: the
/// timer stops firing in the background, and a counter would come back minutes light. While a
/// session runs it is also a Live Activity, counted by the system from the same start instant,
/// and it ends with the session by whichever route.
struct FocusTimer: View {
    let pageId: String
    /// The page's title, for the island. Read once at the start of a session.
    let title: String

    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(\.scenePhase) private var scenePhase

    @State private var startedAt: Date?
    @State private var elapsed = 0
    @State private var notice: String?
    /// Held by id: `Activity` is not `Sendable` and ending one leaves the main actor, so a string
    /// crosses cleanly and the object is found again on the side that ends it.
    @State private var activityID: String?

    var body: some View {
        Group {
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
        // Ticks only while a session runs: keyed on the start instant, so stopping cancels the loop.
        // A publisher firing every second would wake the app for a clock showing nothing.
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
        // Leaving the page banks the session where it is. `onDisappear` is the only hook that fires
        // for a back-swipe, and the work is detached because a Task tied to a leaving view may not finish.
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
        // Both outcomes are worth a sentence: stopping is otherwise invisible, and a silent discard
        // below the floor reads like a silent success.
        notice = await store.recordFocusSession(pageId: pageId, from: began, to: Date())
    }

    // MARK: - The Live Activity

    /// Put the session in the Dynamic Island. Best-effort: Live Activities can be switched off, or
    /// refused when the system has too many, and neither is a reason to refuse to time the page.
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
