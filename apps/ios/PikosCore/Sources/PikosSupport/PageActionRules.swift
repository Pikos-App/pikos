import PikosCore

/// Which of the page actions both apps' menus share a page offers, and why one is withheld.
/// `page_actions` in pikos-core answers, graded against the desktop's table.
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
        let menuAction: MenuAction =
            switch action {
            case .rename: .rename
            case .moveToFolder: .moveToFolder
            case .clearDate: .clearDate
            case .delete: .delete
            }
        return pageActionAnswer(
            action: menuAction, isRecurring: isRecurring, scheduleLocked: scheduleLocked,
            hasDate: hasDate, actsOn: UInt32(max(0, actsOn)))
    }

    public static func offers(
        _ action: Action, isRecurring: Bool, scheduleLocked: Bool, hasDate: Bool, actsOn: Int = 1
    ) -> Bool {
        answer(action, isRecurring: isRecurring, scheduleLocked: scheduleLocked, hasDate: hasDate, actsOn: actsOn)
            == "offered"
    }
}
