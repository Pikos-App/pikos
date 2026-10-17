#if os(macOS)
    import AppKit
    import CloudKit
    import PikosSync
    import os

    /// Started by the Mac app's Rust once the workspace is open. Sends what changed every few
    /// seconds, since the app's writes don't notify the transport, and fetches on focus and on a
    /// timer as well as on push.
    @available(macOS 14.0, *)
    final class MacSync: @unchecked Sendable {
        static let shared = MacSync()
        private static let log = Logger(subsystem: "app.pikos", category: "sync")
        private static let sendEvery: Duration = .seconds(5)
        private static let fetchEvery: Duration = .seconds(120)

        private var engine: CloudKitSync?

        func start(container: String, zone: String) async {
            guard engine == nil else { return }
            let store = RustReplicaStore()
            let container = CKContainer(identifier: container)
            let joined: String
            let engine: CloudKitSync
            do {
                joined = try await CloudKitSync.join(store: store, container: container, ownZone: zone)
                engine = CloudKitSync(store: store, container: container, zoneName: joined) { status in
                    Self.log.info("status: \(String(describing: status), privacy: .public)")
                }
                self.engine = engine
                try await engine.start()
            } catch {
                Self.log.error("start failed: \(error.localizedDescription, privacy: .public)")
                return
            }
            Self.log.info("started in \(joined, privacy: .public)")
            await MainActor.run {
                NSApplication.shared.registerForRemoteNotifications()
                NotificationCenter.default.addObserver(
                    forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
                ) { _ in
                    Task { await engine.fetchNow() }
                }
            }
            await engine.fetchNow()

            Task.detached {
                while true {
                    try? await Task.sleep(for: Self.sendEvery)
                    await engine.localChangesHappened()
                }
            }
            Task.detached {
                while true {
                    try? await Task.sleep(for: Self.fetchEvery)
                    await engine.fetchNow()
                }
            }
        }
    }

    @_cdecl("pikos_sync_start")
    public func pikosSyncStart(_ container: UnsafePointer<CChar>, _ zone: UnsafePointer<CChar>) {
        let container = String(cString: container)
        let zone = String(cString: zone)
        guard #available(macOS 14.0, *) else { return }
        Task { await MacSync.shared.start(container: container, zone: zone) }
    }
#endif
