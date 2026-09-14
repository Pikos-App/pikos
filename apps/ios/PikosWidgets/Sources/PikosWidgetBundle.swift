import SwiftUI
import WidgetKit

/// Every widget the app offers, in the order the gallery lists them.
///
/// Today first because it is the one most people will add, and the one that
/// also covers the lock screen. Each of the others answers one question
/// Today does not: what is next, what is waiting to be filed, what the week
/// holds, and how to start a page without opening the app.
///
/// After the widgets, the two surfaces that are not widgets: the focus
/// session's Live Activity, and the Control Center button, which needs iOS 18
/// and is left out below it.
@main
struct PikosWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        NextUpWidget()
        InboxWidget()
        UpcomingWidget()
        CaptureWidget()
        FocusLiveActivity()
        if #available(iOS 18.0, *) {
            NewPageControl()
        }
    }
}
