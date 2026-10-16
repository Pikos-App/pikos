import AppIntents
import SwiftUI
import WidgetKit

/// "New Page" in Control Center, on the lock screen, and on the Action button.
///
/// It opens the app on quick add, already holding the words chosen in the control's settings,
/// such as `#home` or `today`, so one control can be "a page for home" and another "a task for
/// today". The path in is the `pikos://quick-add` link the widgets and the desktop already use.
///
/// iOS 18, where controls arrived. The bundle adds it under `#available`.
@available(iOS 18.0, *)
struct NewPageControl: ControlWidget {
    static let kind = "app.pikos.control.newpage"

    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: Self.kind, intent: OpenQuickAddIntent.self) { configuration in
            ControlWidgetButton(action: configuration) {
                Label(configuration.label, systemImage: "square.and.pencil")
            }
        }
        .displayName("New Page")
        .description("Start a page in Pikos, optionally with words already typed, like #home or today.")
        .promptsForUserConfiguration()
    }
}

/// Bring the app to the front on quick add, holding the control's chosen words.
///
/// Not offered in Shortcuts on its own: the app target's "New page" intent already is, and it
/// creates the page without opening anything, which is what a Shortcut wants.
@available(iOS 18.0, *)
struct OpenQuickAddIntent: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "New page in Pikos"
    static let description = IntentDescription("Open Pikos ready to type a new page.")
    static let isDiscoverable = false
    static let openAppWhenRun = true

    @Parameter(title: "Start with", description: "Words already typed, like #home or today.")
    var prefill: String?

    init() {}

    var label: String {
        let words = prefill?.trimmingCharacters(in: .whitespaces) ?? ""
        return words.isEmpty ? String(localized: "New Page") : String(localized: "New \(words)")
    }

    func perform() async throws -> some IntentResult & OpensIntent {
        var components = URLComponents(string: "pikos://quick-add")!
        let words = prefill?.trimmingCharacters(in: .whitespaces) ?? ""
        if !words.isEmpty {
            components.queryItems = [URLQueryItem(name: "text", value: words + " ")]
        }
        return .result(opensIntent: OpenURLIntent(components.url!))
    }
}
