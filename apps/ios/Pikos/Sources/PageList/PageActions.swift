import PikosCore
import PikosSupport
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
        case folder(PageFacts)

        var id: String {
            switch self {
            case .schedule(let page): return "schedule-\(page.id)"
            case .tags(let page): return "tags-\(page.id)"
            case .repeatRule(let page): return "repeat-\(page.id)"
            case .folder(let page): return "folder-\(page.id)"
            }
        }
    }

    var sheet: Sheet?
    var renaming: PageFacts?
    var renameText = ""
    /// A repeating page whose Delete was chosen, asked "this date or all of them" first.
    var deletingSeries: SeriesDeletion?

    struct SeriesDeletion {
        let page: PageFacts
        let afterDelete: () -> Void
    }

    var isAskingAboutSeries: Bool {
        get { deletingSeries != nil }
        set { if !newValue { deletingSeries = nil } }
    }

    init() {}

    /// Bound to the presence of a page rather than a separate flag, so the two
    /// cannot disagree about whether the alert is up.
    var isRenaming: Bool {
        get { renaming != nil }
        set { if !newValue { renaming = nil } }
    }
}

/// The long press menu: the desktop's right-click menu, with the likeliest changes first.
///
/// Also the editor's page menu and a calendar block's, so a page offers the same verbs in the same
/// places wherever it is held. The top row finishes the page or sends it to today or tomorrow, so
/// the commonest edits are a hold and one tap; everything needing a choice from a list sits below.
///
/// What a calendar owns is withheld from its pages. The title, dates and placement of a mirror
/// belong upstream and the workspace refuses all three, so an entry here would only ever produce
/// an error alert. Tags and priority stay: they are user-layer, and the lock covers what a meeting
/// is, not what somebody files it under. Delete stays too: a mirror can be removed locally, and
/// that path already knows to keep the tombstone.
struct PageActionsMenu: View {
    let page: PageFacts
    @Binding var state: PageActionState
    /// Off in the editor, where the title is edited in place.
    var showsRename = true
    /// Runs after the page has been moved to the trash. The list needs nothing
    /// here — its refresh removes the row — but an editor showing the page
    /// has to leave.
    var afterDelete: () -> Void = {}

    @Environment(WorkspaceStore.self) private var store

    /// A repeating page's date belongs to its rule, so it is sent to a day only through the sheet.
    private var canSendToDay: Bool { !page.scheduleLocked && !page.isRecurring }

    private func offers(_ action: PageActionRules.Action) -> Bool {
        PageActionRules.offers(
            action, isRecurring: page.isRecurring, scheduleLocked: page.scheduleLocked,
            hasDate: page.scheduledStart != nil)
    }

    var body: some View {
        ControlGroup {
            Button {
                Task { await store.setStatus(pageId: page.id, done: !page.isDone) }
            } label: {
                Label(page.isDone ? "Reopen" : "Complete", systemImage: page.isDone ? "arrow.uturn.backward" : "checkmark.circle")
            }
            if canSendToDay {
                ForEach([WhenChoice.today, .tomorrow]) { choice in
                    Button {
                        Task { await store.send(page, to: choice) }
                    } label: {
                        Label(choice.label, systemImage: choice.systemImage)
                    }
                }
            }
        }

        // A submenu rather than `PriorityPalette`; see why on its declaration.
        Picker(
            selection: Binding(
                get: { PagePriority(stored: page.priority)?.stored ?? 0 },
                set: { stored in
                    Task { await store.setPriority(pageId: page.id, priority: PagePriority(stored: stored)?.value) }
                })
        ) {
            PriorityChoices()
        } label: {
            Label("Priority", systemImage: "flag")
        }
        .pickerStyle(.menu)

        if !page.scheduleLocked {
            Menu {
                if canSendToDay {
                    WhenMenuItems(
                        choices: [.thisWeekend, .nextWeek],
                        onChoose: { choice in Task { await store.send(page, to: choice) } },
                        onPickDate: { state.sheet = .schedule(page) },
                        onClear: offers(.clearDate)
                            ? { Task { await store.clearDate(pageId: page.id) } } : nil)
                } else {
                    WhenMenuItems(choices: [], onChoose: { _ in }, onPickDate: { state.sheet = .schedule(page) })
                }
            } label: {
                Label("When", systemImage: "calendar")
            }
        }

        if offers(.moveToFolder) {
            Picker(
                selection: Binding(get: { page.folderId }, set: { move(to: $0) })
            ) {
                FolderChoices(folders: store.fileableFolders)
            } label: {
                Label("Move to folder", systemImage: "folder")
            }
            .pickerStyle(.menu)
        }

        Button {
            state.sheet = .tags(page)
        } label: {
            Label("Tags…", systemImage: "tag")
        }

        if !page.scheduleLocked {
            // Offered on a repeating page too: it is the way to change one. What the user may
            // change is the workspace's answer, and the sheet shows a rule it cannot edit read-only.
            Button {
                state.sheet = .repeatRule(page)
            } label: {
                Label("Repeat…", systemImage: "repeat")
            }

            // Ending a series is one tap: the notice afterwards carries the way back.
            if page.isRecurring {
                Button {
                    Task { await store.stopRepeating(pageId: page.id, title: page.title) }
                } label: {
                    Label("Stop repeating", systemImage: "repeat.circle")
                }
            }
        }

        Divider()

        if showsRename && offers(.rename) {
            Button {
                state.renameText = page.title
                state.renaming = page
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }

        Button(role: .destructive) {
            // A series goes with every date it has left, so it asks first. A calendar's series
            // doesn't: its dates are upstream's, and there is no one date to skip here.
            if page.isRecurring && !page.scheduleLocked {
                state.deletingSeries = PageActionState.SeriesDeletion(page: page, afterDelete: afterDelete)
                return
            }
            Task {
                await store.trash(pageId: page.id, title: page.title)
                afterDelete()
            }
        } label: {
            Label("Delete", systemImage: "trash")
        }
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
/// The colours follow the desktop's `PRIORITY_COLORS`, through its tokens.
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
        case .urgent: return String(localized: "Urgent")
        case .high: return String(localized: "High")
        case .medium: return String(localized: "Medium")
        case .low: return String(localized: "Low")
        }
    }

    /// The desktop's marks. Shape tells the levels apart where colour alone does not: on the dark
    /// theme High's amber and Medium's yellow read as one.
    var mark: String {
        switch self {
        case .urgent: return "!!"
        case .high: return "!"
        case .medium: return "··"
        case .low: return "·"
        }
    }

    var color: Color {
        switch self {
        case .urgent: return .statusOverdue
        case .high: return .statusDueSoon
        case .medium: return Color(PikosToken.yellow500)
        case .low: return .statusOpen
        }
    }

    /// For the level read as words: High's bright amber is a mark's colour, not a label's.
    var textColor: Color {
        self == .high ? .textDueSoon : color
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

/// Where to file a page, chosen in one tap: the sheet closes on the choice and the notice offers
/// the old folder back.
private struct FolderPickerSheet: View {
    let page: PageFacts

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Picker("Folder", selection: choice) {
                    FolderChoices(folders: store.fileableFolders)
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            .navigationTitle("Move to folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var choice: Binding<String?> {
        Binding(
            get: { page.folderId },
            set: { folderId in
                dismiss()
                Task { await store.file(page, toFolder: folderId) }
            })
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
                case .folder(let page): FolderPickerSheet(page: page)
                }
            }
            // An alert rather than an inline edit: a row that becomes editable
            // on tap competes with the tap that opens the page, and a phone has
            // no hover to disambiguate.
            // Calendar's question: this date is a skip, which undoes, and all of them is the delete.
            .confirmationDialog(
                deletionTitle, isPresented: $state.isAskingAboutSeries, titleVisibility: .visible,
                presenting: state.deletingSeries
            ) { deletion in
                Button("Skip This Date") {
                    Task { await store.skipCurrentDate(of: deletion.page) }
                }
                Button("Delete All Dates", role: .destructive) {
                    Task {
                        await store.trash(pageId: deletion.page.id, title: deletion.page.title)
                        deletion.afterDelete()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("It repeats. Skip just this date, or delete it and every date it has left.")
            }
            .alert("Rename page", isPresented: $state.isRenaming) {
                TextField("Title", text: $state.renameText)
                Button("Cancel", role: .cancel) { state.renaming = nil }
                Button("Rename") { commitRename() }
            }
    }

    private var deletionTitle: String {
        let title = state.deletingSeries.map { $0.page.title.isEmpty ? String(localized: "Untitled") : $0.page.title }
        return String(localized: "Delete “\(title ?? "")”?")
    }

    private func commitRename() {
        guard let page = state.renaming else { return }
        state.renaming = nil
        let title = state.renameText
        Task { await store.renamePage(id: page.id, to: title) }
    }
}
