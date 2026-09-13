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
    enum Tab: Hashable {
        case pages
        case search
    }

    var tab: Tab = .pages
    var isQuickAddPresented = false

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
            store.scope = viewId == .today ? .today : .inbox

        case .page:
            // Navigating to a specific page needs a navigation path the list
            // screen owns; wiring that is the next step. Landing on the list is
            // a poor answer but an honest one — better than appearing to work
            // and showing the wrong page.
            tab = .pages

        case .calendar:
            // No calendar screen yet (M3). Today is the nearest thing.
            tab = .pages
            store.scope = .today

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
