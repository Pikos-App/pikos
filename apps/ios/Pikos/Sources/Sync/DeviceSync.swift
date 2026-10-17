#if STAGING
    import CloudKit
    import Observation
    import PikosCore
    import PikosSync
    import UIKit
    import os

    /// iCloud sync for the staging build, which turns it on at launch. The release build has no
    /// sync until the Settings section that controls it exists.
    @MainActor @Observable
    final class DeviceSync {
        private(set) var status = "Not started"
        private(set) var zone = "No zone yet"
        private(set) var counts = ""
        private(set) var lastError = "No errors"
        /// Set from Settings: the next launch forgets what iCloud already sent and fetches it all.
        static let refetchKey = "stagingRefetchOnLaunch"
        private var batchesApplied = 0

        private let workspace: () -> Workspace?
        private let onApplied: @MainActor () async -> Void
        private var engine: CloudKitSync?
        private nonisolated static let log = Logger(subsystem: "app.pikos", category: "sync")

        init(workspace: @escaping () -> Workspace?, onApplied: @escaping @MainActor () async -> Void) {
            self.workspace = workspace
            self.onApplied = onApplied
        }

        func start() async {
            guard engine == nil, let workspace = workspace(),
                let container = Bundle.main.object(forInfoDictionaryKey: "PikosCloudKitContainer")
                    as? String
            else { return }

            do {
                let state = try await workspace.startSync()
                if UserDefaults.standard.bool(forKey: Self.refetchKey) {
                    UserDefaults.standard.removeObject(forKey: Self.refetchKey)
                    try await workspace.setEngineState(state: Data())
                }
                let store = WorkspaceReplicaStore(workspace: workspace) { [weak self] in
                    await self?.applied()
                }
                let container = CKContainer(identifier: container)
                let zone = try await CloudKitSync.join(
                    store: store, container: container, ownZone: state.zone)
                let engine = CloudKitSync(
                    store: store,
                    container: container,
                    zoneName: zone
                ) { [weak self] status in
                    Self.log.info("status: \(String(describing: status), privacy: .public)")
                    Task { @MainActor in
                        self?.status = String(describing: status)
                        if case .failed(let message) = status { self?.lastError = message }
                        await self?.refreshCounts()
                    }
                }
                self.engine = engine
                self.zone = zone
                try await engine.start()
                UIApplication.shared.registerForRemoteNotifications()
                status = "Started, zone \(zone)"
                Self.log.info("started in \(zone, privacy: .public)")
                await engine.fetchNow()
            } catch {
                status = "Failed: \(error.localizedDescription)"
                Self.log.error("start failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        func localChangesHappened() async {
            await engine?.localChangesHappened()
        }

        func fetchNow() async {
            await engine?.fetchNow()
        }

        private func applied() async {
            Self.log.info("applied records from iCloud")
            batchesApplied += 1
            await onApplied()
        }

        private func refreshCounts() async {
            guard let summary = try? await workspace()?.syncSummary() else { return }
            counts =
                "\(summary.pending) to send · \(summary.held) held · \(batchesApplied) batches in · fetched \(summary.lastFetchAt ?? "never")"
        }
    }
#endif
