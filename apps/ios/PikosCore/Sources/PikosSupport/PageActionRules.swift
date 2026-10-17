/// Which of the page actions both apps' menus share a page offers, and why one is withheld.
///
/// The desktop asks `pageActions` in `@pikos/core` the same question. Both are tested against
/// `packages/core/src/pages/pageActions.cases.json`, so the two menus can't drift apart unnoticed.
public enum PageActionRules {
    public enum Action: String, CaseIterable, Sendable {
        case rename
        case moveToFolder = "move-to-folder"
        case clearDate = "clear-date"
        case delete
    }

    /// `"offered"`, or the reason it isn't, in the desktop's words.
    public static func answer(
        _ action: Action, isRecurring: Bool, scheduleLocked: Bool, hasDate: Bool, actsOn: Int = 1
    ) -> String {
        let owned = scheduleLocked ? "calendar-owned" : nil
        switch action {
        case .rename: return owned ?? (actsOn > 1 ? "several-pages" : "offered")
        case .moveToFolder: return owned ?? "offered"
        case .clearDate: return owned ?? (isRecurring ? "repeats" : hasDate ? "offered" : "no-date")
        case .delete: return "offered"
        }
    }

    public static func offers(
        _ action: Action, isRecurring: Bool, scheduleLocked: Bool, hasDate: Bool, actsOn: Int = 1
    ) -> Bool {
        answer(action, isRecurring: isRecurring, scheduleLocked: scheduleLocked, hasDate: hasDate, actsOn: actsOn)
            == "offered"
    }
}
