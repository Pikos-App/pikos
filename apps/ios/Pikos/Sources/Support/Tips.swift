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
        Text("Swipe a row")
    }

    var message: Text? {
        Text(
            "Swipe right to complete a page, left to schedule or delete it. Hold a row for everything else."
        )
    }

    var image: Image? {
        Image(systemName: "hand.draw")
    }
}

struct SwitchViewTip: Tip {
    var title: Text {
        Text("The title is a menu")
    }

    var message: Text? {
        Text("Tap “Today” at the top to switch to Upcoming, the Inbox or any folder.")
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
        if ProcessInfo.processInfo.environment["PIKOS_WORKSPACE_DIRECTORY"] != nil {
            Tips.hideAllTipsForTesting()
        }
        try? Tips.configure([
            .displayFrequency(.daily),
            .datastoreLocation(.applicationDefault),
        ])
    }
}
