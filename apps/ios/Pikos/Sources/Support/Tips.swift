import SwiftUI
import TipKit

/// The two things a new reader cannot see and would not guess: the swipes on a row, and the
/// title being a menu. Each is taught in place as one inline, dismissable tip. TipKit shows one
/// a day at most, so the second waits for the reader's second day.
///
/// Neither has a rule beyond "not dismissed": a rule such as "after three pages exist" hides the
/// hint from the reader with two pages, who needs it most.
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
    /// Set TipKit up once, at launch. Daily so the tips arrive one per day. Hidden under the UI
    /// tests, which read the screen by label and must not find a tip card where a row was expected.
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
