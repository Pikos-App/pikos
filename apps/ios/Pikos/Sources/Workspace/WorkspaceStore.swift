import Foundation
import Observation
import PikosCore
import PikosSupport
import UIKit

/// The app's single connection to the workspace, and the state the UI observes.
///
/// One store, one `Workspace`, one writer: views read `pages` and call the methods here rather than
/// holding a `Workspace`, so a write and the list refresh after it each happen in one place.
///
/// `@MainActor` because everything it publishes drives SwiftUI; the FFI calls are `async` and work
/// off the main thread.
@MainActor
@Observable
public final class WorkspaceStore {
    /// What the app is currently showing. Hashable because SwiftUI's `tag(_:)` requires it.
    public enum Scope: Hashable {
        case today
        case upcoming
        case inbox
        case folder(id: String, name: String)

        /// Every view lists open work only; finished work has its own section, see
        /// `completedScope`.
        var query: PageQuery {
            switch self {
            case .today, .upcoming:
                // The date views have their own listings, which arrive already
                // sectioned; this query is unused for them.
                return PageQuery()
            case .inbox:
                return PageQuery(folder: .inbox, openOnly: true)
            case .folder(let id, _):
                return PageQuery(folder: .folder(id: id), openOnly: true)
            }
        }

        /// What this view's Completed section means: Today and Upcoming ask what finished today,
        /// across every folder, since they have no folder of their own; a folder asks what has ever
        /// been finished in it.
        var completedScope: CompletedScope {
            switch self {
            case .today, .upcoming: return .today
            case .inbox: return .inbox
            case .folder(let id, _): return .folder(id: id)
            }
        }

        /// Whether this view's order comes from the schedule rather than the user's arrangement, so
        /// a sort control has nothing to act on. These are also the two that arrive in sections.
        var isDateGrouped: Bool {
            switch self {
            case .today, .upcoming: return true
            case .inbox, .folder: return false
            }
        }

        /// The Inbox and a folder are read a window at a time; the date views are read whole.
        var listScope: ListScope? {
            switch self {
            case .today, .upcoming: return nil
            case .inbox: return .inbox
            case .folder(let id, _): return .folder(id: id)
            }
        }

        var title: String {
            switch self {
            case .today: return String(localized: "Today")
            case .upcoming: return String(localized: "Upcoming")
            case .inbox: return String(localized: "Inbox")
            case .folder(_, let name): return name
            }
        }
    }

    /// One run of rows under one heading. Every view produces these, even a folder (one untitled
    /// section), so a screen never branches on whether it draws a list or a set of lists.
    public struct Section: Identifiable, Hashable {
        /// Stable across refreshes, so SwiftUI keeps scroll position and row
        /// identity when the contents change under it.
        public let id: String
        /// `nil` for a view that is one undifferentiated list.
        public let title: String?
        public let pages: [PageSummary]
    }

    public private(set) var sections: [Section] = [] {
        didSet { placeReadMore() }
    }

    /// Rows the Inbox or a folder reads at a time: a screen shows about fifteen, and the rest is
    /// room for a flick before the next window is needed. A debug build takes `PIKOS_WINDOW_SIZE`,
    /// so a UI test can cross windows without seeding hundreds of pages.
    static let windowSize: Int = {
        #if DEBUG
            if let size = ProcessInfo.processInfo.environment["PIKOS_WINDOW_SIZE"].flatMap(Int.init), size > 0 {
                return size
            }
        #endif
        return 200
    }()

    /// The order the Inbox or a folder is read in, the reader's choice, set by the screen.
    public var listSort: PageSort.Mode = .manual {
        didSet {
            guard listSort != oldValue, scope.listScope != nil else { return }
            loadedRows = 0
            Task { await refresh() }
        }
    }

    /// Where the list's next window starts, or nil once it's all loaded.
    public private(set) var nextWindow: String? {
        didSet { placeReadMore() }
    }

    /// The row that, coming into view, reads the next window: far enough from the end of the
    /// section that grows that a flick doesn't reach it first. Worked out once per read rather
    /// than on every redraw.
    public private(set) var readMoreAt: String?

    private func placeReadMore() {
        guard nextWindow != nil, let pages = sections.first(where: { $0.id == windowedSection })?.pages else {
            readMoreAt = nil
            return
        }
        readMoreAt = pages.dropLast(50).last?.id ?? pages.last?.id
    }

    /// The section more windows are added to.
    private var windowedSection: String { scope == .today ? "overdue" : "all" }

    /// How many rows the list has loaded, so a refresh after a write re-reads those and no more.
    private var loadedRows = 0

    /// Every listed page, regardless of section. Derived so it cannot fall out of step with
    /// `sections`.
    public var pages: [PageSummary] { sections.flatMap(\.pages) }
    public private(set) var folders: [Folder] = []

    /// Set when something failed in a way the user should see; cleared on dismiss. Shown by the
    /// shell rather than any one screen, so a failed write on the calendar says so there.
    public var errorMessage: String?

    /// Something that just happened and the way back from it, for a few seconds. One mechanism for
    /// every "done, undo?" moment, so there is one countdown to keep in step. The shell draws and
    /// clears it; the store only says what happened.
    public struct Notice: Identifiable, Equatable {
        public let id = UUID()
        public let message: String
        public let action: Action?

        /// The one thing worth offering on a notice, usually "Undo".
        public struct Action {
            public let title: String
            public let perform: @MainActor () async -> Void
        }

        public init(_ message: String, action: Action? = nil) {
            self.message = message
            self.action = action
        }

        // By identity: a closure has no equality, and two notices with the
        // same words a minute apart are still two notices.
        public static func == (lhs: Notice, rhs: Notice) -> Bool { lhs.id == rhs.id }
    }

    public var notice: Notice?

    /// Something about opening the workspace that the reader has to be told once, and that a
    /// notice would let slip by.
    public var startupNote: String?

    /// Set when the workspace couldn't be opened at all, so the app shows that instead of a list
    /// whose every action would do nothing.
    public private(set) var openFailure: String?

    /// True until the first load completes, so "still loading" is distinct from "genuinely empty",
    /// which would read as data loss.
    public private(set) var isLoading = true

    /// Bumped whenever the workspace has been written to and re-read. The list observes `pages`,
    /// but the calendar's occurrences are not in it, so it observes this to avoid showing a stale
    /// range.
    public private(set) var dataVersion = 0

    /// Bumped by each save of the open page while it's typed in, its body or its header, which
    /// leaves `dataVersion` alone so the list isn't re-read on every keystroke. iCloud sync follows
    /// both, or typing would wait in the workspace until the editor closed.
    public private(set) var typedSaves = 0

    #if DEBUG
        /// How long the list last took to catch up with a change, for the speed tests.
        public private(set) var lastRefresh: Duration?
        /// Every read since the workspace opened, as of the list's last catch-up, for the count check.
        public private(set) var readCount: ReadCount?
    #endif

    public var scope: Scope = .today {
        didSet {
            guard scope != oldValue else { return }
            // The finished pages belong to the view that was showing; the new view's are a
            // different set. Dropped rather than re-fetched, so the section starts collapsed and
            // costs nothing until opened.
            isCompletedExpanded = false
            completedPages = []
            completedTotal = 0
            hasLoadedCompleted = false
            loadedRows = 0
            nextWindow = nil
            Task { await refresh() }
        }
    }

    /// What this view has loaded of its finished pages, newest first. Empty until the section is
    /// opened. A folder accumulates completed pages without limit, so this is the one paginated
    /// list.
    public private(set) var completedPages: [PageSummary] = []

    /// How many finished pages this view has in total, which is usually more
    /// than `completedPages.count`. The difference is what "Show more" is for.
    public private(set) var completedTotal: UInt32 = 0

    /// Whether the Completed section is open. Held here rather than by the list screen because it
    /// changes with what the section has loaded: while the screen owned it, a scope switch dropped
    /// the rows and kept the section open, so it read "Loading…" for good.
    public private(set) var isCompletedExpanded = false

    /// Whether this scope's first page of finished work has arrived. Distinct
    /// from `completedPages.isEmpty`, which is also true for a view that
    /// genuinely has nothing finished in it — a state that should say so.
    public private(set) var hasLoadedCompleted = false

    private var workspace: Workspace?

    /// The open workspace, for the one caller that needs the handle. `CalendarSyncStore` keeps its
    /// own state, because folding its failures (a server down, a rotated password) into
    /// `errorMessage` would show "could not read or write" over all of them. Read-only: every write
    /// still goes through a method here or on that store.
    public var handle: Workspace? { workspace }

    public init() {}

    /// Open the workspace and load the first screen's worth of data. Separate from `init` because
    /// it can fail and is async. Goes through `ensureStarted`, so a create made while the shell is
    /// still opening waits for the same open.
    public func start() async {
        await ensureStarted()
    }

    private func open() async {
        #if DEBUG
            // A slow open on demand, so a test can act in the moment before the workspace opens.
            if let delay = ProcessInfo.processInfo.environment["PIKOS_OPEN_DELAY_MS"].flatMap(Int.init) {
                try? await Task.sleep(for: .milliseconds(delay))
            }
        #endif
        do {
            let url = try WorkspaceLocation.databaseURL()
            // Decided before the open, which creates the file. First launch is a property of the
            // disk, not of a preference, which would survive "Delete all data" and be forgotten by
            // a reinstall.
            var isNewWorkspace = !FileManager.default.fileExists(atPath: url.path)
            do {
                workspace = try await Workspace.open(path: url.path)
            } catch WorkspaceError.MadeByAnotherBuild {
                _ = try WorkspaceLocation.setAside()
                isNewWorkspace = true
                workspace = try await Workspace.open(path: url.path)
                startupNote = String(
                    localized: "This phone's workspace was made by a test build of Pikos that this one can't read, so Pikos started a new one. The old one is in Files, under Pikos › Set aside.")
            }
            // After the open, so SQLite's sidecar files get the class too. The app is the only
            // writer, so this is the one place it can be applied without racing.
            try? WorkspaceLocation.applyProtectionClass()
            if isNewWorkspace {
                #if DEBUG
                    if let count = DemoWorkspace.perfPageCount {
                        await DemoWorkspace.seedForSpeed(self, count: count)
                    } else if DemoWorkspace.isRequested {
                        await DemoWorkspace.seed(self)
                    } else {
                        await seedStartHere()
                    }
                #else
                    await seedStartHere()
                #endif
            }
            await refresh()
        } catch {
            isLoading = false
            openFailure = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case WorkspaceError.TooNew:
            return String(localized: "This workspace was saved by a newer version of Pikos. Update Pikos to open it.")
        case WorkspaceError.Open(let message), WorkspaceError.Database(let message):
            return message
        default:
            return error.localizedDescription
        }
    }

    /// What a brand-new workspace starts with: the desktop's "Start here" folder and its three
    /// pages, in the phone's own words.
    ///
    /// There is no onboarding; a first launch gets a folder of ordinary pages in the product's own
    /// voice (where the data lives, how capture works, what to swipe). A folder rather than one
    /// Inbox page, as the desktop has it, so the whole lesson goes in one delete.
    ///
    /// Undated, unlike the desktop's welcome page: Today's empty state is where capture is taught,
    /// and it stays empty so its "Try …" example still lands.
    ///
    /// Seeded only when the database did not exist before this open, so a restored or synced
    /// workspace is never given pages its owner did not write.
    private func seedStartHere() async {
        guard let workspace,
            let folder = try? await workspace.createFolder(
                name: String(localized: "Start here"), color: Self.startHereColor)
        else { return }
        for page in Self.startHerePages {
            let new = NewPage(
                title: page.title, subtitle: page.subtitle, folderId: folder.id,
                content: plainTextToDocument(text: page.text), tags: ["tutorial"])
            _ = try? await workspace.createPage(page: new)
        }
        try? await workspace.recordFirstRunSeed()
    }

    /// The desktop tutorial's folder colour, so the folder looks the same on both.
    private static let startHereColor = "#6366f1"

    /// Plain paragraphs, turned into documents by the shared Rust so they use the same schema.
    private static var startHerePages: [(title: String, subtitle: String, text: String)] {
        [
            (
                String(localized: "Welcome to Pikos"),
                String(localized: "Notes, tasks and a calendar in one app, stored on your device."),
                String(
                    localized: """
                        Every page is something you can write in, schedule, and tick off when it's done. Everything stays on this device. There is no account, and nothing is sent anywhere.

                        A few things to try:

                        Tap + at the bottom and type a sentence, such as "call the dentist tomorrow at 3pm".

                        Tap the calendar button at the bottom to see your day, and back to return to the list.

                        Tap the search button to find any page by what is in it, not just its title.

                        Tick the box beside a page to mark it done.

                        When you're done, tap the title at the top of the list, tap Edit beside Folders, and delete Start here. These pages go with it, and wait in the Trash in case you want one back.
                        """)
            ),
            (
                String(localized: "How it works"),
                String(localized: "Type what you want, put it on a day, tick it off."),
                String(
                    localized: """
                        Most of Pikos is three steps: add, schedule, complete.

                        Add. Tap + and type what you want to do. Pikos reads the date, time, priority and tags out of the sentence:

                        go for a run tomorrow 7am for 30m
                        call the dentist monday 9am !high
                        book club thursday 7pm #friends

                        Schedule. Swipe a page left to send it to Today or Tomorrow, or choose When for any other day. On the calendar, hold an empty slot until a block appears, then drag to set how long it runs.

                        Complete. Tick its box in the list, on the page, or on the calendar.

                        Repeats. Type something like "team meeting every monday at 9am", or hold a page and choose Repeat. To skip one, hold it on the calendar and choose Skip this one.

                        Reminders. Pikos reminds you 10 minutes before a scheduled page starts. Change it for one page from the bell at the top of the page, or for every page in Settings › Reminders.
                        """)
            ),
            (
                String(localized: "Gestures & tips"),
                String(localized: "A reference for when you want one. You don't need these to use the app."),
                String(
                    localized: """
                        Everything here is also in a menu, so none of it has to be learned. These are the ones worth knowing.

                        In a list. Swipe left to send a page to another day, file it in a folder or delete it. Hold a page for everything else. Tap the title at the top to switch between Today, Upcoming, your Inbox and your folders.

                        Several at once. Tap Select at the top, and act on everything you tick.

                        On the calendar. Tap the title to jump to another date or show more days. Hold a block to move it, complete it or skip it, or hold the bar at its top or bottom edge and drag to change how long it runs.

                        Search. Tap a chip under Narrow to, or type a folder or tag name, to search inside it.

                        Settings › Your data shows how big your workspace is and puts a copy of it in the Files app whenever you like.
                        """)
            ),
        ]
    }

    /// Open the workspace if nothing has yet, for entry points that can run before the first
    /// screen's `.task` (a background refresh, a notification action). A second call while the
    /// first is opening waits for it.
    public func ensureStarted() async {
        if workspace != nil { return }
        if let opening {
            await opening.value
            return
        }
        let task = Task { await open() }
        opening = task
        await task.value
        opening = nil
    }

    private var opening: Task<Void, Never>?

    public func refresh() async {
        guard let workspace else { return }
        #if DEBUG
            let started = ContinuousClock.now
            defer {
                lastRefresh = started.duration(to: .now)
                readCount = workspace.readCount()
            }
        #endif
        // A re-read takes ticked rows out itself, so a held settle has nothing left to do.
        pendingHold?.cancel()
        pendingTicks.removeAll()
        refreshes += 1
        let generation = refreshes
        do {
            // Sequential: two local SQLite queries in single-digit milliseconds gain nothing from
            // overlap.
            sections = try await load(scope, generation: generation)
            try await refreshAroundTheList(workspace)
        } catch is StaleRead {
            // The view or its order changed while this read was out; the change's own read follows.
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    /// A read that finished after its view or sort was left, or after a newer refresh started,
    /// and so isn't put on screen.
    private struct StaleRead: Error {}

    /// Refreshes started; a read is current only while its own number is the latest.
    private var refreshes = 0

    /// Everything a refresh reads besides the list's own rows.
    private func refreshAroundTheList(_ workspace: Workspace) async throws {
        folders = try await workspace.listFolders().map { folder in
            var folder = folder
            folder.color = CurrentPaletteColor.of(folder.color)
            return folder
        }
        // An opened section re-reads its rows; a closed one only its count, which the screen needs
        // to tell "nothing here yet" from a view whose pages are all finished.
        if hasLoadedCompleted {
            await reloadCompleted()
        } else {
            await countCompleted()
        }
        isLoading = false
        dataVersion += 1
    }

    /// Takes the ticked rows out of the list instead of reading every loaded window again. A tick
    /// on a plain page removes only its own row, and the rows after it keep their order, so the
    /// list is what a re-read would return. Rows go by the ticks' ids rather than by a done status,
    /// which a read that started before a tick may have put back. A window emptied with more rows
    /// after it is read again, since nothing on screen would bring the next one in.
    private func settleTicks() async {
        guard let workspace else { return }
        let ticked = pendingTicks
        pendingTicks.removeAll()
        let removesRowsOnly = scope != .upcoming
        guard removesRowsOnly else {
            await refresh()
            return
        }

        #if DEBUG
            let started = ContinuousClock.now
            defer {
                lastRefresh = started.duration(to: .now)
                readCount = workspace.readCount()
            }
        #endif
        let windowedId = scope == .today ? "overdue" : "all"
        var removedFromWindow = 0
        var settled = sections.map { section in
            let open = section.pages.filter { !ticked.contains($0.id) }
            if section.id == windowedId { removedFromWindow += section.pages.count - open.count }
            return Section(id: section.id, title: section.title, pages: open)
        }
        if scope == .today {
            settled = settled.filter { !$0.pages.isEmpty }
            let onlyToday = settled.allSatisfy { $0.id == "today" }
            if onlyToday { settled = [Section(id: "today", title: nil, pages: settled.first?.pages ?? [])] }
        }
        let windowEmptied = !settled.contains { $0.id == windowedId && !$0.pages.isEmpty }
        if windowEmptied && nextWindow != nil {
            await refresh()
            return
        }
        sections = settled
        loadedRows -= removedFromWindow

        do {
            try await refreshAroundTheList(workspace)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The rows for one view, already grouped the way it is drawn. The date views come back
    /// sectioned from the workspace: both grouping rules are subtle (an all-day item stays "today"
    /// until midnight, a timed one slips when it passes, and an all-day item dated today sorts at
    /// *now*), and a Swift copy would drift from the one the desktop is graded against.
    private func load(_ scope: Scope, generation: Int) async throws -> [Section] {
        guard let workspace else { return [] }
        switch scope {
        case .today:
            // What slipped from earlier days is read a window at a time, since it grows without
            // limit; today's own pages come whole with the first window.
            let window = try await workspace.listTodayWindow(
                after: nil, limit: UInt32(max(Self.windowSize, loadedRows)))
            guard self.scope == scope, refreshes == generation else { throw StaleRead() }
            nextWindow = window.earlier.next
            loadedRows = window.earlier.pages.count
            let todayPages = window.slippedToday + window.today
            // A heading only when there is something under it, and none at all
            // when nothing has slipped: a lone "Today" over the only list on screen labels nothing.
            guard !window.earlier.pages.isEmpty else {
                return [Section(id: "today", title: nil, pages: todayPages)]
            }
            return [
                Section(id: "overdue", title: String(localized: "Overdue"), pages: window.earlier.pages),
                Section(id: "today", title: String(localized: "Today"), pages: todayPages),
            ].filter { !$0.pages.isEmpty }

        case .upcoming:
            let today = DayLabel.today()
            let days = try await workspace.listUpcoming()
            guard self.scope == scope, refreshes == generation else { throw StaleRead() }
            return days.map { day in
                Section(
                    id: day.date,
                    title: DayLabel.relative(day.date, today: today),
                    pages: day.pages)
            }

        case .inbox, .folder:
            guard let listScope = scope.listScope else { return [] }
            let sort = listSort
            let window = try await workspace.listWindow(
                scope: listScope, sort: sort.listSort, after: nil,
                limit: UInt32(max(Self.windowSize, loadedRows)))
            guard self.scope == scope, listSort == sort, refreshes == generation else {
                throw StaleRead()
            }
            nextWindow = window.next
            loadedRows = window.pages.count
            return [Section(id: "all", title: nil, pages: window.pages)]
        }
    }

    /// The list's next window, read when the reader scrolls near the end of what's loaded.
    public func loadMoreRows() async {
        await readOn(windows: 1, limit: Self.windowSize)
    }

    /// Read the rest of the list in one go, for Select All: every bulk verb keeps each page's
    /// date and folder for its Undo, so it needs the rows, not just their ids. Waits out a read
    /// already going, and returns whether every row is now loaded: a selection of part of a list
    /// would leave the rest out of whatever the person does next.
    public func loadAllRows() async -> Bool {
        while isLoadingMoreRows {
            try? await Task.sleep(for: .milliseconds(20))
        }
        await readOn(windows: .max, limit: 5_000)
        return nextWindow == nil
    }

    /// Read up to `windows` more windows after the last, and add them to the list at once.
    private func readOn(windows: Int, limit: Int) async {
        guard let workspace, let start = nextWindow, !isLoadingMoreRows else { return }
        isLoadingMoreRows = true
        defer { isLoadingMoreRows = false }
        let windowed = windowedSection
        var after: String? = start
        var more: [PageSummary] = []
        for _ in 0..<windows {
            guard let cursor = after else { break }
            let window: PageWindow?
            switch scope {
            case .today:
                window = try? await workspace.listTodayWindow(after: cursor, limit: UInt32(limit)).earlier
            case .inbox, .folder:
                guard let listScope = scope.listScope else { return }
                window = try? await workspace.listWindow(
                    scope: listScope, sort: listSort.listSort, after: cursor, limit: UInt32(limit))
            case .upcoming:
                window = nil
            }
            guard let window else { return }
            more += window.pages
            after = window.next
        }
        // A refresh or another view landed while this read was out; its windows are the current ones.
        guard nextWindow == start else { return }
        sections = sections.map { section in
            section.id == windowed
                ? Section(id: section.id, title: section.title, pages: section.pages + more) : section
        }
        nextWindow = after
        loadedRows = sections.first { $0.id == windowed }?.pages.count ?? loadedRows
    }

    private var isLoadingMoreRows = false

    /// Move a page to sit between two others in the list's manual order, as a drag left it.
    /// Only those two are named, so a list that hasn't loaded every row can still be arranged.
    public func movePage(_ id: String, after: String?, before: String?) async {
        guard let workspace else { return }
        var before = before
        // Dropped below the last row read, with more after it: the neighbour is the next unread row.
        if before == nil, let next = nextWindow, let listScope = scope.listScope {
            before = try? await workspace.listWindow(
                scope: listScope, sort: listSort.listSort, after: next, limit: 1
            ).pages.first?.id
        }
        // Moved here first, so the row stays where the finger left it while the write goes.
        if var pages = sections.first?.pages, let from = pages.firstIndex(where: { $0.id == id }) {
            let page = pages.remove(at: from)
            let to = after.flatMap { neighbour in pages.firstIndex { $0.id == neighbour } }.map { $0 + 1 } ?? 0
            pages.insert(page, at: to)
            sections = [Section(id: "all", title: nil, pages: pages)]
        }
        do {
            try await workspace.movePages(ids: [id], after: after, before: before)
        } catch WorkspaceError.Refused {
            // The list moved under the drag; the refresh below shows where things are now.
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    // MARK: - Completed pages

    /// How many finished pages one fetch brings back.
    private static let completedPageSize: UInt32 = 20

    /// Open or close the section, loading the first page the first time it opens.
    /// Open or close the section, loading the first page the first time. Reopening shows what is
    /// there rather than re-querying.
    public func toggleCompleted() {
        isCompletedExpanded.toggle()
        guard isCompletedExpanded, !hasLoadedCompleted else { return }
        let asked = scope
        Task {
            await fetchCompleted(offset: 0, replacing: true)
            if scope == asked { hasLoadedCompleted = true }
        }
    }

    /// Load the next page. The caller checks `hasMoreCompleted` first.
    public func loadMoreCompleted() async {
        guard hasMoreCompleted, !isLoadingMoreCompleted else { return }
        isLoadingMoreCompleted = true
        defer { isLoadingMoreCompleted = false }
        await fetchCompleted(offset: UInt32(completedPages.count), replacing: false)
    }

    private var isLoadingMoreCompleted = false

    public var hasMoreCompleted: Bool {
        completedPages.count < Int(completedTotal)
    }

    /// Re-read everything already on screen in one query. A write can add a row to the top (a page
    /// just ticked) or take one out, shifting every row after it, so re-fetching from offset 0 with
    /// the count shown is the only consistent way; per-page offsets would show one row twice and
    /// skip another.
    private func reloadCompleted() async {
        let shown = max(UInt32(completedPages.count), Self.completedPageSize)
        await fetchCompleted(offset: 0, replacing: true, limit: shown)
    }

    /// How many finished pages this view has, without reading any: a limit of zero still runs the
    /// `COUNT(*)` and returns no rows.
    private func countCompleted() async {
        await fetchCompleted(offset: 0, replacing: false, limit: 0)
    }

    private func fetchCompleted(
        offset: UInt32, replacing: Bool, limit: UInt32? = nil
    ) async {
        guard let workspace else { return }
        let asked = scope
        do {
            let result = try await workspace.listCompleted(
                scope: asked.completedScope,
                limit: limit ?? Self.completedPageSize,
                offset: offset)
            // A view switch while the read was out: these rows are the old view's.
            guard scope == asked else { return }
            completedTotal = result.total
            if replacing {
                completedPages = result.pages
            } else {
                completedPages.append(contentsOf: result.pages)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Reads

    public func page(id: String) async -> Page? {
        // A link can open the editor at launch, before the workspace has.
        await ensureStarted()
        guard let workspace else { return nil }
        do {
            return try await workspace.getPage(id: id)
        } catch let error as WorkspaceError {
            // A deleted page is routine (a stale deep link, a widget tap, a restored stack), not
            // worth an alert. `NotFound`, capitalised: UniFFI spells an error case as the Rust
            // variant, not in lowerCamelCase.
            if case .NotFound = error { return nil }
            errorMessage = error.localizedDescription
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Everything the calendar draws for a visible range, inclusive of both ends, in `YYYY-MM-DD`.
    /// Not cached nor folded into `pages`: it needs recurring occurrences projected onto the days
    /// on screen, and the range changes as the user swipes, so a cache would be a staleness bug.
    public func calendarRange(from start: String, to end: String) async -> [CalendarEntry] {
        guard let workspace else { return [] }
        do {
            return try await workspace.calendarRange(start: start, end: end)
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// Every tag on an open page, most used first, for the search screen's suggestions. One query
    /// over open pages, since finished ones add tags nobody filters by. Errors are swallowed: an
    /// empty suggestion list is no fault worth an alert.
    public func allTags() async -> [String] {
        guard let workspace else { return [] }
        guard let pages = try? await workspace.listPages(query: PageQuery(openOnly: true)) else {
            return []
        }
        var counts: [String: Int] = [:]
        for page in pages {
            for tag in page.tags { counts[tag, default: 0] += 1 }
        }
        return counts.sorted { lhs, rhs in
            lhs.value != rhs.value ? lhs.value > rhs.value : lhs.key < rhs.key
        }.map(\.key)
    }

    public func search(_ query: String, includeCompleted: Bool, limit: UInt32 = 50) async
        -> SearchResults?
    {
        guard let workspace, !query.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        do {
            return try await workspace.search(
                query: query, includeCompleted: includeCompleted, limit: limit)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// The pages opened most recently, for search to offer before anything is typed.
    /// An empty list on failure: search without suggestions still works.
    public func recentPages(limit: UInt32 = 10) async -> [PageSummary] {
        guard let workspace else { return [] }
        return (try? await workspace.recentPages(limit: limit)) ?? []
    }

    /// Recency is a convenience, so a failed write is not worth interrupting the reader for.
    public func markOpened(pageId: String) async {
        guard let workspace else { return }
        try? await workspace.markPageOpened(id: pageId)
    }

    // MARK: - Writes

    /// Save an edited document typed over `base`, the stored body the editor showed, and return
    /// the body stored after: the one typed, or its merge with a newer one saved elsewhere.
    ///
    /// Deliberately does not refresh the list: this runs on every debounced keystroke, and
    /// reloading under the user would be wasteful and janky. The list refreshes when the editor
    /// closes.
    public func saveDocument(pageId: String, json: String, base: String) async -> String? {
        guard let workspace else { return nil }
        var stored: String?
        await untilWritten {
            do {
                stored = try await workspace.updatePage(
                    id: pageId, edit: PageEdit(content: json, baseContent: base)
                ).content
                typedSaves += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        return stored
    }

    /// Save the title or subtitle as it's typed. Like `saveDocument` it leaves the list alone; the
    /// field's commit when it lets go refreshes it.
    public func saveTypedHeader(pageId: String, edit: PageEdit) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.updatePage(id: pageId, edit: edit)
            typedSaves += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Asks iOS for time to finish the write if the app is put away while it runs. The editor and
    /// the header save as the app leaves, which is when iOS suspends it within a second or two.
    private func untilWritten(_ write: () async -> Void) async {
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save")
        await write()
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }

    @discardableResult
    public func createPage(_ page: NewPage) async -> Page? {
        await ensureStarted()
        guard let workspace else { return nil }
        do {
            let created = try await workspace.createPage(page: page)
            await refresh()
            noticeIfOutOfView([created])
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Add a reminder to a page, as minutes before its start. No refresh: a reminder changes
    /// nothing a list shows. Used by the path that builds a page by hand from a parsed line; quick
    /// add proper writes its reminders in the workspace.
    public func addReminder(pageId: String, minutesBefore: Int64) async {
        guard let workspace else { return }
        do {
            try await workspace.addPageReminder(pageId: pageId, minutesBefore: minutesBefore)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put the folders in `orderedIds` order, applied before the write as `movePage` is.
    public func reorderFolders(_ orderedIds: [String]) async {
        let position = Dictionary(
            orderedIds.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        folders.sort { (position[$0.id] ?? Int.max) < (position[$1.id] ?? Int.max) }
        guard let workspace else { return }
        do {
            try await workspace.reorderFolders(orderedIds: orderedIds)
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    public func reminders(pageId: String) async -> PageReminders {
        guard let workspace,
            let rows = try? await workspace.listPageReminders(pageId: pageId)
        else { return PageReminders([]) }
        return PageReminders(rows.map(\.minutesBefore))
    }

    /// Put a lead on a page or take it off, as the desktop's reminder menu does.
    public func toggleReminder(pageId: String, minutes: Int64) async -> PageReminders {
        await writeReminders(pageId: pageId) { workspace, rows in
            switch PageReminders(rows.map(\.minutesBefore)).toggling(minutes) {
            case .remove(let lead):
                for row in rows where row.minutesBefore == lead {
                    try await workspace.deletePageReminder(id: row.id)
                }
            case .add(let lead, let clearingNever):
                if clearingNever { try await workspace.clearPageReminders(pageId: pageId) }
                try await workspace.addPageReminder(pageId: pageId, minutesBefore: lead)
            }
        }
    }

    public func setNeverRemind(pageId: String) async -> PageReminders {
        await writeReminders(pageId: pageId) { workspace, _ in
            try await workspace.clearPageReminders(pageId: pageId)
            try await workspace.addPageReminder(pageId: pageId, minutesBefore: PageReminders.never)
        }
    }

    /// Back to the default lead, or to no reminder on an all-day page.
    public func clearReminders(pageId: String) async -> PageReminders {
        await writeReminders(pageId: pageId) { workspace, _ in
            try await workspace.clearPageReminders(pageId: pageId)
        }
    }

    /// Bumps the data version rather than refreshing: no list shows a reminder, but the
    /// notification plan follows the version.
    private func writeReminders(
        pageId: String, _ write: (Workspace, [PageReminder]) async throws -> Void
    ) async -> PageReminders {
        guard let workspace else { return PageReminders([]) }
        do {
            try await write(workspace, try await workspace.listPageReminders(pageId: pageId))
            dataVersion += 1
        } catch {
            errorMessage = error.localizedDescription
        }
        return await reminders(pageId: pageId)
    }

    /// Folders the user can file into, excluding any a calendar owns: the workspace refuses a page
    /// filed into one.
    public var fileableFolders: [Folder] {
        folders.filter { !$0.isExternalCalendar }
    }

    @discardableResult
    public func createFolder(named name: String) async -> Folder? {
        guard let workspace else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        do {
            let folder = try await workspace.createFolder(name: trimmed, color: nil)
            await refresh()
            return folder
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    public func renameFolder(id: String, to name: String) async {
        guard let workspace else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            _ = try await workspace.renameFolder(id: id, name: trimmed)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Delete everything on this device. No trash, no undo, and nothing here asks: the screen
    /// offering this has asked twice. The workspace stays open afterwards, so this refreshes
    /// instead of tearing anything down.
    public func deleteAllData() async {
        guard let workspace else { return }
        do {
            try await workspace.deleteAllData()
            // Back to the view that always has something to show, since the one
            // that was open may have been a folder that no longer exists.
            scope = .today
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Focus timer

    /// Record a finished focus session, and return the sentence to show. `nil` only when the write
    /// failed, which is not worth interrupting somebody mid-page for. Both real outcomes carry the
    /// workspace's wording, so phone and desktop say the same thing.
    @discardableResult
    public func recordFocusSession(pageId: String, from began: Date, to ended: Date) async
        -> String?
    {
        guard let workspace else { return nil }
        do {
            let outcome = try await workspace.recordFocusSession(
                pageId: pageId,
                startedAt: WallClockDay.instant(from: began),
                endedAt: WallClockDay.instant(from: ended))
            switch outcome {
            case .recorded(_, let label): return label
            case .tooShort(let label): return label
            }
        } catch {
            // Deliberately not `errorMessage`: that surfaces as an alert over the page list, and an
            // unsaved focus session is not worth one.
            return nil
        }
    }

    /// `M:SS`, or `H:MM:SS` past an hour. Served by the workspace so both apps
    /// count the same way.
    public func focusElapsedLabel(seconds: Int) -> String {
        workspace?.focusElapsedLabel(seconds: Int64(seconds)) ?? ""
    }

    /// The colours a folder can be, served by the workspace. Read once and held, so this app is not
    /// a fourth place the palette is written down.
    public var paletteColors: [PaletteColor] {
        (workspace?.paletteColors() ?? []).map { color in
            var color = color
            color.value = CurrentPaletteColor.of(color.value) ?? color.value
            return color
        }
    }

    /// Set a folder's colour, or clear it with `nil`. Offered on a calendar's folder too: its
    /// colour is not the calendar's, and the write latches the choice so the next sync stops
    /// pulling the provider's colour back.
    public func setFolderColor(id: String, to color: String?) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.setFolderColor(id: id, color: color)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Move a folder to the trash, taking its pages with it. If it was the one shown, the scope
    /// falls back to Today rather than an empty list under a name that no longer exists.
    public func trashFolder(id: String) async {
        guard let workspace else { return }
        do {
            try await workspace.trashFolder(id: id)
            if case .folder(let shown, _) = scope, shown == id {
                scope = .today
            }
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Rename a page without opening it. Renaming must not load and re-save the body: that would
    /// restamp `content_schema_version` for a change that touched no content, and on a page written
    /// by a newer build be the overwrite the stamp exists to prevent.
    public func renamePage(id: String, to title: String) async {
        guard let workspace else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await untilWritten {
            do {
                _ = try await workspace.updatePage(id: id, edit: PageEdit(title: trimmed))
                await refresh()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// File a page into a folder, or `nil` for the Inbox. One call rather than a move and an
    /// unfile, because `nil` means the Inbox, not "leave it alone": `PageEdit.folder` draws that
    /// with an enum so a caller cannot lose it to an optional.
    @discardableResult
    public func movePage(id: String, toFolder folderId: String?) async -> Bool {
        guard let workspace else { return false }
        do {
            let assignment: FolderAssignment =
                folderId.map { .folder(id: $0) } ?? .inbox
            _ = try await workspace.updatePage(id: id, edit: PageEdit(folder: assignment))
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// A page carried onto a folder: filed there, with the folder it came from offered back.
    func file(_ page: PageFacts, toFolder folderId: String?) async {
        guard !page.scheduleLocked, page.folderId != folderId,
            await movePage(id: page.id, toFolder: folderId)
        else { return }
        let destination =
            folderId.flatMap { id in folders.first { $0.id == id }?.name } ?? String(localized: "Inbox")
        let origin = page.folderId
        notice = Notice(
            String(localized: "Moved to \(destination)"),
            action: Notice.Action(title: String(localized: "Undo")) { [weak self] in
                await self?.movePage(id: page.id, toFolder: origin)
            })
    }

    /// Move a page to a date, or give one to a page that had none. Replaces the one-off date rather
    /// than adding a second: a page can hold several and shows the earliest ahead, so adding when
    /// the user meant moving lets the old date resurface.
    ///
    /// Both strings are local wall clocks, `yyyy-MM-dd` for all-day and `yyyy-MM-ddTHH:mm:ss` for
    /// timed; the workspace refuses a mismatched pair.
    public func setSchedule(pageId: String, start: String, end: String?) async {
        guard let workspace else { return }
        do {
            let page = try await workspace.setPageSchedule(
                pageId: pageId, scheduledStart: start, scheduledEnd: end)
            await refresh()
            // A repeating page lands on the nearest day its rule yields, which may not be the day picked.
            if page.isRecurring, let landed = page.scheduledStart, landed.prefix(10) != start.prefix(10),
                let day = StorageTimestamp.wallClock(landed)
            {
                notice = Notice(
                    String(localized: "Moved to \(day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())), the nearest day it repeats on"))
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Send a page to one of the When days, keeping its time and length, with the old date offered back.
    func send(_ page: PageFacts, to choice: WhenChoice) async {
        let moved = ScheduleShift.move(
            start: page.scheduledStart, end: page.scheduledEnd, toDay: choice.day())
        await schedule(
            pageId: page.id, title: page.title, start: moved.start, end: moved.end,
            previousStart: page.scheduledStart, previousEnd: page.scheduledEnd, saying: choice.label)
    }

    /// A page dropped on an hour: the schedule moves, and the notice offers the old one back.
    public func schedule(
        pageId: String, title: String, start: String, end: String?,
        previousStart: String?, previousEnd: String?, saying day: String? = nil
    ) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.setPageSchedule(
                pageId: pageId, scheduledStart: start, scheduledEnd: end)
            await refresh()
            let name = title.isEmpty ? String(localized: "Untitled") : title
            let when = StorageTimestamp.wallClock(start).map {
                ClockTime.string($0)
            } ?? start
            notice = Notice(
                day.map { String(localized: "“\(name)” moved to \($0)") }
                    ?? String(localized: "“\(name)” at \(when)"),
                action: Notice.Action(title: String(localized: "Undo")) { [weak self] in
                    guard let self else { return }
                    if let previousStart {
                        await self.setSchedule(pageId: pageId, start: previousStart, end: previousEnd)
                    } else {
                        await self.clearDate(pageId: pageId)
                    }
                })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The one-sentence line under a title. An empty string takes it away.
    public func setSubtitle(pageId: String, to subtitle: String) async {
        guard let workspace else { return }
        await untilWritten {
            do {
                _ = try await workspace.updatePage(id: pageId, edit: PageEdit(subtitle: subtitle))
                await refresh()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    public struct ViewCounts: Equatable {
        public var today = 0
        public var upcoming = 0
        public var inbox = 0
        public var folders: [String: Int] = [:]
    }

    /// Open pages per view, for the switcher. Read when it opens rather than on every refresh.
    public func viewCounts() async -> ViewCounts {
        guard let workspace, let counted = try? await workspace.viewCounts() else { return ViewCounts() }
        var counts = ViewCounts()
        counts.today = Int(counted.today)
        counts.upcoming = Int(counted.upcoming)
        counts.inbox = Int(counted.inbox)
        counts.folders = counted.folders.mapValues(Int.init)
        return counts
    }

    /// Replace a page's tags. Whole-list rather than add/remove: tags are one JSON column plus a
    /// join table the writer keeps in step, so "remove one" would be a read-modify-write two quick
    /// edits could interleave and lose.
    ///
    /// Blank entries are dropped and the leading `#` is optional, as in quick add.
    public func setTags(pageId: String, to tags: [String]) async {
        guard let workspace else { return }
        let cleaned =
            tags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .map { $0.hasPrefix("#") ? String($0.dropFirst()) : $0 }
            .filter { !$0.isEmpty }
        do {
            _ = try await workspace.updatePage(id: pageId, edit: PageEdit(tags: cleaned))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// What a page repeats as, and whether this app may change it. Fetched on demand: a rule row
    /// per listed page would be a join on every refresh for a field almost no row uses.
    public func pageRepeat(for pageId: String) async -> PageRepeat? {
        guard let workspace else { return nil }
        do {
            return try await workspace.pageRepeat(pageId: pageId)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Make a page repeat, or change how it does. Returns whether it took, so a sheet knows whether
    /// to close. The workspace refuses a page with no date, a rule it cannot represent, and one a
    /// calendar owns, each with a sentence worth showing.
    @discardableResult
    public func setRepeat(pageId: String, to value: Repeat) async -> Bool {
        guard let workspace else { return false }
        do {
            try await workspace.setPageRepeat(pageId: pageId, pattern: value)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Stop a page repeating. The page stays, on the date it was last on.
    @discardableResult
    public func removeRepeat(pageId: String) async -> Bool {
        guard let workspace else { return false }
        do {
            try await workspace.removePageRepeat(pageId: pageId)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Take a page's date away, leaving any recurrence intact.
    public func clearDate(pageId: String) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.clearPageSchedule(pageId: pageId)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Set a page's priority, or take it away with `nil`. Stored low value first: 1 urgent through
    /// 4 low, 0 none. The naming runs opposite to the number, so the mapping lives in one place,
    /// and clearing says 0 out loud because `PageEdit.priority` uses nil for "leave it alone".
    public func setPriority(pageId: String, priority: Priority?) async {
        guard let workspace else { return }
        let stored: Int64
        switch priority {
        case .urgent: stored = 1
        case .high: stored = 2
        case .medium: stored = 3
        case .low: stored = 4
        case nil: stored = 0
        }
        do {
            _ = try await workspace.updatePage(id: pageId, edit: PageEdit(priority: stored))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Create whatever a quick-add line asks for, one page, several or a recurring one. Parsed in
    /// Rust by the code the desktop's parser is graded against. `reference` is passed explicitly
    /// rather than read from the clock, so a line typed at 23:59 cannot resolve against a different
    /// day than the one shown.
    public func createFromQuickAdd(
        _ line: String,
        reference: Date = Date(),
        folderId: String? = nil
    ) async -> [Page] {
        // A line typed in the moment after launch, before the workspace has opened, waits for it
        // rather than being dropped.
        await ensureStarted()
        guard let workspace else { return [] }
        do {
            let created = try await workspace.createFromQuickAdd(
                input: line,
                reference: Self.wallClock(reference),
                folderId: folderId,
                timezone: TimeZone.current.identifier
            )
            await refresh()
            noticeIfOutOfView(created)
            return created
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// Say where a new page went when it did not land in front of the user: adding "buy milk" on
    /// Today files it in the Inbox and nothing on screen changes, which reads as failure. Silent
    /// when the page landed in the current view.
    private func noticeIfOutOfView(_ created: [Page]) {
        guard let first = created.first, !pages.contains(where: { $0.id == first.id }) else {
            return
        }
        let destination: Scope
        if let folderId = first.folderId, let folder = folders.first(where: { $0.id == folderId }) {
            destination = .folder(id: folder.id, name: folder.name)
        } else if first.scheduledStart == nil {
            destination = .inbox
        } else {
            // Dated but not in view: it is somewhere on the calendar. Upcoming
            // is the nearest view that lists by date.
            destination = .upcoming
        }
        let count = created.count
        notice = Notice(
            count == 1
                ? String(localized: "Added to \(destination.title)")
                : String(localized: "Added \(count) pages to \(destination.title)"),
            action: Notice.Action(title: String(localized: "View")) { [weak self] in
                self?.scope = destination
            })
    }

    /// A `Date` as the wall-clock string the workspace speaks. Fixed format and locale with no
    /// timezone conversion: the stored value is a wall clock and `Date` an instant. `nonisolated`
    /// because it reads nothing from the store, and callers are not main-actor bound.
    nonisolated static func wallClock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.string(from: date)
    }

    /// Tick or untick a page. One call whatever the kind of page: the routing lives in Rust because
    /// the two operations behind this checkbox look identical at the call site and one is
    /// destructive (setting `status` on a recurring head ends the series; completing an occurrence
    /// clones and advances the head). Deciding here from `pages` would be wrong for a widget action
    /// or App Intent completing a page it never listed.
    public func setStatus(pageId: String, done: Bool) async {
        guard let workspace else { return }
        // A page not on screen may be recurring, and only a re-read shows where its head went.
        let isRecurring = pages.first { $0.id == pageId }?.isRecurring ?? true

        // Optimistic, but only for a plain page: a recurring one advances its head and adds a
        // completed clone, so there is nothing honest to show before the write lands. Written into
        // `sections`, the stored state (`pages` is a projection). The row stays ticked until the
        // refresh moves it to Completed, so the tick can be seen.
        if !isRecurring {
            sections = sections.map { section in
                guard section.pages.contains(where: { $0.id == pageId }) else { return section }
                let updated = section.pages.map { page -> PageSummary in
                    guard page.id == pageId else { return page }
                    var copy = page
                    copy.status = done ? "done" : "not_started"
                    return copy
                }
                return Section(id: section.id, title: section.title, pages: updated)
            }
        }

        do {
            try await workspace.setPageStatus(pageId: pageId, done: done)
            if done && !isRecurring {
                pendingTicks.insert(pageId)
                holdThenRefresh()
            } else {
                await refresh()
            }
        } catch {
            errorMessage = error.localizedDescription
            await refresh()
        }
    }

    /// Let a ticked row be seen before it goes. The write has landed; what waits is the re-read
    /// that moves the row to Completed. A row that vanishes on tap gives the eye nothing to confirm
    /// and no chance to undo a mis-tap, so a beat under a second holds it.
    ///
    /// One hold covers a run of ticks, so clearing five rows moves them together after the last;
    /// any other write refreshes at once and cancels the hold.
    private func holdThenRefresh() {
        pendingHold?.cancel()
        pendingHold = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(850))
            guard !Task.isCancelled else { return }
            await self?.settleTicks()
        }
    }

    private var pendingHold: Task<Void, Never>?
    /// Pages ticked during the current hold, taken out when it ends.
    private var pendingTicks: Set<String> = []

    // MARK: - Several pages at once

    /// Finish every selected page. The batch verbs exist for select mode and use the same workspace
    /// call as the single verb, so a repeating page still advances; the list re-reads once at the
    /// end.
    public func completePages(ids: [String]) async {
        guard let workspace, !ids.isEmpty else { return }
        var finished = 0
        for id in ids {
            do {
                try await workspace.setPageStatus(pageId: id, done: true)
                finished += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        await refresh()
        guard finished > 0 else { return }
        notice = Notice(
            finished == 1
                ? String(localized: "Completed 1 page")
                : String(localized: "Completed \(finished) pages"))
    }

    /// Put every selected page on a day, or take its date away. Pages a calendar owns or that
    /// repeat are left alone and counted: the workspace would refuse both, and "3 moved, 1 left"
    /// beats an error about the one.
    public func schedulePages(_ pages: [PageSummary], to day: String?) async {
        guard let workspace, !pages.isEmpty else { return }
        var moved = 0
        var kept = 0
        for page in pages {
            guard !page.scheduleLocked, !page.isRecurring else {
                kept += 1
                continue
            }
            do {
                if let day {
                    let moved = ScheduleShift.move(start: page.scheduledStart, end: page.scheduledEnd, toDay: day)
                    _ = try await workspace.setPageSchedule(
                        pageId: page.id, scheduledStart: moved.start, scheduledEnd: moved.end)
                } else {
                    _ = try await workspace.clearPageSchedule(pageId: page.id)
                }
                moved += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        await refresh()
        guard moved > 0 || kept > 0 else { return }
        let verb =
            day == nil
            ? String(localized: "Cleared the date on \(moved)")
            : String(localized: "Scheduled \(moved)")
        let tail =
            kept > 0
            ? " " + String(localized: "(\(kept) repeating or from a calendar, left alone)") : ""
        notice = Notice(verb + tail)
    }

    /// File every selected page into a folder, or the Inbox.
    public func movePages(_ pages: [PageSummary], toFolder folderId: String?) async {
        guard let workspace, !pages.isEmpty else { return }
        var moved = 0
        var kept = 0
        for page in pages {
            guard !page.scheduleLocked else {
                kept += 1
                continue
            }
            guard page.folderId != folderId else { continue }
            do {
                _ = try await workspace.updatePage(
                    id: page.id,
                    edit: PageEdit(folder: folderId.map { .folder(id: $0) } ?? .inbox))
                moved += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        await refresh()
        guard moved > 0 || kept > 0 else { return }
        let destination =
            folderId.flatMap { id in folders.first { $0.id == id }?.name }
            ?? String(localized: "Inbox")
        let tail =
            kept > 0 ? " " + String(localized: "(\(kept) from a calendar, left alone)") : ""
        notice = Notice(String(localized: "Moved \(moved) to \(destination)") + tail)
    }

    /// Trash every selected page, with one way back for all of them.
    public func trashPages(ids: [String]) async {
        guard let workspace, !ids.isEmpty else { return }
        var trashed: [String] = []
        for id in ids {
            do {
                try await workspace.trashPage(id: id)
                trashed.append(id)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        await refresh()
        guard !trashed.isEmpty else { return }
        notice = Notice(
            trashed.count == 1
                ? String(localized: "Deleted 1 page")
                : String(localized: "Deleted \(trashed.count) pages"),
            action: Notice.Action(title: String(localized: "Undo")) { [weak self] in
                guard let self, let workspace = self.workspace else { return }
                for id in trashed {
                    try? await workspace.restorePage(id: id)
                }
                await self.refresh()
            })
    }

    /// Move everything overdue onto today, saying what it did through `notice` with the way back
    /// attached. The sentence names what stayed behind (a series, a calendar's page), or a reader
    /// would believe the section cleared.
    ///
    /// Which pages are overdue is decided by the workspace, since the list on screen can be stale
    /// and a bulk write keyed on it moves pages the reader can no longer see.
    public func moveOverdueToToday() async {
        guard let workspace else { return }
        do {
            let result = try await workspace.moveOverdueToToday()
            await refresh()
            let moved = result.moved
            notice = Notice(
                result.label,
                action: moved.isEmpty
                    ? nil
                    : Notice.Action(title: "Undo") { [weak self] in
                        await self?.undoOverdueMove(moved)
                    })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put a bulk move back.
    public func undoOverdueMove(_ moved: [MovedPage]) async {
        guard let workspace, !moved.isEmpty else { return }
        do {
            _ = try await workspace.undoOverdueMove(moved: moved)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - One occurrence at a time

    /// The earlier occurrences of this block's series that are still open, oldest first, with
    /// anything already resolved taken out. Empty means acting on this one needs no question.
    public func backlog(behind entry: CalendarEntry) async -> [String] {
        guard let workspace, entry.isRecurring else { return [] }
        do {
            return try await workspace.occurrenceBacklog(
                pageId: entry.pageId, occurrenceDate: occurrence(of: entry).originalDate)
        } catch {
            // A question that cannot be asked is not worth an alert: the caller acts on the one
            // occurrence.
            return []
        }
    }

    /// Skip this occurrence and every open day behind it. Nothing is destroyed, so no confirmation:
    /// one before every skip would make the common case two taps. The undo is offered afterwards
    /// through `notice`. The gestured date goes first so the notice's count matches what the sheet
    /// offered.
    public func skipOccurrences(
        _ entry: CalendarEntry, andBacklog backlog: [String], title: String
    ) async -> [String] {
        guard let workspace else { return [] }
        let dates = [occurrence(of: entry).originalDate] + backlog
        let pageId = entry.pageId
        do {
            let skipped = try await workspace.skipOccurrences(pageId: pageId, dates: dates)
            await refresh()
            guard !skipped.isEmpty else { return skipped }
            notice = Notice(
                skipped.count == 1
                    ? String(localized: "Skipped \(title)")
                    : String(localized: "Skipped \(skipped.count) days of \(title)"),
                action: Notice.Action(title: String(localized: "Undo")) { [weak self] in
                    await self?.unskipOccurrences(pageId: pageId, dates: skipped)
                })
            return skipped
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// Skip the date a repeating page is on, which moves it to the next one its rule yields: what
    /// "delete this one" means for a series.
    func skipCurrentDate(of page: PageFacts) async {
        guard let workspace, let start = page.scheduledStart else { return }
        let pageId = page.id
        let title = page.title.isEmpty ? String(localized: "Untitled") : page.title
        do {
            let skipped = try await workspace.skipOccurrences(pageId: pageId, dates: [String(start.prefix(10))])
            await refresh()
            guard !skipped.isEmpty else { return }
            notice = Notice(
                String(localized: "Skipped \(title)"),
                action: Notice.Action(title: String(localized: "Undo")) { [weak self] in
                    await self?.unskipOccurrences(pageId: pageId, dates: skipped)
                })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func unskipOccurrences(pageId: String, dates: [String]) async {
        guard let workspace, !dates.isEmpty else { return }
        do {
            try await workspace.unskipOccurrences(pageId: pageId, dates: dates)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Complete this occurrence and every open day behind it, each as its own finished page.
    /// Returns how many were completed, counting the gestured one.
    public func completeOccurrences(_ entry: CalendarEntry, andBacklog backlog: [String]) async
        -> Int
    {
        guard let workspace else { return 0 }
        do {
            _ = try await workspace.completeRecurringOccurrence(
                pageId: entry.pageId, occurrence: occurrence(of: entry))
            let more = try await workspace.completeOccurrencesToToday(
                pageId: entry.pageId, maxSteps: UInt32(backlog.count))
            await refresh()
            return Int(more) + 1
        } catch {
            errorMessage = error.localizedDescription
            await refresh()
            return 0
        }
    }

    /// Move one occurrence of a series to a new time. Returns whether it took. Only a projected
    /// block can be moved this way: a real one is a row and moves through `setSchedule`. The guard
    /// is here as well as in the menu because a calendar can be a refresh out of date by the time a
    /// sheet is confirmed. The new wall clock is written in the phone's timezone.
    @discardableResult
    public func moveOccurrence(_ entry: CalendarEntry, to start: String, end: String?) async
        -> Bool
    {
        guard let workspace, let ruleId = entry.ruleId, let originalDate = entry.originalDate
        else { return false }
        do {
            try await workspace.moveOccurrence(
                ruleId: ruleId, originalDate: originalDate, scheduledStart: start,
                scheduledEnd: end, timezone: TimeZone.current.identifier)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Which occurrence a drawn block is, in the terms the sets are keyed by. A projected block
    /// carries the rule's date; a real one (the series head) does not, so its date is the first ten
    /// characters of its start, the same slice `pikos-db` takes, so the two cannot disagree.
    private func occurrence(of entry: CalendarEntry) -> Occurrence {
        Occurrence(
            originalDate: entry.originalDate ?? String(entry.scheduledStart.prefix(10)),
            scheduledStart: entry.scheduledStart,
            scheduledEnd: entry.scheduledEnd)
    }

    /// What is in the trash, newest first. Fetched on demand: the trash is opened rarely, so
    /// keeping it live would be paid for on every refresh.
    public func trashedPages() async -> [TrashedPage] {
        guard let workspace else { return [] }
        do {
            return try await workspace.listTrashedPages()
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// How long the trash keeps a page. Read from the workspace so the sentence
    /// shown to the user cannot drift from the purge that enforces it.
    public var trashRetentionDays: Int64 {
        workspace?.trashRetentionDays() ?? 30
    }

    /// Move a page to the trash, and offer the way back for a few seconds. `title` is what the
    /// notice names: the caller has it, and a lookup here would miss a page not in the current
    /// list.
    public func trash(pageId: String, title: String = "") async {
        guard let workspace else { return }
        do {
            try await workspace.trashPage(id: pageId)
            await refresh()
            let name = title.isEmpty ? String(localized: "page") : "“\(title)”"
            notice = Notice(
                String(localized: "Deleted \(name)"),
                action: Notice.Action(title: "Undo") { [weak self] in
                    await self?.restore(pageId: pageId)
                })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Stop a page repeating from the list, in one tap. The page stays on the date it was last on;
    /// what goes is the rule. Undo re-applies a rule the picker can hold; a richer one ("the last
    /// Friday of the month") cannot be rebuilt here, so the notice offers nothing that would half
    /// work.
    public func stopRepeating(pageId: String, title: String) async {
        guard let workspace else { return }
        let previous = try? await workspace.pageRepeat(pageId: pageId)
        do {
            try await workspace.removePageRepeat(pageId: pageId)
            await refresh()
            let name = title.isEmpty ? String(localized: "page") : "“\(title)”"
            var undo: Notice.Action?
            if case .editable(let rule, _) = previous {
                undo = Notice.Action(title: "Undo") { [weak self] in
                    await self?.setRepeat(pageId: pageId, to: rule)
                }
            }
            notice = Notice(String(localized: "\(name) no longer repeats"), action: undo)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func restore(pageId: String) async {
        guard let workspace else { return }
        do {
            try await workspace.restorePage(id: pageId)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The document schema this build writes.
    ///
    /// A page whose `contentSchemaVersion` exceeds this must be opened
    /// read-only: saving would re-serialise through an older schema and
    /// silently drop node types this build cannot represent.
    public var contentSchemaVersion: Int64 {
        workspace?.contentSchemaVersion() ?? 0
    }

    public func canEdit(_ page: Page) -> Bool {
        page.contentSchemaVersion <= contentSchemaVersion
    }
}

extension PageSort.Mode {
    var listSort: ListSort {
        switch self {
        case .manual: return .manual
        case .date: return .date
        case .title: return .title
        case .priority: return .priority
        }
    }
}
