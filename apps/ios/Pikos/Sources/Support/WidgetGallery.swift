#if DEBUG
    import PikosCore
    import PikosSupport
    import SwiftUI
    import WidgetKit

    /// Every widget's own view at its family's size over sample entries, for the screen tour: no test
    /// can photograph a home screen. Launched with `-PikosWidgetGallery <board>`, one of `list`, `now`,
    /// `lock`, `list-edge` and `now-edge`, and with `-PikosWidgetGalleryDark YES` for the dark theme.
    ///
    /// Sizes are the HIG's for a 6.1-inch iPhone. The lock screen is approximate: its vibrant
    /// rendering belongs to the system, so the accessories are drawn monochrome on a dark ground.
    struct WidgetGallery: View {
        static var requestedBoard: String? { UserDefaults.standard.string(forKey: "PikosWidgetGallery") }
        private static var isDark: Bool { UserDefaults.standard.bool(forKey: "PikosWidgetGalleryDark") }

        let board: String
        private let sample = GallerySample(now: .now)

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text(board).font(.caption.monospaced()).foregroundStyle(.secondary)
                switch board {
                case "now": nowBoard
                case "lock": lockBoard
                case "list-edge": listEdgeBoard
                case "now-edge": nowEdgeBoard
                default: listBoard
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 32)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(board == "lock" ? Color(white: 0.12) : Color(white: Self.isDark ? 0.2 : 0.82))
            .preferredColorScheme(Self.isDark || board == "lock" ? .dark : .light)
        }

        private var listBoard: some View {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.today, family: .systemSmall) }
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.inbox, family: .systemSmall) }
                }
                HomeTile(.systemMedium) { ListWidgetView(entry: sample.today, family: .systemMedium) }
                HomeTile(.systemLarge) { ListWidgetView(entry: sample.today, family: .systemLarge) }
            }
        }

        private var nowBoard: some View {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowFree, family: .systemSmall) }
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowBusy, family: .systemSmall) }
                }
                HomeTile(.systemMedium) { NowWidgetView(entry: sample.nowFree, family: .systemMedium) }
                HomeTile(.systemLarge) { NowWidgetView(entry: sample.nowFree, family: .systemLarge) }
            }
        }

        private var lockBoard: some View {
            VStack(alignment: .leading, spacing: 18) {
                Text("List").font(.caption).foregroundStyle(.secondary)
                LockTile(.accessoryInline) { ListWidgetView(entry: sample.today, family: .accessoryInline) }
                HStack(spacing: 12) {
                    LockTile(.accessoryCircular) { ListWidgetView(entry: sample.today, family: .accessoryCircular) }
                    LockTile(.accessoryCircular) { ListWidgetView(entry: sample.upcoming, family: .accessoryCircular) }
                    LockTile(.accessoryRectangular) {
                        ListWidgetView(entry: sample.today, family: .accessoryRectangular)
                    }
                }
                LockTile(.accessoryRectangular) { ListWidgetView(entry: sample.empty, family: .accessoryRectangular) }
                Text("Now").font(.caption).foregroundStyle(.secondary)
                LockTile(.accessoryInline) { NowWidgetView(entry: sample.nowFree, family: .accessoryInline) }
                LockTile(.accessoryInline) { NowWidgetView(entry: sample.nowBusy, family: .accessoryInline) }
                HStack(spacing: 12) {
                    LockTile(.accessoryRectangular) {
                        NowWidgetView(entry: sample.nowFree, family: .accessoryRectangular)
                    }
                    LockTile(.accessoryRectangular) {
                        NowWidgetView(entry: sample.nowBusy, family: .accessoryRectangular)
                    }
                }
            }
        }

        private var listEdgeBoard: some View {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.longTitles, family: .systemSmall) }
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.empty, family: .systemSmall) }
                }
                HomeTile(.systemMedium) { ListWidgetView(entry: sample.longTitles, family: .systemMedium) }
                HomeTile(.systemMedium) { ListWidgetView(entry: sample.upcoming, family: .systemMedium) }
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.listFailure, family: .systemSmall) }
                    HomeTile(.systemSmall) { ListWidgetView(entry: sample.longFolder, family: .systemSmall) }
                }
            }
        }

        private var nowEdgeBoard: some View {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowLong, family: .systemSmall) }
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowEmpty, family: .systemSmall) }
                }
                HomeTile(.systemMedium) { NowWidgetView(entry: sample.nowLong, family: .systemMedium) }
                HomeTile(.systemMedium) { NowWidgetView(entry: sample.nowEmpty, family: .systemMedium) }
                HStack(spacing: 22) {
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowFailure, family: .systemSmall) }
                    HomeTile(.systemSmall) { NowWidgetView(entry: sample.nowBusy, family: .systemSmall) }
                }
            }
        }
    }

    private func gallerySize(_ family: WidgetFamily) -> CGSize {
        switch family {
        case .systemSmall: CGSize(width: 158, height: 158)
        case .systemMedium: CGSize(width: 338, height: 158)
        case .systemLarge: CGSize(width: 338, height: 354)
        case .accessoryCircular: CGSize(width: 72, height: 72)
        case .accessoryRectangular: CGSize(width: 160, height: 72)
        default: CGSize(width: 234, height: 26)
        }
    }

    /// A home-screen widget: the system's 16pt content margins over the widget's container background.
    private struct HomeTile<Content: View>: View {
        let family: WidgetFamily
        @ViewBuilder let content: Content

        init(_ family: WidgetFamily, @ViewBuilder content: () -> Content) {
            self.family = family
            self.content = content()
        }

        var body: some View {
            let size = gallerySize(family)
            content
                .padding(16)
                .frame(width: size.width, height: size.height, alignment: .topLeading)
                .background(WidgetGround.style)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private struct LockTile<Content: View>: View {
        let family: WidgetFamily
        @ViewBuilder let content: Content

        init(_ family: WidgetFamily, @ViewBuilder content: () -> Content) {
            self.family = family
            self.content = content()
        }

        var body: some View {
            let size = gallerySize(family)
            content
                .environment(\.widgetRenderingMode, .vibrant)
                .saturation(0)
                .frame(width: size.width, height: size.height, alignment: family == .accessoryInline ? .center : .leading)
                .overlay {
                    RoundedRectangle(cornerRadius: family == .accessoryCircular ? size.width / 2 : 10)
                        .strokeBorder(.white.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
        }
    }

    /// Pages placed around the moment the gallery opens, so every relative time reads sensibly.
    private struct GallerySample {
        let today: ListEntry
        let inbox: ListEntry
        let upcoming: ListEntry
        let empty: ListEntry
        let longTitles: ListEntry
        let longFolder: ListEntry
        let listFailure: ListEntry
        let nowFree: NowEntry
        let nowBusy: NowEntry
        let nowLong: NowEntry
        let nowEmpty: NowEntry
        let nowFailure: NowEntry

        init(now: Date) {
            let calendar = Calendar.current
            let base = calendar.date(bySetting: .second, value: 0, of: now) ?? now
            let minute = calendar.component(.minute, from: base)
            let rounded = calendar.date(byAdding: .minute, value: -(minute % 5), to: base) ?? base
            func at(_ minutes: Int, day: Int = 0) -> String {
                let date = calendar.date(byAdding: .minute, value: minutes + day * 24 * 60, to: rounded) ?? rounded
                return WallClockDay.instant(from: date)
            }
            func day(_ offset: Int) -> String {
                WallClockDay.string(from: calendar.date(byAdding: .day, value: offset, to: now) ?? now)
            }
            let todayKey = day(0)

            let tax = Self.page("tax", "File Q1 estimated tax payment", start: at(-120), end: at(-60), priority: 1)
            let desk = Self.page("desk", "Order FlexiSpot E7 frame", start: at(-200), priority: 3)
            let model = Self.page("model", "Design recipe data model", start: at(-20), end: at(25))
            let mom = Self.page("mom", "Call mom", start: at(40), end: at(70))
            let dinner = Self.page("dinner", "Dinner with Sam", start: at(180), end: at(270))
            let transfer = Self.page("transfer", "Transfer $1,200 to HYSA", start: todayKey, priority: 2)
            let plants = Self.page("plants", "Water the plants", start: at(-90), recurring: true)
            let todayPages = [tax, desk, transfer, plants, model, mom, dinner]

            today = ListEntry(date: now, list: .today, pages: todayPages, today: todayKey, failure: nil)
            inbox = ListEntry(
                date: now, list: .inbox,
                pages: [
                    Self.page("car", "Book the car in for a service"),
                    Self.page("garden", "Ideas for the garden"),
                ], today: todayKey, failure: nil)
            upcoming = ListEntry(
                date: now, list: .upcoming,
                pages: [
                    Self.page("gym", "Gym: legs day", start: "\(day(1))T07:00:00", end: "\(day(1))T08:00:00"),
                    Self.page("sprint", "Sprint planning, sprint 14", start: "\(day(1))T10:00:00", priority: 2),
                    Self.page("palette", "Implement search command palette", start: "\(day(2))T10:00:00"),
                    Self.page("wedding", "Emmy and Brian Wedding Weekend", start: day(4), end: day(6)),
                ], today: todayKey, failure: nil)
            empty = ListEntry(
                date: now, list: ListChoice(id: "folder:reading", name: "Reading"), pages: [], today: todayKey,
                failure: nil)
            longTitles = ListEntry(
                date: now, list: .inbox,
                pages: [
                    Self.page(
                        "l1", "Get three contractor quotes for the kitchen and compare what each includes",
                        start: day(-3), priority: 1),
                    Self.page("l2", "Renew the passport before the summer trip to Lisbon and Porto", start: at(90)),
                    Self.page("l3", "Supercalifragilisticexpialidocious-word-that-never-breaks"),
                    Self.page("l4", "Ask Sam about the weekend"),
                    Self.page("l5", "One more page to overflow the list"),
                ], today: todayKey, failure: nil)
            longFolder = ListEntry(
                date: now, list: ListChoice(id: "folder:long", name: "Home renovation and garden projects"),
                pages: [Self.page("r1", "Replace countertops"), Self.page("r2", "Repaint cabinets")],
                today: todayKey, failure: nil)
            listFailure = ListEntry(
                date: now, list: .today, pages: [], today: todayKey, failure: "The workspace could not be opened.")

            let between = calendar.date(byAdding: .minute, value: 30, to: rounded) ?? now
            nowFree = Self.now(at: between, pages: todayPages)
            nowBusy = Self.now(at: now, pages: todayPages)
            let meeting = Self.page(
                "long", "Quarterly planning with the whole design and engineering group", start: at(-30),
                end: at(60))
            nowLong = Self.now(at: now, pages: [meeting, tax, mom])
            nowEmpty = Self.now(at: now, pages: [])
            nowFailure = NowEntry(
                date: now, plan: NowPlan(items: [], now: now), pages: [], failure: "The workspace could not be opened.")
        }

        private static func now(at instant: Date, pages: [PageSummary]) -> NowEntry {
            NowEntry(date: instant, plan: NowSource.plan(pages, at: instant), pages: pages, failure: nil)
        }

        private static func page(
            _ id: String, _ title: String, start: String? = nil, end: String? = nil, priority: Int64 = 0,
            recurring: Bool = false
        ) -> PageSummary {
            PageSummary(
                id: id, folderId: nil, title: title, subtitle: nil, status: "todo", priority: priority, tags: [],
                sortOrder: 0, scheduledStart: start, scheduledEnd: end, completedAt: nil, parentId: nil,
                createdAt: "", updatedAt: "", isRecurring: recurring, scheduleLocked: false)
        }
    }
#endif
