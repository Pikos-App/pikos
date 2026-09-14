import ActivityKit
import PikosCore
import PikosSupport
import SwiftUI

/// Timing how long you actually sat with a page.
///
/// Two limits, both so the number stays something its owner can account for.
/// Nothing is persisted while a session runs — a session whose end the app never
/// saw is a guess, and a guess inside a total is worse than a missing session —
/// and a session under the floor is discarded rather than written, because
/// opening a page, tapping play and moving on is not focus time.
///
/// Neither the floor nor the wording lives here. Both are `pikos-core`'s, shared
/// with the desktop and graded against it, so "24 minutes" means the same
/// sentence on both.
///
/// The elapsed count is recomputed from the start instant on every tick rather
/// than incremented. On a phone that matters more than it does on a desktop: the
/// timer stops firing the moment the app is backgrounded, and a counter that
/// added one per tick would come back minutes light while looking perfectly
/// plausible.
///
/// While a session runs it is also a Live Activity: the Dynamic Island and
/// the lock screen show the clock, counted by the system from the same start
/// instant, so a person who has put the phone down to actually focus can see
/// the session is still running without picking it up. The island's tap
/// opens the page. It ends when the session does, by whichever route.
struct FocusTimer: View {
    let pageId: String
    /// The page's title, for the island. Read once at the start of a session.
    let title: String

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    @State private var startedAt: Date?
    @State private var elapsed = 0
    @State private var notice: String?
    @State private var activity: Activity<FocusActivityAttributes>?

    var body: some View {
        Group {
            if let startedAt {
                HStack(spacing: 6) {
                    Text(store.focusElapsedLabel(seconds: elapsed))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Button {
                        Task { await stop(began: startedAt) }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                    }
                    .accessibilityLabel("Stop timing")
                }
            } else {
                Button {
                    start()
                } label: {
                    Image(systemName: "timer")
                }
                .accessibilityLabel("Start timing this page")
            }
        }
        // Ticks only while a session runs. Keyed on the start instant, so
        // starting cancels nothing and stopping cancels the loop — a timer
        // publisher that fired every second for the life of the toolbar, as
        // this once was, was a wake-up a second on every open page for a clock
        // that was showing nothing.
        .task(id: startedAt) {
            guard let startedAt else { return }
            while !Task.isCancelled {
                elapsed = Int(Date().timeIntervalSince(startedAt))
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from the background: the ticks stopped, the clock did
            // not. Catch up before the next second would.
            if phase == .active, let startedAt {
                elapsed = Int(Date().timeIntervalSince(startedAt))
            }
        }
        // Leaving the page banks the session where it is rather than dropping
        // it. `onDisappear` is the only hook that fires for a back-swipe, and
        // the work is detached from the view's lifetime on purpose — a Task tied
        // to a view that is going away is a Task that may not finish.
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
        // Both outcomes are worth a sentence. Stopping is otherwise invisible —
        // the row goes to a screen nobody is looking at — and a silent discard
        // below the floor reads exactly like a silent success.
        notice = await store.recordFocusSession(pageId: pageId, from: began, to: Date())
    }

    // MARK: - The Live Activity

    /// Put the session in the Dynamic Island.
    ///
    /// Best-effort throughout. Live Activities can be switched off per app,
    /// and the request can fail when the system has too many; neither is a
    /// reason to refuse to time the page, so a failure here is a session
    /// with no island and nothing said.
    private func startActivity(from began: Date) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = FocusActivityAttributes(
            pageId: pageId, title: title.isEmpty ? String(localized: "Untitled") : title)
        let content = ActivityContent(
            state: FocusActivityAttributes.ContentState(startedAt: began), staleDate: nil)
        activity = try? Activity.request(attributes: attributes, content: content, pushType: nil)
    }

    /// Take it down. Immediately rather than on the system's schedule: a
    /// session that has ended is not something to keep showing for the
    /// minutes the default dismissal would allow.
    private func endActivity() {
        guard let running = activity else { return }
        activity = nil
        Task { await running.end(nil, dismissalPolicy: .immediate) }
    }
}
