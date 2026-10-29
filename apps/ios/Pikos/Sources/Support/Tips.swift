import SwiftUI
import TipKit

/// The two things a new reader cannot see and would not guess.
///
/// The app has no onboarding — nothing to sign up for means nothing to ask —
/// so what it teaches, it teaches in place. Two gestures carry most of the
/// list and neither has a visible affordance: the swipes on a row, and the
/// title being a menu. Each gets one tip, shown once, inline at the top of
/// the list, dismissable, and never again after that. TipKit shows one a day
/// at most, so the second waits for the reader's second day rather than
/// stacking under the first.
///
/// Neither tip has a rule beyond "has not been dismissed". A rule such as
/// "after three pages exist" reads well and means the reader who most needs
/// the hint — the one with two pages, wondering how to finish one — never
/// sees it.
struct SwipeRowTip: Tip {
    var title: Text {
        Text("Swipe, or hold and drag")
    }

    var message: Text? {
        Text(
            "Swipe a page left to send it to another day, file it in a folder or delete it. Hold a page for everything else, or drag it onto the day below to give it a time."
        )
    }

    var image: Image? {
        Image(systemName: "hand.draw")
    }
}

/// Waits for the swipe tip to be dismissed: both sit at the top of the list, and shown together the
/// popover covered the card.
struct SwitchViewTip: Tip {
    @Parameter static var isSwipeTipDone: Bool = false

    var rules: [Rule] {
        #Rule(Self.$isSwipeTipDone) { $0 == true }
    }

    var title: Text {
        Text("The title is a menu")
    }

    var message: Text? {
        Text("Tap “Today” to switch to Upcoming, the Inbox, a folder, or Settings.")
    }

    var image: Image? {
        Image(systemName: "chevron.down.circle")
    }
}

enum PikosTips {
    /// Set TipKit up once, at launch.
    ///
    /// Daily rather than immediate, so the two tips arrive one per day
    /// instead of both on the first screen. Hidden entirely under the UI
    /// tests, which read the screen by label and must not find a tip card
    /// sitting where a row was expected.
    static func configure() {
        let environment = ProcessInfo.processInfo.environment
        #if DEBUG
            if environment["PIKOS_DEMO_TIPS"] != nil {
                // Rules are ignored under testing, so one tip at a time is asked for by name.
                Tips.showTipsForTesting([SwipeRowTip.self])
                try? Tips.resetDatastore()
            } else if environment["PIKOS_WORKSPACE_DIRECTORY"] != nil || environment["PIKOS_DEMO"] != nil {
                Tips.hideAllTipsForTesting()
            }
        #else
            if environment["PIKOS_WORKSPACE_DIRECTORY"] != nil || environment["PIKOS_DEMO"] != nil {
                Tips.hideAllTipsForTesting()
            }
        #endif
        try? Tips.configure([
            .displayFrequency(.daily),
            .datastoreLocation(.applicationDefault),
        ])
    }
}
