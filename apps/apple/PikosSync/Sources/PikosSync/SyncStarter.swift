/// What an app holds while sync is on: the running transport, once it has started.
public protocol StartedSync: AnyObject, Sendable {
    func fetchNow() async
    func localChangesHappened() async
    func stop() async
}

@available(iOS 17.0, macOS 14.0, *)
extension CloudKitSync: StartedSync {}

/// Sync on a device whose person turned it on, from then until it's turned off. A start that
/// throws, as when a device that has never synced can't reach iCloud, leaves sync on: the failure
/// goes on the status line and the next fetch tries the start again, so the network coming back is
/// all it takes. Turning the switch back off instead would leave the person to turn it on again
/// after an ending that is normal.
public actor SyncStarter<Engine: StartedSync> {
    /// Joins and starts the transport, or returns nil when sync waits on the person.
    public typealias Attempt = @Sendable () async throws -> Engine?

    private let attempt: Attempt
    private let failed: @Sendable (Error) async -> Void
    private var engine: Engine?
    private var isAttempting = false
    private var isStopped = false

    public init(attempt: @escaping Attempt, failed: @escaping @Sendable (Error) async -> Void) {
        self.attempt = attempt
        self.failed = failed
    }

    /// Fetches, first starting sync if it isn't running yet. An app calls it when sync is turned
    /// on and wherever it would fetch.
    public func fetchNow() async {
        if let engine {
            await engine.fetchNow()
            return
        }

        guard !isAttempting, !isStopped else { return }

        isAttempting = true
        defer { isAttempting = false }
        do {
            guard let started = try await attempt() else { return }

            guard !isStopped else {
                await started.stop()
                return
            }

            engine = started
            await started.fetchNow()
        } catch {
            guard !isStopped else { return }

            await failed(error)
        }
    }

    public func localChangesHappened() async {
        await engine?.localChangesHappened()
    }

    /// Final: an attempt still running stops what it starts.
    public func stop() async {
        isStopped = true
        await engine?.stop()
        engine = nil
    }
}
