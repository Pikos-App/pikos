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
        case search
    }

    var tab: Tab = .pages
    var isQuickAddPresented = false

    /// Show today's pages. Also the landing point for the "Open today" intent,
    /// which has no view to route through and moves this state directly.
    func showToday(store: WorkspaceStore? = nil) {
        tab = .pages
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

        switch link {
        case .view(let viewId):
            tab = .pages
            let scope: WorkspaceStore.Scope = viewId == .today ? .today : .inbox
            store.scope = scope
            pendingScope = scope

        case .page:
            // Navigating to a specific page needs a navigation path the list
            // screen owns; wiring that is the next step. Landing on the list is
            // a poor answer but an honest one — better than appearing to work
            // and showing the wrong page.
            tab = .pages

        case .calendar:
            // No calendar screen yet (M3). Today is the nearest thing.
            showToday(store: store)

        case .quickAdd:
            // The prefill is dropped for now: quick add has no free-text date
            // parsing on iOS yet, so a prefill like "tomorrow at 3pm" would be
            // taken literally as a title. See docs/ios/04-parser-grammar.md.
            tab = .pages
            isQuickAddPresented = true

        case .search:
            tab = .search
        }
    }
}
