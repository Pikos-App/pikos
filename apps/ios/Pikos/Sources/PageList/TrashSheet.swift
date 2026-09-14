import PikosCore
import PikosSupport
import SwiftUI

/// Recently deleted pages, and the way back.
///
/// Exists because swipe-to-delete did not have one. A phone is the device most
/// likely to produce an accidental swipe and was the only one with no way to
/// undo it — the page was gone as far as the user could tell, even though the
/// delete had been soft all along.
///
/// Read-only apart from restore. Emptying the trash by hand is deliberately not
/// offered: the retention window already clears it, and a permanent delete on a
/// small screen next to a restore button is the same mis-tap this screen exists
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
                        Section {
                            ForEach(pages, id: \.id) { page in
                                row(page)
                            }
                        } footer: {
                            Text(retentionFooter)
                        }
                    }
                }
            }
            .navigationTitle("Recently Deleted")
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
                    // Marked visibly, not only to VoiceOver: the retention
                    // sentence in the footer is not true of these rows, and a
                    // reader who cannot tell which ones they are has been told
                    // something false about the page in front of them.
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
                .foregroundStyle(.secondary)
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
    }

    private func accessibleLabel(_ page: TrashedPage) -> String {
        var parts = [page.title.isEmpty ? "Untitled" : page.title]
        if let folder = page.folderName { parts.append("in \(folder)") }
        parts.append(Self.deletedLabel(page.deletedAt))
        if page.isSynced { parts.append("from a calendar, kept until it is deleted there") }
        return parts.joined(separator: ", ")
    }

    /// What actually happens to these rows, which is not one rule.
    ///
    /// A page mirroring a calendar event is never purged: `purge_trashed_pages`
    /// routes every eligible row through the app's one delete, and that path
    /// keeps a mirror soft-deleted so its tombstone survives to suppress the
    /// upstream event. Destroying it would let the next sync pass re-create the
    /// page the user deleted. So the retention sentence only holds for native
    /// pages, and the second sentence appears only when a row it describes is
    /// actually on screen.
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

    /// "Deleted 3 days ago", from the UTC stamp the data layer writes.
    ///
    /// Parsed rather than shown raw because the stamp is storage format, and
    /// what the reader needs is how long they have left to change their mind.
    /// Falls back to the raw value rather than inventing a date: a malformed
    /// stamp is worth seeing, not hiding behind "just now".
    ///
    /// The parse itself lives in `PikosSupport` — `deleted_at` is a UTC instant
    /// and not the zoneless wall clock the scheduling fields use, and that
    /// distinction is worth stating once where it can be tested on the host
    /// rather than restating it in every view that shows a date.
    private static func deletedLabel(_ stamp: String) -> String {
        guard let deleted = StorageTimestamp.utc(stamp) else { return stamp }
        return String(localized: "Deleted \(deleted.formatted(.relative(presentation: .named)))")
    }
}
