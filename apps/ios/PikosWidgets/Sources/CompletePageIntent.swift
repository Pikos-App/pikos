import AppIntents
import PikosCore
import PikosSupport
import WidgetKit

/// Tick a page from the widget, without opening the app.
///
/// The one write outside the app process: a `Button(intent:)` in a widget performs in the
/// extension's process, and running it in the app would mean bringing the app to the front, which
/// a home-screen tap avoids. A deliberate exception to the one-writer rule, safe because the
/// database layer sets a busy timeout and every write goes through `retry_on_busy`
/// (`crates/pikos-db/src/tx.rs`), which waits out another process's lock. A status flip is one
/// row in one short transaction. The rule guards against a long-lived second writer, and this
/// holds nothing past `perform`.
///
/// It does not remove the page's pending reminder: the app re-plans from the database on its next
/// wake, and that plan omits finished pages. It never migrates, because the widget only draws rows
/// the app wrote with the same build's schema.
struct CompletePageIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete page"
    static let description = IntentDescription(
        "Mark a page in Pikos as done.",
        categoryName: "Pages")

    /// Widget-only: Shortcuts already has the app target's intents.
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
        // WidgetKit reloads the tapped widget but not its neighbours, and the same page can be on
        // several, so every widget is reloaded and a tick on one is a tick on all.
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
