import PikosCore
import PikosSupport
import SwiftUI

/// Recently deleted pages, and the way back.
///
/// Read-only apart from restore. Emptying the trash by hand is not offered: the retention window
/// clears it, and a permanent delete next to a restore button is the mis-tap this screen exists
/// to recover from.
struct TrashSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var pages: [TrashedPage] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if pages.isEmpty {
                    ContentUnavailableView(
                        "Nothing deleted",
                        systemImage: "trash",
                        description: Text(
                            "Deleted pages appear here for \(store.trashRetentionDays) days."))
                } else {
                    List {
                        Group {
                            Section {
                                ForEach(pages, id: \.id) { page in
                                    row(page)
                                }
                            } footer: {
                                Text(retentionFooter)
                            }
                        }
                        .pikosFormRows()
                    }
                }
            }
            .navigationTitle("Trash")
            .pikosFormStyle()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func row(_ page: TrashedPage) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(page.title.isEmpty ? "Untitled" : page.title)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    // Marked visibly, not only to VoiceOver: the retention sentence in the footer isn't true of
                    // these rows.
                    if page.isSynced {
                        Image(systemName: "calendar")
                            .accessibilityHidden(true)
                    }
                    if let folder = page.folderName {
                        Text(folder)
                    }
                    Text(Self.deletedLabel(page.deletedAt))
                }
                .font(.caption)
                .foregroundStyle(.textSecondary)
            }
            Spacer(minLength: 8)
            Button("Restore") {
                Task {
                    await store.restore(pageId: page.id)
                    await load()
                }
            }
            .font(.callout)
            .buttonStyle(.borderless)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibleLabel(page))
        // The leading swipe restores, as it completes on the list. The button stays for anyone who
        // does not swipe.
        .swipeActions(edge: .leading) {
            Button {
                Task {
                    await store.restore(pageId: page.id)
                    await load()
                }
            } label: {
                Label("Restore", systemImage: "arrow.uturn.backward")
            }
            .tint(.interactiveFill)
        }
    }

    private func accessibleLabel(_ page: TrashedPage) -> String {
        var parts = [page.title.isEmpty ? "Untitled" : page.title]
        if let folder = page.folderName { parts.append("in \(folder)") }
        parts.append(Self.deletedLabel(page.deletedAt))
        if page.isSynced { parts.append("from a calendar, kept until it is deleted there") }
        return parts.joined(separator: ", ")
    }

    /// A page mirroring a calendar event is never purged: `purge_trashed_pages` routes every
    /// eligible row through the app's one delete, which keeps a mirror soft-deleted so its tombstone
    /// suppresses the upstream event, and destroying it would let the next sync re-create the page.
    /// So the retention sentence holds only for native pages, and the second appears only when a
    /// mirror row is on screen.
    private var retentionFooter: String {
        let base = String(localized: "Pages are removed permanently after \(store.trashRetentionDays) days.")
        guard pages.contains(where: \.isSynced) else { return base }
        return base + " " + String(localized: "Pages from a calendar stay here until they're deleted in the calendar.")
    }

    private func load() async {
        isLoading = true
        pages = await store.trashedPages()
        isLoading = false
    }

    /// "Deleted 3 days ago", from the UTC stamp the data layer writes. Falls back to the raw value
    /// rather than inventing a date: a malformed stamp is worth seeing. `deleted_at` is a UTC
    /// instant, not the zoneless wall clock the scheduling fields use, and `PikosSupport` is where
    /// that parse is tested.
    private static func deletedLabel(_ stamp: String) -> String {
        guard let deleted = StorageTimestamp.utc(stamp) else { return stamp }
        return String(localized: "Deleted \(deleted.formatted(.relative(presentation: .named)))")
    }
}
