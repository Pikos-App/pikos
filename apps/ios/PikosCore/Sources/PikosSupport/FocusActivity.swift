#if canImport(ActivityKit)
    import ActivityKit
    import Foundation

    /// A focus session, as the Dynamic Island and the lock screen see it.
    ///
    /// Declared here, in the package both processes link, because a Live
    /// Activity is drawn by the widget extension from a value the app
    /// requested — and two declarations of the same attributes in two targets
    /// are two types the system cannot match. Behind `canImport` because the
    /// package also builds for the Mac that runs its tests, and ActivityKit
    /// does not exist there.
    ///
    /// The state is only the start instant. The island's own timer text counts
    /// up from it, kept current by the system, so the app never has to push an
    /// update to keep the number honest — the same reason the in-app clock is
    /// recomputed from the start rather than incremented.
    public struct FocusActivityAttributes: ActivityAttributes {
        public struct ContentState: Codable, Hashable {
            /// When the session began. The island counts up from here.
            public var startedAt: Date

            public init(startedAt: Date) {
                self.startedAt = startedAt
            }
        }

        /// The page being focused on, so a tap on the island opens it.
        public var pageId: String
        /// Its title at the moment the session started. A rename mid-session
        /// is not reflected — the island is a glance, not a mirror — and the
        /// title is the one thing the widget process cannot cheaply read for
        /// itself without opening the database from an extension.
        public var title: String

        public init(pageId: String, title: String) {
            self.pageId = pageId
            self.title = title
        }
    }
#endif
