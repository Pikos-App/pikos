import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// A way in, from the home screen.
///
/// The app's pitch on a phone is that a thought becomes a page in one
/// sentence, and the shortest path to the sentence is a button that is
/// already on the screen. The small size is that button. The medium adds
/// the three places a person goes next, so one widget can be the whole way
/// into the app for someone who keeps it off the dock.
///
/// Every tile is a `pikos://` link — the same grammar notifications, Siri
/// and the desktop use. Nothing here reads the workspace: it is a launcher,
/// and a launcher that had to open the database to draw four icons would be
/// paying for something it does not show.
struct CaptureWidget: Widget {
    static let kind = "app.pikos.widget.capture"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: CaptureProvider()) { _ in
            CaptureView()
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("New Page")
        .description("Start a page in one tap, and jump to Today, Inbox or the calendar.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Timeline

/// Nothing to fetch, so one entry that never needs replacing.
struct CaptureEntry: TimelineEntry {
    let date: Date
}

struct CaptureProvider: TimelineProvider {
    func placeholder(in context: Context) -> CaptureEntry {
        CaptureEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (CaptureEntry) -> Void) {
        completion(CaptureEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CaptureEntry>) -> Void) {
        completion(Timeline(entries: [CaptureEntry(date: .now)], policy: .never))
    }
}

// MARK: - View

struct CaptureView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if family == .systemSmall {
                newPage
            } else {
                HStack(spacing: 8) {
                    newPage
                    Divider()
                    VStack(spacing: 8) {
                        destination("Today", systemImage: "sun.max", url: "pikos://today")
                        destination("Inbox", systemImage: "tray", url: "pikos://inbox")
                        destination("Calendar", systemImage: "calendar", url: "pikos://calendar")
                    }
                }
            }
        }
        .widgetURL(URL(string: "pikos://quick-add"))
    }

    /// The button. Filled in the brand accent because it is the one thing on
    /// the widget that does something new rather than showing somewhere the
    /// app already is.
    private var newPage: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().fill(Brand.accent)
                Image(systemName: "plus")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 56, height: 56)
            Text("New page")
                .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private func destination(_ title: LocalizedStringKey, systemImage: String, url: String)
        -> some View
    {
        Group {
            if let link = URL(string: url) {
                Link(destination: link) { destinationLabel(title, systemImage: systemImage) }
            } else {
                destinationLabel(title, systemImage: systemImage)
            }
        }
    }

    private func destinationLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.fill.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
