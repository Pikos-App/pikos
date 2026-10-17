#if os(macOS)
    import AppKit
    import CloudKit
    import PikosSync
    import os

    /// Started and stopped by the Mac app's Rust as Settings turns sync on and off. Sends what
    /// changed every few seconds, since the app's writes don't notify the transport, and fetches on
    /// focus and on a timer as well as on push. Each status it reports becomes the line Settings
    /// shows.
    @available(macOS 14.0, *)
    final class MacSync: @unchecked Sendable {
        static let shared = MacSync()
        private static let log = Logger(subsystem: "app.pikos", category: "sync")
        private static let sendEvery: Duration = .seconds(5)
        private static let fetchEvery: Duration = .seconds(120)

        private let store = RustReplicaStore()
        private var engine: CloudKitSync?
        private var timers: [Task<Void, Never>] = []
        private var focusObserver: NSObjectProtocol?

        /// Starts and stops run in the order Rust called them, so turning sync off and straight back
        /// on can't end with it off.
        private let order = NSLock()
        private var tail: Task<Void, Never>?

        func enqueue(_ step: @escaping @Sendable (MacSync) async -> Void) {
            order.lock()
            defer { order.unlock() }
            let previous = tail
            tail = Task {
                await previous?.value
                await step(self)
            }
        }

        func start(container: String, zone: String) async {
            guard engine == nil else { return }
            let container = CKContainer(identifier: container)
            let joined: String
            let engine: CloudKitSync
            do {
                joined = try await CloudKitSync.join(store: store, container: container, ownZone: zone)
                engine = CloudKitSync(store: store, container: container, zoneName: joined) {
                    [weak self] status in
                    Self.log.info("status: \(String(describing: status), privacy: .public)")
                    Task { await self?.report(status) }
                }
                self.engine = engine
                try await engine.start()
            } catch {
                Self.log.error("start failed: \(error.localizedDescription, privacy: .public)")
                await report(.failed(error.localizedDescription))
                return
            }
            Self.log.info("started in \(joined, privacy: .public)")
            await MainActor.run {
                NSApplication.shared.registerForRemoteNotifications()
                focusObserver = NotificationCenter.default.addObserver(
                    forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
                ) { _ in
                    Task { await engine.fetchNow() }
                }
            }
            await engine.fetchNow()

            timers = [
                Task.detached {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: Self.sendEvery)
                        await engine.localChangesHappened()
                    }
                },
                Task.detached {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: Self.fetchEvery)
                        await engine.fetchNow()
                    }
                },
            ]
        }

        func stop() async {
            timers.forEach { $0.cancel() }
            timers = []
            if let focusObserver {
                await MainActor.run { NotificationCenter.default.removeObserver(focusObserver) }
            }
            focusObserver = nil
            await engine?.stop()
            engine = nil
        }

        private func report(_ status: SyncStatus) async {
            guard engine != nil else { return }

            let summary = try? await store.summary()
            let line = SyncStatusLine(
                status: status,
                queue: .init(
                    toSend: summary?.pending ?? 0,
                    needsUpdate: summary?.needsUpdate ?? false,
                    lastFetch: summary?.lastFetch))
            try? await store.report(line)
        }
    }

    @_cdecl("pikos_sync_start")
    public func pikosSyncStart(_ container: UnsafePointer<CChar>, _ zone: UnsafePointer<CChar>) {
        let container = String(cString: container)
        let zone = String(cString: zone)
        guard #available(macOS 14.0, *) else { return }
        MacSync.shared.enqueue { await $0.start(container: container, zone: zone) }
    }

    @_cdecl("pikos_sync_stop")
    public func pikosSyncStop() {
        guard #available(macOS 14.0, *) else { return }
        MacSync.shared.enqueue { await $0.stop() }
    }
#endif
