import AppIntents
import PikosSupport
import WidgetKit

/// Tick a page from the widget, without opening the app.
///
/// This is the one write outside the app process. Everything else the widget does goes through
/// `ReadOnlyWorkspace`, but a `Button(intent:)` in a widget performs in the extension's process,
/// and running it in the app would bring the app to the front, which a home-screen tap avoids.
///
/// It is a deliberate exception to the one-writer rule, and safe: the database layer expects
/// several processes sharing one file (a busy timeout, and every write through `retry_on_busy`,
/// `crates/pikos-db/src/tx.rs`), and a status flip is one row in one short transaction. The rule
/// guards against a long-lived second writer, and this holds nothing past its own `perform`.
///
/// It does not remove the page's pending reminder: the app re-plans from the database on its next
/// wake, and that plan omits finished pages. It runs no migrations: the widget only draws rows the
/// app wrote with the same build's schema.
struct CompletePageIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete page"
    static let description = IntentDescription(
        "Mark a page in Pikos as done.",
        categoryName: "Pages")

    /// Widget-only: Shortcuts already has the app target's intents, and a page id is not typed.
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
        try await WidgetList.setDone(done, pageId: pageId, workspaceAt: WorkspaceLocation.databaseURL().path)
        // WidgetKit reloads the tapped widget's timeline itself but not its neighbours', and the
        // same page can be on Now and on several List widgets, so every widget is reloaded.
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
