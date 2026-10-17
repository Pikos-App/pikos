import PikosCore
import PikosSupport
import SwiftUI

/// The desktop's page header on a phone: title, subtitle, and the byline under them.
///
/// Title and subtitle are edited in place and saved when the field lets go. A page a calendar
/// owns keeps its title read-only, as the desktop does; its subtitle, status, priority and tags
/// stay the reader's.
struct EditorHeader: View {
    let page: Page
    @Binding var actions: PageActionState
    var focus: FocusState<Field?>.Binding

    enum Field: Hashable {
        case title
        case subtitle
    }

    @Environment(WorkspaceStore.self) private var store

    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var title = ""
    @State private var subtitle = ""
    @State private var isBylineOpen = false

    private var facts: PageFacts { PageFacts(page) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The list's checkbox, beside the title as it is beside a row's.
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                CompletionToggle(isDone: facts.isDone, priority: PagePriority(stored: page.priority)) { done in
                    Task { await store.setStatus(pageId: page.id, done: done) }
                }
                .frame(width: 26, height: 26)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 7 }
                .padding(.leading, -4)
                TextField("Untitled", text: $title, axis: .vertical)
                    .font(.pkDisplay)
                    .tracking(-0.4)
                    .foregroundStyle(facts.isDone ? Color.textTertiary : Color.textPrimary)
                    .lineLimit(1...4)
                    .focused(focus, equals: .title)
                    .submitLabel(.next)
                    .disabled(page.scheduleLocked)
                    .onSubmit { focus.wrappedValue = .subtitle }
                    .accessibilityLabel("Title")
            }

            TextField("Add a subtitle", text: $subtitle, axis: .vertical)
                .font(.pkBody)
                .foregroundStyle(.textSecondary)
                .lineLimit(1...3)
                .focused(focus, equals: .subtitle)
                .submitLabel(.done)
                .onSubmit { focus.wrappedValue = nil }
                .accessibilityLabel("Subtitle")

            byline
                .padding(.top, 6)
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.surfacePrimary)
        .onAppear {
            title = page.title
            subtitle = page.subtitle ?? ""
        }
        .onChange(of: page.title) { _, new in
            if focus.wrappedValue != .title { title = new }
        }
        .onChange(of: page.subtitle) { _, new in
            if focus.wrappedValue != .subtitle { subtitle = new ?? "" }
        }
        .onChange(of: focus.wrappedValue) { old, _ in
            switch old {
            case .title: commitTitle()
            case .subtitle: commitSubtitle()
            case nil: break
            }
        }
        .onDisappear {
            commitTitle()
            commitSubtitle()
        }
    }

    // MARK: - Byline

    /// Wraps rather than scrolls: a byline cut off at the edge hid its priority and every tag. At
    /// accessibility sizes it folds to its first chip and More, or it fills the screen before the
    /// document starts.
    @ViewBuilder
    private var byline: some View {
        let folds = typeSize.isAccessibilitySize && !isBylineOpen
        FlowLayout(spacing: 12, lineSpacing: 6) {
            folderChip
            if folds {
                Button("More") { isBylineOpen = true }
                    .foregroundStyle(.textAction)
                    .touchTarget()
            } else {
                if let start = page.scheduledStart {
                    dateChip(start)
                    ReminderChip(pageId: page.id, isAllDay: CalendarGeometry.isAllDay(start))
                }
                if let priority = PagePriority(stored: page.priority) {
                    priorityChip(priority)
                }
                tagsChip
            }
        }
        .font(.pkUISm)
        .foregroundStyle(.textTertiary)
        .frame(minHeight: 28)
    }

    @ViewBuilder
    private var folderChip: some View {
        let folder = page.folderId.flatMap { id in store.folders.first { $0.id == id } }
        let label = HStack(spacing: 5) {
            if let folder, folder.isExternalCalendar {
                Image(systemName: "calendar.badge.clock")
            } else if let folder {
                Circle().fill(Color(hex: folder.color) ?? Color.textDisabled).frame(width: 7, height: 7)
            } else {
                Image(systemName: "tray")
            }
            Text(folder?.name ?? String(localized: "Inbox")).lineLimit(1)
        }
        .touchTarget()
        if page.scheduleLocked {
            label
        } else {
            Menu {
                Picker("Folder", selection: Binding(get: { page.folderId }, set: { move(to: $0) })) {
                    FolderChoices(folders: store.fileableFolders)
                }
                .pickerStyle(.inline)
            } label: {
                label
            }
            .accessibilityLabel("Folder: \(folder?.name ?? String(localized: "Inbox"))")
        }
    }

    private func dateChip(_ start: String) -> some View {
        Button {
            if page.scheduleLocked { return }
            actions.sheet = page.isRecurring ? .repeatRule(facts) : .schedule(facts)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: page.isRecurring ? "repeat" : "calendar")
                ScheduleLabel(iso: start, end: page.scheduledEnd, isDone: facts.isDone)
            }
            .touchTarget()
        }
        .buttonStyle(.plain)
    }

    private func priorityChip(_ priority: PagePriority) -> some View {
        Menu {
            PriorityPalette(stored: page.priority) { setPriority($0) }
        } label: {
            HStack(spacing: 4) {
                Text(priority.mark).fontWeight(.heavy)
                Text(priority.name)
            }
            .foregroundStyle(priority.textColor)
            .touchTarget()
        }
        .accessibilityLabel("Priority: \(priority.name)")
    }

    private var tagsChip: some View {
        Button {
            actions.sheet = .tags(facts)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tag")
                Text(page.tags.isEmpty ? String(localized: "Add tags") : page.tags.map { "#\($0)" }.joined(separator: " "))
                    .foregroundStyle(.textTertiary)
            }
            .touchTarget()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(page.tags.isEmpty ? String(localized: "Add tags") : String(localized: "Tags: \(page.tags.joined(separator: ", "))"))
    }

    // MARK: - Writes

    private func commitTitle() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !page.scheduleLocked, !trimmed.isEmpty, trimmed != page.title else {
            if trimmed.isEmpty { title = page.title }
            return
        }
        Task { await store.renamePage(id: page.id, to: trimmed) }
    }

    private func commitSubtitle() {
        let trimmed = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != (page.subtitle ?? "") else { return }
        Task { await store.setSubtitle(pageId: page.id, to: trimmed) }
    }

    private func move(to folderId: String?) {
        guard page.folderId != folderId else { return }
        Task { await store.movePage(id: page.id, toFolder: folderId) }
    }

    private func setPriority(_ priority: Priority?) {
        Task { await store.setPriority(pageId: page.id, priority: priority) }
    }
}
