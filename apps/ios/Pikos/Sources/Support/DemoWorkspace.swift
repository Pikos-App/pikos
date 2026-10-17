#if DEBUG
    import Foundation
    import PikosCore
    import PikosSupport

    /// A workspace that looks lived in, for screenshots and design review. Debug builds only,
    /// and only for a brand-new workspace launched with `PIKOS_DEMO=1`.
    ///
    /// Times are placed around the hour it is seeded, so the day under the list always has
    /// something just behind and just ahead of now.
    @MainActor
    enum DemoWorkspace {
        static var isRequested: Bool {
            ProcessInfo.processInfo.environment["PIKOS_DEMO"] == "1"
        }

        static func seed(_ store: WorkspaceStore) async {
            let work = await folder(store, "Work", "#539bf5")
            let projects = await folder(store, "Projects", "#9b8ae8")
            let personal = await folder(store, "Personal", "#57a872")
            let reading = await folder(store, "Reading", "#e09b4a")
            let finance = await folder(store, "Finance", "#e5534b")

            let now = Date()
            let hour = min(max(Calendar.current.component(.hour, from: now), 9), 19)

            await page(store, "Get 3 contractor quotes — kitchen", "Reach out to Houzz contacts by Tuesday",
                folder: projects, start: day(-3), priority: .high)
            await page(store, "Order FlexiSpot E7 frame", "Price is $379 — free shipping, arrives in 3–5 days",
                folder: projects, start: time(0, hour - 4, 0), tags: ["home", "shopping"], priority: .medium,
                content: document(
                    "FlexiSpot E7 motorized frame — white, 55-in crossbar kit.",
                    bullets: [
                        "Add to cart at flexispot.com", "Coupon: check RetailMeNot first",
                        "Delivery address: home", "Assembly: weekend after delivery",
                    ],
                    tasks: [("Measure the alcove", true), ("Order the desktop top", false)]))
            await page(store, "File Q1 estimated tax payment", "Confirmation number goes in the Finance folder",
                folder: finance, start: time(0, hour - 2, 0), end: time(0, hour - 1, 0), priority: .urgent)
            await page(store, "Design recipe data model", "Tables: recipes, ingredients, steps, tags",
                folder: projects, start: time(0, hour, 0), end: time(0, hour, 45))
            await page(store, "Call mom", nil,
                folder: personal, start: time(0, hour + 1, 30), end: time(0, hour + 2, 0))
            await page(store, "Dinner with Sam", "Lupa, 8 people — booked under Alex",
                folder: personal, start: time(0, hour + 3, 0), end: time(0, hour + 4, 30))
            await page(store, "Transfer $1,200 to HYSA", nil, folder: finance, start: day(0))

            _ = await store.createFromQuickAdd(
                "Daily standup every weekday at 9:30am", folderId: work)
            // Started three days ago and never ticked, so acting on today's asks about the days behind it.
            if let plants = await store.createPage(
                NewPage(
                    title: "Water the plants", subtitle: nil, folderId: personal, content: nil, tags: [],
                    scheduledStart: time(-3, 8, 0), scheduledEnd: nil))
            {
                try? await store.handle?.setRecurrence(
                    pageId: plants.id, rrule: "FREQ=DAILY", scheduledStart: time(-3, 8, 0),
                    scheduledEnd: nil, timezone: TimeZone.current.identifier)
            }
            await page(store, "Gym — legs day", nil,
                folder: personal, start: time(1, 7, 0), end: time(1, 8, 0))
            await page(store, "Sprint planning — sprint 14", "Bring the velocity chart and the carry-over list",
                folder: work, start: time(1, 10, 0), end: time(1, 11, 30))
            await page(store, "Implement search command palette", nil,
                folder: work, start: time(2, 10, 0), end: time(2, 12, 0))
            await page(store, "Emmy and Brian Wedding Weekend", "Hotel is the Harbour Inn, room block under Park",
                folder: personal, start: day(4), end: day(6))
            await page(store, "TLDR Tech newsletter", nil, folder: reading, start: time(2, 8, 0), end: time(2, 8, 30))

            await page(store, "Home renovation — kitchen", "Replace countertops, repaint cabinets, new backsplash",
                folder: projects)
            await page(store, "Side project: recipe manager app", "Simple local-first recipe organiser for the family",
                folder: projects)
            await page(store, "Research: standing desk setup", "Find a motorized frame under $600 that fits the alcove",
                folder: projects)
            await page(store, "Local-first software", "Kleppmann et al. — the seven ideals", folder: reading)
            await page(store, "Ideas for the garden", "Raised beds along the fence, herbs by the door", folder: nil,
                tags: ["home"])
            await page(store, "Book the car in for a service", nil, folder: nil)

            await page(store, "Standing desk mat", "Returned, too thick for the chair", folder: projects)

            let everyPage = (try? await store.handle?.listPages(query: PageQuery())) ?? []
            if let mat = everyPage.first(where: { $0.title == "Standing desk mat" }) {
                await store.setStatus(pageId: mat.id, done: true)
            }
            for title in [
                "Local-first software", "Design recipe data model", "Order FlexiSpot E7 frame",
                "Research: standing desk setup",
            ] {
                if let match = everyPage.first(where: { $0.title == title }) {
                    await store.markOpened(pageId: match.id)
                }
                try? await Task.sleep(for: .milliseconds(5))
            }

            store.notice = nil
            await store.refresh()
        }

        /// Pages to seed for a speed measurement, from `PIKOS_PERF_PAGES`, or nil for none.
        static var perfPageCount: Int? {
            ProcessInfo.processInfo.environment["PIKOS_PERF_PAGES"].flatMap(Int.init)
        }

        /// A workspace sized for measuring: `count` pages spread over five folders, the Inbox and
        /// the coming month, and one page of about ten thousand words for typing into.
        ///
        /// Written straight through the workspace, not the store: the store refreshes after each
        /// write, which would make seeding two thousand pages a minute of redrawing.
        static func seedForSpeed(_ store: WorkspaceStore, count: Int) async {
            guard let workspace = store.handle else { return }
            var folders: [String?] = [nil]
            for name in ["Work", "Projects", "Personal", "Reading", "Finance"] {
                folders.append(await store.createFolder(named: name)?.id)
            }
            for index in 0..<count {
                let start = index % 3 == 0 ? nil : day(index % 30)
                _ = try? await workspace.createPage(
                    page: NewPage(
                        title: "Page \(index + 1)", subtitle: index % 4 == 0 ? "A subtitle for page \(index + 1)" : nil,
                        folderId: folders[index % folders.count] ?? nil, content: nil,
                        tags: index % 5 == 0 ? ["tag\(index % 7)"] : [], scheduledStart: start, scheduledEnd: nil))
            }
            let sentence = "The quick brown fox jumps over the lazy dog while the editor keeps up. "
            let paragraphs = Array(repeating: sentence + sentence, count: 350)
            func paragraph(_ value: String) -> [String: Any] {
                ["type": "paragraph", "content": [["type": "text", "text": value]]]
            }
            let doc: [String: Any] = ["type": "doc", "content": paragraphs.map(paragraph)]
            let content = (try? JSONSerialization.data(withJSONObject: doc)).flatMap { String(data: $0, encoding: .utf8) }
            _ = try? await workspace.createPage(
                page: NewPage(
                    title: "Long page", subtitle: nil, folderId: nil, content: content, tags: [],
                    scheduledStart: nil, scheduledEnd: nil))
            await store.refresh()
        }

        /// Puts the app on the screen a screenshot asks for, once the workspace is open.
        static func applyScreen(route: Route, store: WorkspaceStore) async {
            let environment = ProcessInfo.processInfo.environment
            if let scope = environment["PIKOS_DEMO_SCOPE"] {
                switch scope {
                case "upcoming": store.scope = .upcoming
                case "inbox": store.scope = .inbox
                default:
                    if let folder = store.folders.first(where: { $0.name == scope }) {
                        store.scope = .folder(id: folder.id, name: folder.name)
                    }
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
            if environment["PIKOS_DEMO_PANE"] == "week" { route.pane = .week }
            if environment["PIKOS_DEMO_SWITCHER"] == "1" { route.isSwitcherPresented = true }
            if let text = environment["PIKOS_DEMO_QUICKADD"] {
                route.quickAddPrefill = text
                route.isQuickAddPresented = true
            }
            if let text = environment["PIKOS_DEMO_SEARCH"] {
                route.searchPrefill = text
                route.path = [.search]
            }
            if environment["PIKOS_DEMO_SETTINGS"] != nil { route.isSettingsPresented = true }
            if let message = environment["PIKOS_DEMO_ERROR"] { store.errorMessage = message }
            if let title = environment["PIKOS_DEMO_OPEN"], let workspace = store.handle,
                let match = try? await workspace.listPages(query: PageQuery()).first(where: { $0.title == title })
            {
                route.path = [.page(match.id)]
            }
        }

        static func applyDrag(_ drag: PageDragSession, store: WorkspaceStore) async {
            // Seeding flips the store out of loading once per folder, before any page exists.
            try? await Task.sleep(for: .seconds(2))
            guard let title = ProcessInfo.processInfo.environment["PIKOS_DEMO_DRAG"],
                let page = store.pages.first(where: { $0.title == title })
            else { return }
            let hour = Calendar.current.component(.hour, from: Date())
            drag.holdForScreenshot(PageFacts(page), minute: min(hour + 2, 23) * 60 + 30)
        }

        private static func folder(_ store: WorkspaceStore, _ name: String, _ color: String) async -> String? {
            guard let folder = await store.createFolder(named: name) else { return nil }
            await store.setFolderColor(id: folder.id, to: color)
            return folder.id
        }

        private static func page(
            _ store: WorkspaceStore, _ title: String, _ subtitle: String?, folder: String?,
            start: String? = nil, end: String? = nil, tags: [String] = [], priority: Priority? = nil,
            content: String? = nil
        ) async {
            guard
                let created = await store.createPage(
                    NewPage(
                        title: title, subtitle: subtitle, folderId: folder, content: content, tags: tags,
                        scheduledStart: start, scheduledEnd: end))
            else { return }
            if let priority { await store.setPriority(pageId: created.id, priority: priority) }
        }

        private static func document(_ lead: String, bullets: [String], tasks: [(String, Bool)]) -> String {
            func text(_ value: String) -> [String: Any] { ["type": "text", "text": value] }
            func paragraph(_ value: String) -> [String: Any] { ["type": "paragraph", "content": [text(value)]] }
            let list: [String: Any] = [
                "type": "bulletList",
                "content": bullets.map { ["type": "listItem", "content": [paragraph($0)]] },
            ]
            let checklist: [String: Any] = [
                "type": "taskList",
                "content": tasks.map {
                    ["type": "taskItem", "attrs": ["checked": $0.1], "content": [paragraph($0.0)]]
                },
            ]
            let doc: [String: Any] = ["type": "doc", "content": [paragraph(lead), list, checklist]]
            let data = (try? JSONSerialization.data(withJSONObject: doc)) ?? Data()
            return String(data: data, encoding: .utf8) ?? ""
        }

        private static func day(_ offset: Int) -> String {
            let date = Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date()
            return WallClockDay.string(from: date)
        }

        private static func time(_ dayOffset: Int, _ hour: Int, _ minute: Int) -> String {
            CalendarGeometry.wallClock(
                day: day(dayOffset), minute: min(max(0, hour * 60 + minute), 24 * 60 - 1))
        }
    }
#endif
