import CloudKit
import Observation
import PikosCore
import PikosSupport
import PikosSync
import UIKit
import os

/// iCloud sync on this device: whether it's on, what it's doing, and what Settings offers about it.
/// Whether it's on lives in the workspace, so it survives a relaunch. A build syncs only when its
/// Info.plist names a container, as the staging and release builds do.
@MainActor @Observable
final class DeviceSync {
    static let container: String? = {
        let name = Bundle.main.object(forInfoDictionaryKey: "PikosCloudKitContainer") as? String
        return name.flatMap { $0.isEmpty ? nil : $0 }
    }()

    static var isAvailable: Bool { container != nil }

    private(set) var isOn = false
    private(set) var line = SyncStatusLine(status: nil, queue: DeviceSync.nothingQueued)
    private(set) var zone = "No zone yet"
    private(set) var counts = ""
    private(set) var lastError = "No errors"
    /// Set from the staging build's Settings: the next launch forgets what iCloud already sent and
    /// fetches it all.
    static let refetchKey = "stagingRefetchOnLaunch"

    private static let nothingQueued = SyncStatusLine.Queue(toSend: 0, needsUpdate: false, lastFetch: nil)
    private var status: SyncStatus?
    private var batchesApplied = 0
    private let workspace: () -> Workspace?
    private let onApplied: @MainActor () async -> Void
    private var engine: CloudKitSync?
    private nonisolated static let log = Logger(subsystem: "app.pikos", category: "sync")

    init(workspace: @escaping () -> Workspace?, onApplied: @escaping @MainActor () async -> Void) {
        self.workspace = workspace
        self.onApplied = onApplied
    }

    /// At launch: syncs again if it was on when the app last ran.
    func resume() async {
        guard Self.isAvailable, let workspace = workspace(),
            let state = try? await workspace.syncState(),
            state.started && !state.paused
        else { return }

        await connect(workspace)
    }

    func turnOn() async {
        guard Self.isAvailable, let workspace = workspace() else { return }

        do {
            let state = try await workspace.startSync()
            if state.paused {
                try await workspace.setSyncPaused(paused: false)
            }
        } catch {
            show(.failed(error.localizedDescription))
            return
        }
        await connect(workspace)
    }

    /// Pausing keeps recording changes, so turning sync back on sends what was made meanwhile.
    func turnOff() async {
        await engine?.stop()
        engine = nil
        try? await workspace()?.setSyncPaused(paused: true)
        isOn = false
        show(nil)
    }

    /// What the status line offers: joining another account, or uploading again, both start this
    /// device over as a new one, which merges its pages into whatever iCloud holds.
    func perform(_ action: SyncAction) async {
        guard action != .none, let workspace = workspace() else { return }

        await engine?.stop()
        engine = nil
        try? await workspace.forgetSync()
        await turnOn()
    }

    func localChangesHappened() async {
        await engine?.localChangesHappened()
    }

    func fetchNow() async {
        await engine?.fetchNow()
    }

    private func connect(_ workspace: Workspace) async {
        guard engine == nil, let container = Self.container else { return }

        do {
            let state = try await workspace.startSync()
            try await workspace.setSyncAssetsDir(path: WorkspaceLocation.assetsURL().path)
            #if STAGING
                if UserDefaults.standard.bool(forKey: Self.refetchKey) {
                    UserDefaults.standard.removeObject(forKey: Self.refetchKey)
                    try await workspace.setEngineState(state: Data())
                }
            #endif
            let store = WorkspaceReplicaStore(workspace: workspace) { [weak self] in
                await self?.applied()
            }
            if let held = try await CloudKitSync.held(store: store) {
                isOn = true
                show(held)
                return
            }

            let cloud = CKContainer(identifier: container)
            let zone = try await CloudKitSync.join(store: store, container: cloud, ownZone: state.zone)
            let engine = CloudKitSync(store: store, container: cloud, zoneName: zone) {
                [weak self] status in
                Self.log.info("status: \(String(describing: status), privacy: .public)")
                Task { @MainActor in self?.show(status) }
            }
            self.engine = engine
            self.zone = zone
            isOn = true
            try await engine.start()
            UIApplication.shared.registerForRemoteNotifications()
            Self.log.info("started in \(zone, privacy: .public)")
            show(.syncing)
            await engine.fetchNow()
        } catch {
            Self.log.error("start failed: \(error.localizedDescription, privacy: .public)")
            show(.failed(error.localizedDescription))
        }
    }

    private func show(_ status: SyncStatus?) {
        self.status = status
        if case .failed(let message) = status { lastError = message }
        Task { await refreshLine() }
    }

    private func refreshLine() async {
        let summary = try? await workspace()?.syncSummary()
        let queue = summary.map {
            SyncStatusLine.Queue(
                toSend: Int($0.pending),
                needsUpdate: $0.needsUpdate,
                lastFetch: $0.lastFetchAt.flatMap(Self.parse))
        }
        line = SyncStatusLine(status: status, queue: queue ?? Self.nothingQueued)
        if let summary {
            counts =
                "\(summary.pending) to send · \(summary.held) held · \(batchesApplied) batches in · fetched \(summary.lastFetchAt ?? "never")"
        }
    }

    private static func parse(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: iso)
    }

    private func applied() async {
        Self.log.info("applied records from iCloud")
        batchesApplied += 1
        await onApplied()
    }
}
