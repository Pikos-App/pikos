import AppIntents
import SwiftUI
import WidgetKit

/// "New Page" in Control Center, on the lock screen, and on the Action button.
///
/// One control, and it does one thing: open the app on quick add. Reminders
/// ships the same control for the same reason — capture is the moment a phone
/// is most often reached for, and Control Center is one swipe from anywhere,
/// including the lock screen. The path in is the `pikos://quick-add` link the
/// widget and the desktop already use, so this is another entry point and not
/// a second code path.
///
/// iOS 18, where controls arrived. The bundle adds it under `#available`, so
/// an iOS 17 phone gets the five widgets and simply no control.
@available(iOS 18.0, *)
struct NewPageControl: ControlWidget {
    static let kind = "app.pikos.control.newpage"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenQuickAddIntent()) {
                Label("New Page", systemImage: "square.and.pencil")
            }
        }
        .displayName("New Page")
        .description("Start a page in Pikos.")
    }
}

/// Bring the app to the front on quick add.
///
/// Runs in this extension's process, writes nothing, and hands the app a link.
/// Not offered in Shortcuts on its own: the app target's "New page" intent
/// already is, and it creates the page without opening anything, which is
/// what a Shortcut wants.
@available(iOS 18.0, *)
struct OpenQuickAddIntent: AppIntent {
    static let title: LocalizedStringResource = "New page in Pikos"
    static let description = IntentDescription("Open Pikos ready to type a new page.")
    static let isDiscoverable = false
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        // A literal the app declares in project.yml; not something that
        // can fail to parse.
        let url = URL(string: "pikos://quick-add")!
        return .result(opensIntent: OpenURLIntent(url))
    }
}
