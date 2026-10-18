import PikosCore
import PikosSupport
import SwiftUI
import TipKit

/// The list pane: the view being shown, the rest of today under it, and every verb a row has.
/// The day under it is left out wherever the calendar is on screen beside it.
///
/// The title is the switcher, as it is on the desktop when the sidebar is hidden; the sort/select
/// menu is the header's one tool. Search lives in the bottom bar, in reach from either pane.
struct PageListScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(SettingsStore.self) private var settings
    @Environment(PageDragSession.self) private var drag

    @State private var actions = PageActionState()
    @State private var isMovingOverdue = false
    @State private var isSelecting = false
    @State private var selection: Set<String> = []
    @State private var datingSelection: SelectedPages?
    @State private var isSwipeTipAvailable = false

    private let swipeTip = SwipeRowTip()

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.shellLayout) private var layout

    var body: some View {
        VStack(spacing: 0) {
            header
            VStack(spacing: 0) {
                content
                    .frame(maxHeight: .infinity)
                if isSelecting || layout != .single {
                    Color.clear.frame(height: ShellBar.clearance)
                } else {
                    DayPeek()
                        .transition(.move(edge: .bottom))
                }
            }
            // An overlay, so the switcher's height never sets the pane's: as a stacked sibling, a
            // keyboard raised to name a folder made the pane overflow and push the header under the clock.
            .overlay(alignment: .top) {
                if route.isSwitcherPresented {
                    switcherLayer
                }
            }
        }
        .background(.surfacePrimary)
        .overlay(alignment: .bottom) {
            if isSelecting {
                selectionBar
                    .transition(.opacity)
            }
        }
        .environment(\.editMode, .constant(isSelecting ? .active : .inactive))
        .pageActionSheets($actions)
        .sheet(item: $datingSelection) { batch in
            SchedulePageSheet(pages: batch.pages) { leaveSelection() }
        }
        .animation(reduceMotion ? nil : .pkQuick, value: isSelecting)
        .animation(reduceMotion ? nil : .pkQuick, value: route.isSwitcherPresented)
        .onChange(of: store.scope) { _, _ in leaveSelection() }
        .onChange(of: isSelecting) { _, selecting in route.isSelectingPages = selecting }
        .task {
            for await status in swipeTip.statusUpdates {
                isSwipeTipAvailable = status == .available
                if case .invalidated = status { SwitchViewTip.isSwipeTipDone = true }
            }
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        if isSelecting {
            PaneHeader {
                Button(selection.count == selectable.count && store.nextWindow == nil ? "Deselect all" : "Select all") {
                    if selection.count == selectable.count && store.nextWindow == nil {
                        selection = []
                    } else {
                        Task {
                            await store.loadAllRows()
                            selection = Set(selectable.map(\.id))
                        }
                    }
                }
                .font(.pkUI)
                .foregroundStyle(.textAction)
                .frame(minHeight: 44)
            } trailing: {
                Text(selection.isEmpty ? String(localized: "Select pages") : String(localized: "\(selection.count) selected"))
                    .font(.pkUI)
                    .foregroundStyle(.textSecondary)
                    .padding(.trailing, 12)
                Button("Done") { leaveSelection() }
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(.textAction)
                    .frame(minWidth: 44, minHeight: 44)
                    .padding(.trailing, 8)
            }
        } else {
            PaneHeader {
                switcherButton
            } trailing: {
                if !store.scope.isDateGrouped {
                    sortMenu
                }
                if canSelect {
                    Button("Select") { enterSelection() }
                        .font(.pkUI)
                        .foregroundStyle(.textAction)
                        .frame(minWidth: 44, minHeight: 44)
                } else {
                    // Its room is kept, so the tools beside it stay put when the first page arrives.
                    Text("Select")
                        .font(.pkUI)
                        .frame(minWidth: 44, minHeight: 44)
                        .hidden()
                }
                Button {
                    route.isSettingsPresented = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Settings")
            }
        }
    }

    /// Spring-loaded, so a page carried onto the title and held there opens the folders to drop it on.
    private var switcherButton: some View {
        Button {
            route.isSwitcherPresented = drag.page != nil || !route.isSwitcherPresented
        } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(store.scope.title)
                        .font(.pkScreenTitle)
                        .foregroundStyle(.textPrimary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.textTertiary)
                        .rotationEffect(.degrees(route.isSwitcherPresented ? 180 : 0))
                }
                Text(subline)
                    .font(.pkUISm)
                    .foregroundStyle(.textTertiary)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .springLoadingBehavior(.enabled)
        .accessibilityLabel("Switch view")
        .accessibilityValue(store.scope.title)
        .popoverTip(SwitchViewTip(), arrowEdge: .top)
    }

    private var subline: String {
        let open = store.pages.count
        let count = open == 0 ? String(localized: "Nothing open") : String(localized: "\(open) open")
        switch store.scope {
        case .today:
            return Date().formatted(.dateTime.weekday(.wide).month(.wide).day()) + " · " + count
        case .upcoming:
            return String(localized: "Next seven days") + " · " + count
        case .inbox, .folder:
            return count
        }
    }

    /// Today and Upcoming leave it out: they are ordered by time, which is what makes them those views.
    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: sortBinding) {
                ForEach(PageSort.Mode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            #if DEBUG
                if let read = store.lastRefresh {
                    Divider()
                    Text("Last read in \(Int(read / .milliseconds(1))) ms")
                }
            #endif
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Sort")
    }

    /// Capped by the pane as well as by 560 points: a phone on its side has about 300 under the
    /// header, and the trash at the switcher's foot has to stay above the bar.
    private var switcherLayer: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                Color.black.opacity(colorScheme == .dark ? 0.5 : 0.16)
                    .ignoresSafeArea(edges: .bottom)
                    .onTapGesture { route.isSwitcherPresented = false }
                    .accessibilityHidden(true)
                    .transition(.opacity)
                ScopeSwitcher()
                    .frame(maxHeight: min(560, geometry.size.height - ShellBar.clearance))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
                    .transition(.opacity)
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if store.isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.pages.isEmpty && store.completedTotal == 0 {
            // Nothing open *and* nothing finished; a view of finished work still has a section to reach.
            emptyState
        } else {
            list
        }
    }

    private var list: some View {
        // Nil unless selecting: a row in a List carrying any selection binding selects instead of opening.
        List(selection: isSelecting ? $selection : nil) {
            // Only while the tip is live: an invalidated TipView still leaves an empty row behind.
            if !isSelecting && isSwipeTipAvailable {
                TipView(swipeTip)
                    .tipBackground(.surfaceSecondary)
                    .listRowBackground(Color.surfacePrimary)
                    .listRowSeparator(.hidden)
            }

            if visibleSections.isEmpty {
                Text("Nothing open here.")
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .listRowBackground(Color.surfacePrimary)
                    .listRowSeparator(.hidden)
            }

            // Headings are rows, not sticky `Section` headers: the desktop's don't stick, and a plain
            // List's header carries top padding nothing can remove.
            let readsMoreAt = store.readMoreAt
            ForEach(visibleSections) { section in
                if let title = section.title {
                    sectionHeader(title, section: section)
                }
                ForEach(section.pages, id: \.id) { page in
                    row(page)
                        .onAppear {
                            if page.id == readsMoreAt { Task { await store.loadMoreRows() } }
                        }
                }
                .onMove(perform: canReorder ? { from, to in move(in: section, from: from, to: to) } : nil)
            }

            completedSection
        }
        .listStyle(.plain)
        .minimizesShellBar()
        .scrollContentBackground(.hidden)
        .background(.surfacePrimary)
        .environment(\.defaultMinListRowHeight, 44)
        .environment(\.defaultMinListHeaderHeight, 0)
        // On a re-read after a write, not on more rows arriving: comparing every row and animating
        // a window's insert is what made a long list hitch as it grew.
        .animation(reduceMotion ? nil : .pkQuick, value: store.dataVersion)
        .refreshable { await store.refresh() }
        .onChange(of: sortMode, initial: true) { _, mode in store.listSort = mode }
    }


    private func row(_ page: PageSummary) -> some View {
        let done = page.status == "done"
        let facts = PageFacts(page)
        let separatorLeading: CGFloat = isSelecting ? 0 : 44
        // The checkbox sits beside the link, not inside it: a Button in a link's label loses its tap.
        return HStack(alignment: .top, spacing: 0) {
            if !isSelecting {
                CompletionToggle(isDone: done, priority: PagePriority(stored: page.priority)) { done in
                    Task { await store.setStatus(pageId: page.id, done: done) }
                }
            }
            PageRow(page: page, showsFolder: store.scope.isDateGrouped)
                .padding(.leading, isSelecting ? 4 : 0)
        }
        .contentShape(Rectangle())
        .modifier(OpensPage(id: page.id, isEnabled: !isSelecting))
        .tag(page.id)
        .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 16))
        .listRowBackground(
            drag.page?.id == page.id || (layout == .split && route.openPageId == page.id)
                ? Color.surfaceSelected : Color.surfacePrimary)
        .listRowSeparatorTint(.borderSecondary)
        .alignmentGuide(.listRowSeparatorLeading) { _ in separatorLeading }
        // `PKOS-0150`: the likeliest day, any other day, and a folder. The checkbox completes, so
        // nothing is on the other side.
        .swipeActions(edge: .trailing) {
            if !page.scheduleLocked {
                if !done && !page.isRecurring {
                    let day = Self.swipeDay(for: page.scheduledStart)
                    Button {
                        Task { await store.send(facts, to: day) }
                    } label: {
                        Label(day.label, systemImage: day.systemImage)
                    }
                    .tint(.interactiveFill)
                    Button {
                        actions.sheet = .schedule(facts)
                    } label: {
                        Label("When", systemImage: "calendar")
                    }
                    .tint(.interactiveFillNeutral)
                }
                Button {
                    actions.sheet = .folder(facts)
                } label: {
                    Label("Folder", systemImage: "folder")
                }
                .tint(.interactiveFillNeutral)
            }
        }
        .contextMenu { PageActionsMenu(page: facts, state: $actions) }
        .modifier(SchedulableRow(page: facts, isEnabled: !isSelecting && canDragToSchedule(page)))
    }

    /// A repeating page's date belongs to its rule and a calendar's page to the calendar.
    private func canDragToSchedule(_ page: PageSummary) -> Bool {
        page.status != "done" && !page.isRecurring && !page.scheduleLocked
    }

    private func sectionHeader(_ title: String, section: WorkspaceStore.Section) -> some View {
        let isOverdue = section.id == "overdue"
        return HStack(spacing: 6) {
            Text(title)
                .sectionLabelStyle(isOverdue ? .statusOverdue : .textTertiary)
            Text("\(section.pages.count)")
                .font(.pkUISm)
                .monospacedDigit()
                .foregroundStyle(.textTertiary)
            Spacer()
            if isOverdue && !isSelecting {
                if isMovingOverdue {
                    ProgressView().controlSize(.small)
                } else {
                    // No confirmation: the move is cheap, visible, and the notice carries the undo.
                    Button {
                        Task {
                            isMovingOverdue = true
                            defer { isMovingOverdue = false }
                            await store.moveOverdueToToday()
                        }
                    } label: {
                        Text("Move to today").touchTarget()
                    }
                    .font(.pkUISm)
                    .foregroundStyle(.textAction)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, section.id == visibleSections.first?.id ? 10 : 22)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.surfacePrimary)
        .listRowSeparator(.hidden)
        .selectionDisabled()
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityAddTraits(.isHeader)
    }

    /// The day a page is likeliest to go to next: today for anything not yet due by today, and
    /// tomorrow for what is.
    private static func swipeDay(for scheduledStart: String?) -> WhenChoice {
        guard let scheduledStart else { return .today }
        return String(scheduledStart.prefix(10)) <= DayLabel.today() ? .tomorrow : .today
    }

    // MARK: - Finished work

    /// Collapsed and loaded only when opened: a folder's finished pages grow without limit.
    @ViewBuilder
    private var completedSection: some View {
        Button {
            withAnimation(reduceMotion ? nil : .pkQuick) { store.toggleCompleted() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .rotationEffect(.degrees(store.isCompletedExpanded ? 90 : 0))
                Text("Completed")
                    .font(.pkUI)
                if store.completedTotal > 0 {
                    Text("\(store.completedTotal)")
                        .font(.pkUISm)
                        .monospacedDigit()
                        .foregroundStyle(.textTertiary)
                }
                Spacer()
            }
            .foregroundStyle(.textTertiary)
            .padding(.leading, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.surfacePrimary)
        .listRowSeparator(.hidden)
        .accessibilityLabel(completedTitle)
        .accessibilityValue(store.isCompletedExpanded ? "Expanded" : "Collapsed")

        if store.isCompletedExpanded {
            if store.completedPages.isEmpty {
                Text(store.hasLoadedCompleted ? "Nothing finished here yet." : "Loading…")
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .padding(.leading, 38)
                    .listRowBackground(Color.surfacePrimary)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(store.completedPages, id: \.id) { page in
                    row(page)
                }
                if store.hasMoreCompleted {
                    Button("Show more") {
                        Task { await store.loadMoreCompleted() }
                    }
                    .font(.pkUI)
                    .foregroundStyle(.textAction)
                    .padding(.leading, 38)
                    .listRowBackground(Color.surfacePrimary)
                    .listRowSeparator(.hidden)
                }
            }
        }
    }

    private var completedTitle: String {
        store.completedTotal > 0
            ? String(localized: "Completed (\(store.completedTotal))") : String(localized: "Completed")
    }

    // MARK: - Ordering

    private var visibleSections: [WorkspaceStore.Section] {
        orderedSections.filter { !$0.pages.isEmpty }
    }

    /// Date views arrive in schedule order, and a folder or the Inbox in the reader's chosen order,
    /// read that way a window at a time.
    private var orderedSections: [WorkspaceStore.Section] { store.sections }

    /// Only a manual order can be arranged by hand, as on the desktop, and a date view is always in
    /// schedule order.
    private var canReorder: Bool {
        guard sortMode == .manual else { return false }
        switch store.scope {
        case .inbox, .folder: return true
        case .today, .upcoming: return false
        }
    }

    private func move(in section: WorkspaceStore.Section, from source: IndexSet, to destination: Int) {
        guard let moved = source.first.map({ section.pages[$0].id }) else { return }
        var arranged = section.pages
        arranged.move(fromOffsets: source, toOffset: destination)
        guard let landed = arranged.firstIndex(where: { $0.id == moved }) else { return }
        let after = landed > 0 ? arranged[landed - 1].id : nil
        let before = landed + 1 < arranged.count ? arranged[landed + 1].id : nil
        Task { await store.movePage(moved, after: after, before: before) }
    }

    private var sortViewId: String {
        switch store.scope {
        case .today: return "today"
        case .upcoming: return "upcoming"
        case .inbox: return "inbox"
        case .folder(let id, _): return id
        }
    }

    /// Manual by default and chronological for a calendar's folder, as the desktop picks.
    private var sortMode: PageSort.Mode {
        let fallback: PageSort.Mode
        if case .folder(let id, _) = store.scope,
            store.folders.first(where: { $0.id == id })?.isExternalCalendar == true
        {
            fallback = .date
        } else {
            fallback = .manual
        }
        return settings.listSort(for: sortViewId, fallback: fallback)
    }

    private var sortBinding: Binding<PageSort.Mode> {
        Binding(get: { sortMode }, set: { settings.setListSort($0, for: sortViewId) })
    }

    // MARK: - Empty state

    /// The one place the app teaches capture: a sentence the parser reads, opening quick add with it.
    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            Image(systemName: emptyIcon)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(.textDisabled)
                .padding(.bottom, 4)
            Text("Nothing here yet")
                .font(.pkHeadingSm)
                .foregroundStyle(.textPrimary)
            Text(emptyDescription)
                .font(.pkBodySm)
                .foregroundStyle(.textTertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            if let example = emptyExample {
                Button {
                    route.presentQuickAdd(from: store, under: .list)
                    route.quickAddPrefill = example
                } label: {
                    ExampleSentence(text: example)
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
                .accessibilityLabel("Try “\(example)”")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }

    /// Chosen so that adding it lands in the view the reader is looking at.
    private var emptyExample: String? {
        switch store.scope {
        case .today: return "Call the dentist today at 3pm !high #health"
        case .upcoming: return "Review the budget Friday at 10am"
        case .inbox: return "Ideas for the garden #home"
        case .folder: return nil
        }
    }

    private var emptyIcon: String {
        switch store.scope {
        case .today: return "sun.max"
        case .upcoming: return "calendar"
        case .inbox: return "tray"
        case .folder: return "folder"
        }
    }

    private var emptyDescription: String {
        switch store.scope {
        case .today:
            return String(
                localized: "Pages scheduled for today appear here. Type a sentence and Pikos reads the date, time, priority and tags out of it.")
        case .upcoming: return String(localized: "Pages scheduled in the next week will appear here.")
        case .inbox:
            return String(
                localized: "Pages you haven't filed or dated wait here. Swipe one to send it to today or tomorrow.")
        case .folder(_, let name): return String(localized: "Nothing in \(name) yet.")
        }
    }

    // MARK: - Selecting several

    /// Finish, date, file, delete: one store call each and one notice, whose Undo covers a delete.
    private var selectionBar: some View {
        HStack(spacing: 0) {
            verb("Complete", systemImage: "checkmark.circle") {
                let ids = orderedSelection.map(\.id)
                Task {
                    await store.completePages(ids: ids)
                    leaveSelection()
                }
            }
            // A disabled Menu keeps drawing its label as enabled, so an empty selection gets a plain
            // disabled verb in its place.
            if selection.isEmpty {
                verb("When", systemImage: "calendar") {}
                verb("Move", systemImage: "folder") {}
            } else {
                Menu {
                    WhenMenuItems(
                        onChoose: { schedule(to: $0.day()) },
                        onPickDate: { datingSelection = SelectedPages(pages: orderedSelection) },
                        onClear: { schedule(to: nil) })
                } label: {
                    verbLabel("When", systemImage: "calendar")
                }
                Menu {
                    Picker("Move to folder", selection: Binding(get: { String?.some("") }, set: { move(to: $0) })) {
                        FolderChoices(folders: store.fileableFolders)
                    }
                    .pickerStyle(.inline)
                } label: {
                    verbLabel("Move", systemImage: "folder")
                }
            }
            verb("Delete", systemImage: "trash", role: .destructive) {
                let ids = orderedSelection.map(\.id)
                Task {
                    await store.trashPages(ids: ids)
                    leaveSelection()
                }
            }
        }
        .padding(.horizontal, 8)
        .frame(height: ShellBar.height)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .floatingSurface(in: Capsule())
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private func verb(
        _ title: LocalizedStringKey, systemImage: String, role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            verbLabel(title, systemImage: systemImage, isDestructive: role == .destructive)
        }
        .buttonStyle(.plain)
        .disabled(selection.isEmpty)
    }

    private func verbLabel(_ title: LocalizedStringKey, systemImage: String, isDestructive: Bool = false)
        -> some View
    {
        VStack(spacing: 3) {
            // One height for every symbol, or a taller one pushes its label below the others.
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .regular))
                .frame(height: 22)
            Text(title)
                .font(.system(.caption2, weight: .medium))
        }
        .foregroundStyle(
            selection.isEmpty
                ? Color.textDisabled : (isDestructive ? Color.statusOverdue : Color.textSecondary)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    private var canSelect: Bool {
        !store.pages.isEmpty || store.completedTotal > 0
    }

    private var selectable: [PageSummary] {
        visibleSections.flatMap(\.pages) + (store.isCompletedExpanded ? store.completedPages : [])
    }

    private var orderedSelection: [PageSummary] {
        selectable.filter { selection.contains($0.id) }
    }

    private func enterSelection() {
        selection = []
        isSelecting = true
    }

    private func leaveSelection() {
        isSelecting = false
        selection = []
    }

    private func schedule(to day: String?) {
        let pages = orderedSelection
        Task {
            await store.schedulePages(pages, to: day)
            leaveSelection()
        }
    }

    private func move(to folderId: String?) {
        let pages = orderedSelection
        Task {
            await store.movePages(pages, toFolder: folderId)
            leaveSelection()
        }
    }
}

/// The pages select mode is dating through the When sheet.
private struct SelectedPages: Identifiable {
    let id = UUID()
    let pages: [PageSummary]
}

/// A tap on a row opens its page: pushed over the list on a phone, and in the three panels put in
/// place of whatever the detail column holds, which a link in the list's column cannot reach.
private struct OpensPage: ViewModifier {
    let id: String
    let isEnabled: Bool

    @Environment(Route.self) private var route
    @Environment(\.shellLayout) private var layout

    func body(content: Content) -> some View {
        if !isEnabled {
            content
        } else if layout == .split {
            content.onTapGesture { route.path = [.page(id)] }
        } else {
            content.background {
                NavigationLink(value: Route.Destination.page(id)) { EmptyView() }.opacity(0)
            }
        }
    }
}

/// Lifting a row carries the page to the day under the list.
private struct SchedulableRow: ViewModifier {
    let page: PageFacts
    let isEnabled: Bool

    @Environment(PageDragSession.self) private var drag

    func body(content: Content) -> some View {
        if isEnabled {
            content.onDrag {
                drag.itemProvider(for: page)
            } preview: {
                PageDragPreview(title: page.title)
            }
        } else {
            content
        }
    }
}

/// A quick-add line with the parts the parser reads out of it picked out, the way the chips will be.
struct ExampleSentence: View {
    let text: String

    var body: some View {
        VStack(spacing: 6) {
            Text("Try")
                .sectionLabelStyle()
            styled
                .font(.pkBodySm)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.borderSecondary, lineWidth: 1))
    }

    private var styled: Text {
        text.split(separator: " ", omittingEmptySubsequences: false).enumerated().reduce(Text("")) {
            partial, item in
            let word = String(item.element)
            let piece = Text(item.offset == 0 ? word : " " + word)
            if word.hasPrefix("!") { return partial + piece.foregroundColor(.textDueSoon) }
            if word.hasPrefix("#") || word.hasPrefix("~") { return partial + piece.foregroundColor(.textTertiary) }
            if Self.dateWords.contains(word.lowercased()) || word.lowercased().hasSuffix("pm")
                || word.lowercased().hasSuffix("am") || word == "at"
            {
                return partial + piece.foregroundColor(.textAction)
            }
            return partial + piece.foregroundColor(.textPrimary)
        }
    }

    private static let dateWords: Set<String> = [
        "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    ]
}
