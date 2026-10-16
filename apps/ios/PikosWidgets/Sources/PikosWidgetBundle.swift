import SwiftUI
import WidgetKit

/// Every widget the app offers, in the order the gallery lists them, then the focus session's
/// Live Activity and the Control Center button, which needs iOS 18.
@main
struct PikosWidgetBundle: WidgetBundle {
    var body: some Widget {
        ListWidget()
        NextUpWidget()
        FocusLiveActivity()
        if #available(iOS 18.0, *) {
            NewPageControl()
        }
    }
}
