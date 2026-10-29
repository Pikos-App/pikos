import SwiftUI
import WidgetKit

/// Every widget the app offers, in the order the gallery lists them, then the focus session's
/// Live Activity and the Control Center buttons, which need iOS 18.
@main
struct PikosWidgetBundle: WidgetBundle {
    var body: some Widget {
        CalendarWidget()
        ListWidget()
        FocusLiveActivity()
        if #available(iOS 18.0, *) {
            NewPageControl()
            StartFocusControl()
        }
    }
}
