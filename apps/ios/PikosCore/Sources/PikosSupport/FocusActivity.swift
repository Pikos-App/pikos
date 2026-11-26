#if os(iOS)
    import ActivityKit
    import Foundation

    /// A focus session, as the Dynamic Island and the lock screen see it.
    ///
    /// Declared in the package both processes link: two declarations of the same
    /// attributes in two targets are two types the system cannot match. Behind
    /// `os(iOS)` because ActivityKit imports on macOS (`canImport` is true) with
    /// every type unavailable, so only the platform test excludes this.
    ///
    /// The state is only the start instant: the island's timer text counts up
    /// from it, so the app never pushes an update.
    public struct FocusActivityAttributes: ActivityAttributes {
        public struct ContentState: Codable, Hashable {
            public var startedAt: Date

            public init(startedAt: Date) {
                self.startedAt = startedAt
            }
        }

        public var pageId: String
        /// Its title when the session started; a rename mid-session is not
        /// reflected, since the widget process cannot cheaply open the database.
        public var title: String

        public init(pageId: String, title: String) {
            self.pageId = pageId
            self.title = title
        }
    }
#endif
