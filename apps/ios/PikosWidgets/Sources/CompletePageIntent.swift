import AppIntents
import PikosCore
import PikosSupport
import WidgetKit

/// Tick a page from the widget, without opening the app.
///
/// ## The one write outside the app process
///
/// Everything else the widget does goes through `ReadOnlyWorkspace`, and the
/// app's intents live in the app target so their writes run in the app's
/// process. This intent cannot: a `Button(intent:)` in a widget performs in
/// the widget extension's process, and there is no way to ask the system to
/// run it in the app instead without bringing the app to the front — which is
/// the thing a tap on the home screen is meant to avoid.
///
/// So this is a deliberate exception to the one-writer rule, and it is safe
/// for a reason worth stating rather than assuming. The database layer was
/// built for a desktop app, a CLI and a sync poller sharing one file: its pool
/// sets a busy timeout, and every write goes through `retry_on_busy`, which
/// waits out another process's lock and retries a lost snapshot race
/// (`crates/pikos-db/src/tx.rs`). A status flip is one row in one short
/// transaction. If the app is mid-write when it lands, one of the two waits a
/// few milliseconds; neither loses. What the rule really guards against is a
/// *long-lived* second writer — a widget refresh holding a handle across a
/// timeline — and this holds nothing past its own `perform`.
///
/// Two things it does not do. It does not remove the page's pending reminder:
/// the app re-plans the horizon from the database on its next foreground or
/// background wake, and that plan omits finished pages. And it does not run
/// migrations by intent: `Workspace.open` would, if the schema were behind,
/// but the widget only ever draws rows the app has already written with the
/// same build's schema, so the case cannot arise from a tap on one of them.
struct CompletePageIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete page"
    static let description = IntentDescription(
        "Mark a page in Pikos as done.",
        categoryName: "Pages")

    /// Widget-only. Shortcuts already has the app target's intents, and a page
    /// id is not a parameter anybody types.
    static let isDiscoverable = false

    @Parameter(title: "Page")
    var pageId: String

    @Parameter(title: "Done")
    var done: Bool

    init() {}

    init(pageId: String, done: Bool) {
        self.pageId = pageId
        self.done = done
    }

    func perform() async throws -> some IntentResult {
        let url = try WorkspaceLocation.databaseURL()
        let workspace = try await Workspace.open(path: url.path)
        try await workspace.setPageStatus(pageId: pageId, done: done)
        // WidgetKit reloads the tapped widget's timeline itself once the
        // intent returns, but not its neighbours' — and the same page can be
        // on Today, Next Up and Inbox at once. Every widget is reloaded so a
        // tick on one is a tick on all of them; the app refreshes its own
        // list when it next comes to the foreground.
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
