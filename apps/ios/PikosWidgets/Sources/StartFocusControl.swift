import AppIntents
import SwiftUI
import WidgetKit

/// "Start focus" in Control Center, on the lock screen and on the Action button.
///
/// Opens the page the Now widget would offer, with its timer running: the page in progress, or
/// the one `NowPlan` suggests for the gap. With nothing on today it opens Today.
///
/// The app opens because a running session lives in the editor and is written only when it ends;
/// starting one in this process would mean saving a session whose end nobody may ever see.
@available(iOS 18.0, *)
struct StartFocusControl: ControlWidget {
    static let kind = "app.pikos.control.focus"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartFocusIntent()) {
                Label("Start Focus", systemImage: "timer")
            }
        }
        .displayName("Start Focus")
        .description("Open what's on now, or the page Pikos suggests, with the focus timer running.")
    }
}

@available(iOS 18.0, *)
struct StartFocusIntent: AppIntent {
    static let title: LocalizedStringResource = "Start focus in Pikos"
    static let description = IntentDescription("Open the page on now, or the suggested one, and start timing it.")
    static let isDiscoverable = false
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        let pages = (try? await NowSource.pages()) ?? []
        let plan = NowSource.plan(pages, at: .now)
        let id = plan.current?.id ?? plan.suggestion?.id
        let url = pages.first { $0.id == id }.flatMap(NowLink.focus) ?? URL(string: "pikos://today")!
        return .result(opensIntent: OpenURLIntent(url))
    }
}
