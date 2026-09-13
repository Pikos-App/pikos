import Observation
import PikosCore
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
    static let shared = Route()

    enum Tab: Hashable {
        case pages
        case calendar
        case search
    }

    var tab: Tab = .pages

    /// What each tab's navigation stack has pushed, as page ids.
    ///
    /// Held here rather than by the screens, so that something outside a screen
    /// — a deep link, a widget tap, an App Intent — can push. The screens are
    /// content; the container owns navigation.
    ///
    /// One per tab, because the tabs are independent on a phone. An iPad split
    /// view has a single detail column instead and would read the active tab's
    /// `.last` as its selection; keeping the paths here rather than inside the
    /// screens is what makes that a change of shell rather than a rewrite of
    /// every screen.
    var pagesPath: [String] = []
    var calendarPath: [String] = []
    var searchPath: [String] = []

    var isQuickAddPresented = false
    /// Text to open quick add with, from a `pikos://quick-add?text=…` link.
    /// Cleared when the sheet closes so the next manual open starts empty.
    var quickAddPrefill = ""

    /// Show today's pages. Also the landing point for the "Open today" intent,
    /// which has no view to route through and moves this state directly.
    func showToday(store: WorkspaceStore? = nil) {
        tab = .pages
        pagesPath = []
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

        // A link that *navigates* returns its tab to the root first; a link
        // that merely *presents* does not. Without that, "show me today" from a
        // widget would select the Pages tab and leave whatever editor was open
        // sitting on top of the list it was asked to show — the stack survives
        // now that the shell owns it, which it did not when each screen kept
        // its own.
        switch link {
        case .view(let viewId):
            tab = .pages
            pagesPath = []
            // Exhaustive rather than a ternary. The Rust side had exactly this
            // as an if/else over two views, which is how `pikos://upcoming`
            // came to be a link that silently did nothing when the desktop
            // grew a third.
            let scope: WorkspaceStore.Scope =
                switch viewId {
                case .today: .today
                case .upcoming: .upcoming
                case .inbox: .inbox
                }
            store.scope = scope
            pendingScope = scope

        case .page(let pageId):
            // Replaces the stack rather than appending to it. A link is a jump,
            // not a step: appending would build a back stack of pages the user
            // never navigated through, and tapping back would walk them.
            tab = .pages
            pagesPath = [pageId]

        case .calendar:
            tab = .calendar
            calendarPath = []

        case .quickAdd(let prefill):
            // The prefill is parsed like anything typed by hand, so a link
            // carrying "tomorrow at 3pm" schedules rather than naming a page
            // that. Presents rather than navigates, so the stack is left
            // alone: a quick-add link arriving while a page is open should
            // give the user the sheet and their page back, not lose their
            // place.
            quickAddPrefill = prefill
            tab = .pages
            isQuickAddPresented = true

        case .search:
            tab = .search
            searchPath = []
        }
    }
}
