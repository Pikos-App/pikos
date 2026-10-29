import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// One list of pages, chosen in the widget's settings: Today, Upcoming, the Inbox or a folder.
///
/// One widget rather than one per list, because each of the earlier ones showed a little and none
/// earned a home-screen slot on its own. Every row completes in place, and the header adds a page
/// to the list it shows, so a list can be worked from the home screen without opening the app.
///
/// It keeps the Today widget's kind, so a Today widget already on a home screen becomes this one,
/// set to Today.
///
/// Reads the workspace directly through `ReadOnlyWorkspace` rather than a snapshot the app writes:
/// a widget that waits on the app to refresh a cache is stale exactly when the app hasn't been
/// opened, which is when a widget is most useful. Its two writes are taps, not refreshes; see
/// `CompletePageIntent` for why a write from this process is safe.
struct ListWidget: Widget {
    static let kind = "app.pikos.widget.today"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: ListWidgetIntent.self, provider: ListProvider()) {
            entry in
            ListWidgetView(entry: entry)
                .containerBackground(WidgetGround.style, for: .widget)
        }
        .configurationDisplayName("List")
        .description("Today, Upcoming, your Inbox or a folder. Tick pages off without opening Pikos.")
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryInline, .accessoryCircular, .accessoryRectangular,
        ])
    }
}

// MARK: - Choosing the list

struct ListWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "List"
    static let description = IntentDescription("Choose the list the widget shows.")

    @Parameter(title: "List")
    var list: ListChoice?

    init() {}
}

/// A list the widget can show. Folder ids are prefixed so they can never collide with the views.
struct ListChoice: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "List"
    static let defaultQuery = ListChoiceQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static let today = ListChoice(id: "today", name: String(localized: "Today"))
    static let upcoming = ListChoice(id: "upcoming", name: String(localized: "Upcoming"))
    static let inbox = ListChoice(id: "inbox", name: String(localized: "Inbox"))
    private static let folderPrefix = "folder:"

    static func folder(_ folder: Folder) -> ListChoice {
        ListChoice(id: folderPrefix + folder.id, name: folder.name)
    }

    var source: WidgetList? {
        switch id {
        case Self.today.id: return .today
        case Self.upcoming.id: return .upcoming
        case Self.inbox.id: return .inbox
        default:
            guard id.hasPrefix(Self.folderPrefix) else { return nil }
            return .folder(id: String(id.dropFirst(Self.folderPrefix.count)))
        }
    }

    /// Quick add, holding the words that file a page into this list, or nil when no words can.
    /// A folder token stops at the first character outside `[0-9A-Za-z_]`, so a folder named
    /// with a space or an accent has no plus rather than one that drops pages in the Inbox.
    var addLink: URL? {
        let words: String
        switch id {
        case Self.today.id: words = String(localized: "today") + " "
        case Self.upcoming.id, Self.inbox.id: words = ""
        default:
            guard name.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" }) else { return nil }
            words = "~\(name) "
        }
        var components = URLComponents(string: "pikos://quick-add")
        if !words.isEmpty {
            components?.queryItems = [URLQueryItem(name: "text", value: words)]
        }
        return components?.url
    }

    /// Where a tap on the widget's background opens the app. Links don't name folders yet, so a
    /// folder's widget opens the app wherever it was.
    var link: URL? {
        switch id {
        case Self.today.id: return URL(string: "pikos://today")
        case Self.upcoming.id: return URL(string: "pikos://upcoming")
        case Self.inbox.id: return URL(string: "pikos://inbox")
        default: return nil
        }
    }
}

struct ListChoiceQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ListChoice] {
        await all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ListChoice] {
        await all()
    }

    func defaultResult() async -> ListChoice? {
        .today
    }

    /// The three views, then the folders. A workspace that can't be read still offers the views.
    private func all() async -> [ListChoice] {
        let folders = (try? await WidgetWorkspace.open().listFolders()) ?? []
        return [.today, .upcoming, .inbox] + folders.map(ListChoice.folder)
    }
}

// MARK: - Timeline

struct ListEntry: TimelineEntry {
    let date: Date
    let list: ListChoice
    /// Open pages only.
    let pages: [PageSummary]
    let today: String
    /// Set when the workspace could not be read. Shown rather than swallowed: an empty widget and
    /// a broken one look identical otherwise, and the usual cause is an App Group not configured.
    let failure: String?

    static let placeholder = ListEntry(
        date: .now, list: .today, pages: [], today: DayLabel.today(), failure: nil)
}

struct ListProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ListEntry {
        .placeholder
    }

    func snapshot(for configuration: ListWidgetIntent, in context: Context) async -> ListEntry {
        await entry(configuration.list ?? .today)
    }

    /// Refreshed at the next hour, when a page can become overdue; a write anywhere reloads it sooner.
    func timeline(for configuration: ListWidgetIntent, in context: Context) async -> Timeline<ListEntry> {
        Timeline(entries: [await entry(configuration.list ?? .today)], policy: .after(WidgetClock.nextHour()))
    }

    private func entry(_ list: ListChoice) async -> ListEntry {
        let today = DayLabel.today()
        do {
            let workspace = try await WidgetWorkspace.open()
            let pages = try await list.source?.openPages(in: workspace) ?? []
            return ListEntry(date: .now, list: list, pages: pages, today: today, failure: nil)
        } catch {
            return ListEntry(date: .now, list: list, pages: [], today: today, failure: error.localizedDescription)
        }
    }
}

// MARK: - Views

struct ListWidgetView: View {
    @Environment(\.widgetFamily) private var widgetFamily
    let entry: ListEntry
    /// Set only by the app's debug widget gallery, which can't set WidgetKit's environment value.
    var family: WidgetFamily? = nil

    var body: some View {
        switch family ?? widgetFamily {
        case .accessoryInline:
            InlineView(entry: entry)
        case .accessoryCircular:
            CircularView(entry: entry)
        case .accessoryRectangular:
            RectangularView(entry: entry)
        default:
            HomeScreenView(entry: entry, family: family ?? widgetFamily)
        }
    }
}

// MARK: Home screen

private struct HomeScreenView: View {
    let entry: ListEntry
    let family: WidgetFamily

    /// Trimmed to what fits, since a widget can't scroll. One line a row, so the small size fits
    /// as many as the medium; the count in the header says how many more there are.
    private var visible: [PageSummary] {
        let limit: Int
        switch family {
        case .systemSmall, .systemMedium: limit = 4
        default: limit = 10
        }
        return Array(entry.pages.prefix(limit))
    }

    /// "Today" beside a page with no time says nothing in the Today list.
    private func detail(_ page: PageSummary) -> String? {
        let isTodayList = entry.list.id == ListChoice.today.id
        if family == .systemSmall || (isTodayList && timeOfDay(page) == nil) { return nil }
        return dueLabel(page, today: entry.today)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(entry.list.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if !entry.pages.isEmpty {
                    Text("\(entry.pages.count)")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(WidgetInk.secondary)
                }
                Spacer(minLength: 4)
                if let add = entry.list.addLink {
                    Link(destination: add) {
                        Image(systemName: "plus.circle.fill")
                            .font(.body)
                            .foregroundStyle(Brand.accent)
                    }
                    .accessibilityLabel("New page in \(entry.list.name)")
                }
            }

            if entry.failure != nil {
                WidgetNote(text: "Can't read your pages")
            } else if entry.pages.isEmpty {
                WidgetNote(text: "Nothing open")
            } else {
                ForEach(visible, id: \.id) { page in
                    WidgetPageRow(
                        page: page,
                        linksToPage: family != .systemSmall,
                        detail: detail(page),
                        size: .list)
                }
                if family == .systemLarge, entry.pages.count > visible.count {
                    Text("+\(entry.pages.count - visible.count) more")
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                }
            }

            Spacer(minLength: 0)
        }
        .widgetURL(entry.list.link)
    }
}

// MARK: Lock screen

/// One line beside the clock: what is next, or how much is left.
private struct InlineView: View {
    let entry: ListEntry

    var body: some View {
        if let next = entry.pages.first {
            if let time = timeOfDay(next) {
                Text("\(displayTitle(next)) · \(ClockTime.string(time))")
            } else {
                Text(displayTitle(next))
            }
        } else {
            Text("Nothing open in \(entry.list.name)")
        }
    }
}

/// How many pages are open in the list.
private struct CircularView: View {
    let entry: ListEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Text("\(entry.pages.count)")
                    .font(.title2.weight(.semibold).monospacedDigit())
                Text(entry.list.name)
                    .font(.caption2)
                    .textCase(.uppercase)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .widgetURL(entry.list.link)
        .accessibilityLabel("\(entry.pages.count) pages open in \(entry.list.name)")
    }
}

/// The next two things, with their times. Two, because the heading takes the third line and the
/// lock screen needs it: a bare title beside the clock doesn't say whose it is.
private struct RectangularView: View {
    let entry: ListEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(entry.list.name)
                if !entry.pages.isEmpty {
                    Text("\(entry.pages.count)")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption.weight(.semibold))

            if entry.failure != nil {
                Text("Can't read your pages").font(.caption2).foregroundStyle(.secondary)
            } else if entry.pages.isEmpty {
                Text("Nothing open").font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(entry.pages.prefix(2), id: \.id) { page in
                    HStack(spacing: 4) {
                        if let time = timeOfDay(page) {
                            Text(ClockTime.string(time))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        Text(displayTitle(page))
                            .font(.caption2)
                            .lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(entry.list.link)
    }
}
