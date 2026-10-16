import Observation
import PikosCore
import PikosSupport
import SwiftUI

/// Where the app is, and what an incoming link asks it to do.
///
/// `pikos://` links arrive from notifications, widgets, App Intents and the
/// share sheet. The grammar is shared with the desktop app — parsed by the same
/// Rust code, so a link that works on one works on the other.
@MainActor
@Observable
final class Route {
    /// One router for the process.
    ///
    /// Shared rather than created per view because App Intents reach it through
    /// `AppDependencyManager`, which is registered before any view exists — and
    /// reading a `@State` wrapper outside a view body to register it would be
    /// undefined.
    ///
    /// `nonisolated` because the dependency manager's factory closure is
    /// `@Sendable` and not on any actor, and under strict concurrency a
    /// main-actor static cannot be read from there. The reference itself is
    /// safe to hand out from anywhere — it is immutable, and every member on
    /// it is still main-actor isolated, so a caller off the main actor can hold
    /// the router but not move it. The initialiser is `nonisolated` for the
    /// same reason: it touches nothing but stored-property defaults.
    nonisolated static let shared = Route()

    nonisolated init() {}

    /// Which half of the desktop's right-hand panel fills the phone: the pages, or the calendar.
    enum Pane: String, Hashable {
        case list
        case week
    }

    enum Destination: Hashable {
        case page(String)
        case search
    }

    var pane: Pane = .list

    /// One stack for the whole app. Held here rather than by a screen so a deep
    /// link, a widget tap or an App Intent can push from outside it.
    var path: [Destination] = []

    var isQuickAddPresented = false
    /// Text to open quick add with, from a `pikos://quick-add?text=…` link.
    /// Cleared when the sheet closes so the next manual open starts empty.
    var quickAddPrefill = ""
    /// A time to open quick add already scheduled for, from a long press on
    /// an empty calendar slot. Cleared with the text, for the same reason.
    var quickAddPrefillDate: Date?

    /// The view quick add was opened from, which a line that says nothing else lands in.
    struct QuickAddContext {
        var day: String?
        var folderId: String?
    }

    var quickAddContext = QuickAddContext()

    /// A line swiped away before it was added, offered again when quick add next opens empty.
    var quickAddDraft = ""

    /// Quick add from the bar, landing where the reader is looking: `pane` is the one the bar sits
    /// under, which is the list whenever both are on screen.
    func presentQuickAdd(from store: WorkspaceStore, under pane: Pane) {
        quickAddPrefill = ""
        quickAddPrefillDate = nil
        switch (pane, store.scope) {
        case (.week, _): quickAddContext = QuickAddContext(day: calendarDay)
        case (.list, .today): quickAddContext = QuickAddContext(day: DayLabel.today())
        case (.list, .folder(let id, _)): quickAddContext = QuickAddContext(folderId: id)
        case (.list, _): quickAddContext = QuickAddContext()
        }
        isQuickAddPresented = true
    }

    /// Text to open search with, from a `pikos://search` link. The search screen takes it when it appears.
    var searchPrefill = ""

    /// Select mode hands the bottom of the screen to the list's verbs, so the shell's bar steps aside.
    var isSelectingPages = false

    var isSwitcherPresented = false
    var isSettingsPresented = false
    var isTrashPresented = false
    var isFolderManagerPresented = false

    /// The day the week pane should show next time it appears, when something outside it asked.
    var weekFocus: Date?

    /// The day the calendar is anchored on, and the span it shows from there. Held here rather
    /// than by the calendar, so a shell rebuilt around it, as when an iPhone Duo unfolds, opens on
    /// what it was showing.
    var calendarAnchor = Date()
    var calendarSpan: CalendarSpan?

    /// The `YYYY-MM-DD` the calendar pane is on, so a page added from there lands on that day.
    var calendarDay: String { WallClockDay.string(from: calendarAnchor) }

    /// The page open on top of the workspace, if any.
    var openPageId: String? {
        guard case .page(let id) = path.last else { return nil }
        return id
    }

    /// Quick add with the slot's time already chosen, so the sentence typed names the page, not the time.
    func presentQuickAdd(at date: Date) {
        quickAddPrefill = ""
        quickAddPrefillDate = date
        isQuickAddPresented = true
    }

    /// Forget both prefills. Called when the sheet closes, whatever opened it.
    func clearQuickAddPrefill() {
        quickAddPrefill = ""
        quickAddPrefillDate = nil
        quickAddContext = QuickAddContext()
    }

    func open(page id: String) {
        path.append(.page(id))
    }

    func showWeek(on day: Date) {
        weekFocus = day
        isSwitcherPresented = false
        pane = .week
    }

    /// Show today's pages. Also the landing point for the "Open today" intent,
    /// which has no view to route through and moves this state directly.
    func showToday(store: WorkspaceStore? = nil) {
        pane = .list
        path = []
        store?.scope = .today
        pendingScope = .today
    }

    /// A scope an entry point asked for before the store was ready.
    ///
    /// App Intents and deep links can arrive while the app is still launching,
    /// before the workspace has opened. Recording the request and applying it
    /// once the store exists beats dropping it — the alternative is a widget
    /// tap that sometimes works.
    var pendingScope: WorkspaceStore.Scope?

    /// Apply anything an entry point asked for before the store was ready.
    func applyPending(to store: WorkspaceStore) {
        guard let pendingScope else { return }
        store.scope = pendingScope
        self.pendingScope = nil
    }

    /// Act on a deep link.
    ///
    /// Unrecognised links are ignored rather than surfaced. They arrive from
    /// outside the app — a stale notification, a link someone typed — and there
    /// is nothing useful to tell the user about one.
    func handle(_ url: URL, store: WorkspaceStore) {
        guard let link = parseDeepLink(url: url.absoluteString) else { return }
        isSwitcherPresented = false

        // A link that navigates empties the stack; one that presents leaves the open page alone.
        switch link {
        case .view(let viewId):
            pane = .list
            path = []
            // Exhaustive: an if/else here is how `pikos://upcoming` once silently did nothing.
            let scope: WorkspaceStore.Scope =
                switch viewId {
                case .today: .today
                case .upcoming: .upcoming
                case .inbox: .inbox
                }
            store.scope = scope
            pendingScope = scope

        case .page(let pageId):
            // A jump, not a step: appending would build a back stack nobody walked.
            path = [.page(pageId)]

        case .calendar:
            path = []
            showWeek(on: Date())

        case .quickAdd(let prefill):
            quickAddPrefill = prefill
            quickAddPrefillDate = nil
            isQuickAddPresented = true

        case .search(let prefill):
            searchPrefill = prefill
            path = [.search]
        }
    }
}
