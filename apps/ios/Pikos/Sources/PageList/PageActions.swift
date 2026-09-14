import PikosCore
import SwiftUI

/// What a page action needs to know, whichever record the page arrived as.
///
/// A listed page is a `PageSummary`; an open one is a `Page`. Both carry the
/// same handful of facts the menu and its sheets turn on — which folder, which
/// priority, whether it repeats, whether a calendar owns it — and neither is a
/// type this repo declares, so a conformance to share them is a name the next
/// binding regeneration could collide with. One small value type built from
/// either is what lets the editor offer the list's menu without a second copy
/// of it.
struct PageFacts: Identifiable, Hashable {
    let id: String
    let title: String
    let folderId: String?
    let priority: Int64
    let tags: [String]
    let status: String
    let scheduledStart: String?
    let scheduledEnd: String?
    let isRecurring: Bool
    let scheduleLocked: Bool

    init(_ page: PageSummary) {
        id = page.id
        title = page.title
        folderId = page.folderId
        priority = page.priority
        tags = page.tags
        status = page.status
        scheduledStart = page.scheduledStart
        scheduledEnd = page.scheduledEnd
        isRecurring = page.isRecurring
        scheduleLocked = page.scheduleLocked
    }

    init(_ page: Page) {
        id = page.id
        title = page.title
        folderId = page.folderId
        priority = page.priority
        tags = page.tags
        status = page.status
        scheduledStart = page.scheduledStart
        scheduledEnd = page.scheduledEnd
        isRecurring = page.isRecurring
        scheduleLocked = page.scheduleLocked
    }

    /// From a calendar block. The dates are the block's own, which for a
    /// projected occurrence are that occurrence's rather than the head's —
    /// right for everything the menu shows, since the schedule sheet is
    /// withheld from a repeating page anyway.
    init(_ entry: CalendarEntry) {
        id = entry.pageId
        title = entry.title
        folderId = entry.folderId
        priority = entry.priority
        tags = entry.tags
        status = entry.status
        scheduledStart = entry.scheduledStart
        scheduledEnd = entry.scheduledEnd
        isRecurring = entry.isRecurring
        scheduleLocked = entry.scheduleLocked
    }

    var isDone: Bool { status == "done" }
}

/// What a page menu has asked the screen to show.
///
/// Held by the screen and handed to the menu as a binding, so the sheets are
/// declared once per screen — SwiftUI wants a `.sheet` on a view that stays
/// put, and a menu is not one.
struct PageActionState {
    enum Sheet: Identifiable {
        case schedule(PageFacts)
        case tags(PageFacts)
        case repeatRule(PageFacts)

        var id: String {
            switch self {
            case .schedule(let page): return "schedule-\(page.id)"
            case .tags(let page): return "tags-\(page.id)"
            case .repeatRule(let page): return "repeat-\(page.id)"
            }
        }
    }

    var sheet: Sheet?
    var renaming: PageFacts?
    var renameText = ""

    init() {}

    /// Bound to the presence of a page rather than a separate flag, so the two
    /// cannot disagree about whether the alert is up.
    var isRenaming: Bool {
        get { renaming != nil }
        set { if !newValue { renaming = nil } }
    }
}

/// The long press menu — desktop's right-click menu, minus what a phone cannot
/// do. Also the editor's page menu, which is the same list of verbs reached
/// from the other direction.
///
/// Everything above Delete is withheld from a page a calendar owns. The title,
/// dates and placement of a mirror belong upstream and the workspace refuses
/// all three, so an entry here would only ever produce an error alert. Tags
/// and priority stay: they are user-layer, and the lock covers what a meeting
/// is, not what somebody files it under. Delete stays too: a mirror can be
/// removed locally, and that path already knows to keep the tombstone.
struct PageActionsMenu: View {
    let page: PageFacts
    @Binding var state: PageActionState
    /// Runs after the page has been moved to the trash. The list needs nothing
    /// here — its refresh removes the row — but an editor showing the page
    /// has to leave.
    var afterDelete: () -> Void = {}

    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        if !page.scheduleLocked {
            Button {
                state.renameText = page.title
                state.renaming = page
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }

        // Same shape as Move to Folder, and for the same reason: one decision
        // from a short fixed list. "None" is a real choice here rather than the
        // absence of one — a page with a priority needs a way back to having
        // none.
        Menu {
            Button { setPriority(nil) } label: {
                checkedLabel("None", systemImage: "circle", current: page.priority == 0)
            }
            ForEach(PagePriority.allCases) { option in
                Button { setPriority(option.value) } label: {
                    checkedLabel(option.name, systemImage: "flag", current: page.priority == option.stored)
                }
            }
        } label: {
            Label("Priority", systemImage: "flag")
        }

        Button {
            state.sheet = .tags(page)
        } label: {
            Label("Tags…", systemImage: "tag")
        }

        if !page.scheduleLocked {
            // Offered on a repeating page too — it is the way to stop one.
            // What the user may change is the workspace's answer, not this
            // menu's guess; the sheet shows a rule it cannot edit read-only.
            Button {
                state.sheet = .repeatRule(page)
            } label: {
                Label("Repeat…", systemImage: "repeat")
            }

            // Nested rather than a sheet: a move is one decision from a short
            // list, and a sheet for it would be two taps and a dismissal for
            // something the menu is already showing.
            Menu {
                Button { move(to: nil) } label: {
                    checkedLabel("Inbox", systemImage: "tray", current: page.folderId == nil)
                }
                ForEach(store.fileableFolders, id: \.id) { folder in
                    Button { move(to: folder.id) } label: {
                        checkedLabel(
                            folder.name, systemImage: "folder", current: page.folderId == folder.id)
                    }
                }
            } label: {
                Label("Move to Folder", systemImage: "folder")
            }

            // Not offered on a repeating page. Its date belongs to its rule:
            // moving it has to realign the anchor and snap onto a day the rule
            // yields, or the next recompute reverts the edit, and clearing it
            // does nothing visible at all because the head owns its own
            // `scheduled_start`. The workspace refuses both — `pikos-ffi`'s
            // `a_repeating_page_refuses_a_plain_date_change` and
            // `clearing_a_repeating_page_s_date_leaves_the_head_where_it_is`
            // pin them — so the menu declines to offer what would fail.
            if !page.isRecurring {
                Button {
                    state.sheet = .schedule(page)
                } label: {
                    Label(
                        page.scheduledStart == nil ? "Schedule…" : "Change Date…",
                        systemImage: "calendar")
                }

                // Kept beside the sheet rather than folded into it. Taking a
                // date off is the one schedule change that is a single tap,
                // and making it three would be a worse trade than the extra
                // row.
                if page.scheduledStart != nil {
                    Button {
                        Task { await store.clearDate(pageId: page.id) }
                    } label: {
                        Label("Clear Date", systemImage: "calendar.badge.minus")
                    }
                }
            }
        }

        Divider()

        Button(role: .destructive) {
            Task {
                await store.trash(pageId: page.id)
                afterDelete()
            }
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    /// A tick beside the current choice.
    ///
    /// Desktop bolds that row; a menu on iOS shows state with a checkmark, and
    /// `Label` is what puts one in the leading position the system uses.
    private func checkedLabel(_ name: String, systemImage: String, current: Bool) -> some View {
        Label(name, systemImage: current ? "checkmark" : systemImage)
    }

    private func setPriority(_ priority: Priority?) {
        Task { await store.setPriority(pageId: page.id, priority: priority) }
    }

    private func move(to folderId: String?) {
        guard page.folderId != folderId else { return }
        Task { await store.movePage(id: page.id, toFolder: folderId) }
    }
}

/// The four priorities, paired with the numbers they are stored as and the
/// colour each one shows in.
///
/// Low number first — 1 urgent through 4 low — which runs the opposite way to
/// the names. The pairing is written out here rather than derived so the
/// menu's order, the column's meaning and the row's colour cannot drift apart.
/// The colours are the desktop's (`PRIORITY_COLORS` in `@pikos/core`): red,
/// orange, yellow, blue.
enum PagePriority: Int64, CaseIterable, Identifiable {
    case urgent = 1
    case high = 2
    case medium = 3
    case low = 4

    var id: Int64 { rawValue }
    var stored: Int64 { rawValue }

    var value: Priority {
        switch self {
        case .urgent: return .urgent
        case .high: return .high
        case .medium: return .medium
        case .low: return .low
        }
    }

    var name: String {
        switch self {
        case .urgent: return "Urgent"
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        }
    }

    var color: Color {
        switch self {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .blue
        }
    }

    /// The priority a stored number names, or nil for none and for anything
    /// out of range — a value this build does not know is shown as nothing
    /// rather than as the nearest colour.
    init?(stored: Int64) {
        self.init(rawValue: stored)
    }
}

extension View {
    /// Attach the sheets and the rename alert a `PageActionsMenu` can ask for.
    ///
    /// Applied once per screen that hosts the menu, on a view that stays put
    /// while the menu comes and goes.
    func pageActionSheets(_ state: Binding<PageActionState>) -> some View {
        modifier(PageActionSheets(state: state))
    }
}

private struct PageActionSheets: ViewModifier {
    @Binding var state: PageActionState
    @Environment(WorkspaceStore.self) private var store

    func body(content: Content) -> some View {
        content
            .sheet(item: $state.sheet) { sheet in
                switch sheet {
                case .schedule(let page): SchedulePageSheet(page: page)
                case .tags(let page): TagsSheet(page: page)
                case .repeatRule(let page): RepeatSheet(page: page)
                }
            }
            // An alert rather than an inline edit: a row that becomes editable
            // on tap competes with the tap that opens the page, and a phone has
            // no hover to disambiguate.
            .alert("Rename page", isPresented: $state.isRenaming) {
                TextField("Title", text: $state.renameText)
                Button("Cancel", role: .cancel) { state.renaming = nil }
                Button("Rename") { commitRename() }
            }
    }

    private func commitRename() {
        guard let page = state.renaming else { return }
        state.renaming = nil
        let title = state.renameText
        Task { await store.renamePage(id: page.id, to: title) }
    }
}
