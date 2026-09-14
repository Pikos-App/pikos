import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// What is waiting to be filed.
///
/// The Inbox is where quick captures land, and a count of them on the home
/// screen is the gentlest reminder there is that something was written down
/// and not dealt with. The small size is the count; the medium and large
/// sizes list the pages, each with a ring that finishes it in place.
struct InboxWidget: Widget {
    static let kind = "app.pikos.widget.inbox"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: InboxProvider()) { entry in
            InboxView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Inbox")
        .description("Pages you have captured and not yet filed.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline

struct InboxEntry: TimelineEntry {
    let date: Date
    let pages: [PageSummary]
    let failure: String?

    static let placeholder = InboxEntry(date: .now, pages: [], failure: nil)
}

struct InboxProvider: TimelineProvider {
    func placeholder(in context: Context) -> InboxEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (InboxEntry) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<InboxEntry>) -> Void) {
        let done = Completion(call: completion)
        Task {
            let current = await entry()
            // Nothing here changes with the clock — only with a write, and the
            // app reloads every widget after one. The hourly refresh is a
            // backstop for a write made elsewhere.
            done.call(Timeline(entries: [current], policy: .after(WidgetClock.nextHour())))
        }
    }

    /// The same query the app's Inbox view runs: unfiled and open, in the
    /// order the user arranged them.
    private func entry() async -> InboxEntry {
        do {
            let workspace = try await WidgetWorkspace.open()
            let pages = try await workspace.listPages(query: PageQuery(folder: .inbox, openOnly: true))
            return InboxEntry(date: .now, pages: pages, failure: nil)
        } catch {
            return InboxEntry(date: .now, pages: [], failure: error.localizedDescription)
        }
    }
}

// MARK: - View

struct InboxView: View {
    @Environment(\.widgetFamily) private var family
    let entry: InboxEntry

    private var visible: [PageSummary] {
        let limit = family == .systemMedium ? 4 : 9
        return Array(entry.pages.prefix(limit))
    }

    var body: some View {
        Group {
            if family == .systemSmall {
                countOnly
            } else {
                list
            }
        }
        // The whole widget opens the Inbox; a row's title opens its page.
        .widgetURL(URL(string: "pikos://inbox"))
    }

    /// The small size: a number, and what it is a number of.
    ///
    /// A count large enough to read across a room, because that is the
    /// distance a home screen is glanced at from. Zero is said in words —
    /// a large "0" reads as an error, and "Inbox is empty" is the good news
    /// it actually is.
    private var countOnly: some View {
        VStack(alignment: .leading, spacing: 4) {
            WidgetHeader(title: "Inbox", systemImage: "tray")
            Spacer(minLength: 0)
            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if entry.pages.isEmpty {
                Text("Empty")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Nothing waiting to be filed")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("\(entry.pages.count)")
                    .font(.system(size: 40, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Brand.accent)
                Group {
                    if entry.pages.count == 1 {
                        Text("page to file")
                    } else {
                        Text("pages to file")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(title: "Inbox", systemImage: "tray", count: entry.pages.count)

            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if entry.pages.isEmpty {
                WidgetNote(text: "Nothing waiting to be filed")
            } else {
                ForEach(visible, id: \.id) { page in
                    WidgetPageRow(page: page, lineLimit: family == .systemLarge ? 2 : 1)
                }
                if entry.pages.count > visible.count {
                    Text("+\(entry.pages.count - visible.count) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
    }
}
