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
    private var lastFailure: SyncStatusLine.Failure?
    private var batchesApplied = 0
    private let workspace: () -> Workspace?
    private let onApplied: @MainActor () async -> Void
    private var starter: SyncStarter<CloudKitSync>?
    private nonisolated static let log = Logger(subsystem: "app.pikos", category: "sync")

    init(workspace: @escaping () -> Workspace?, onApplied: @escaping @MainActor () async -> Void) {
        self.workspace = workspace
        self.onApplied = onApplied
    }

    /// At launch: syncs again if it was on when the app last ran.
    func resume() async {
        guard Self.isAvailable, let workspace = workspace() else { return }

        let state: SyncState
        do {
            state = try await workspace.syncState()
        } catch {
            // Otherwise a phone that synced would quietly stop at launch.
            fail("this device couldn't read whether sync was on", error)
            return
        }
        guard state.started && !state.paused else { return }

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
            fail("turning sync on failed", error)
            return
        }
        await connect(workspace)
    }

    /// Pausing keeps recording changes, so turning sync back on sends what was made meanwhile.
    func turnOff() async {
        await starter?.stop()
        starter = nil
        isOn = false
        do {
            try await workspace()?.setSyncPaused(paused: true)
        } catch {
            fail("turning sync off wasn't saved, so it may come back on at the next launch", error)
            return
        }
        show(nil)
    }

    /// What the status line offers: joining another account, or uploading again, both start this
    /// device over as a new one, which merges its pages into whatever iCloud holds.
    func perform(_ action: SyncAction) async {
        guard action != .none, let workspace = workspace() else { return }

        await starter?.stop()
        starter = nil
        do {
            try await workspace.forgetSync()
        } catch {
            fail("starting this device over failed", error)
            return
        }
        await turnOn()
    }

    /// A workspace call sync depends on failed: logged by its kind and shown on the status line,
    /// after "Couldn't sync:", with the workspace's own message.
    private func fail(_ what: String, _ error: Error) {
        let message = FailureText.message(error)
        Self.log.error("\(what, privacy: .public): \(FailureText.kind(error), privacy: .public): \(message, privacy: .public)")
        show(.failed("\(what). \(message)"))
    }

    /// Asks iOS for time to finish the send, so an edit made just before the app is put away still
    /// leaves the phone; past that time the send stays queued for the next launch.
    func localChangesHappened() async {
        guard let starter else { return }

        // Both closures run on the main actor, so the shared identifier never races.
        nonisolated(unsafe) var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "iCloud send") {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        await starter.localChangesHappened()
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }

    func fetchNow() async {
        await starter?.fetchNow()
    }

    func report() async -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let state = [
            "Pikos \(version ?? "unknown") on iOS \(UIDevice.current.systemVersion)",
            "Sync \(isOn ? "on" : "off") in \(zone)",
            line.text,
            counts,
        ]
        let log = await Task.detached { SyncReport.readLog() }.value

        return SyncReport.text(state: state, log: log)
    }

    /// On from here even when this start can't reach iCloud, since the starter keeps trying.
    private func connect(_ workspace: Workspace) async {
        guard starter == nil, let container = Self.container else { return }

        isOn = true
        let starter = SyncStarter<CloudKitSync> { [weak self] in
            try await self?.start(workspace, container: container)
        } failed: { [weak self] error in
            let error = WorkspaceReplicaStore.readable(error, op: "start")
            Self.log.error("\(SyncFailure.logLine("start", error), privacy: .public)")
            await self?.show(SyncFailure.status(for: error))
        }
        self.starter = starter
        await starter.fetchNow()
    }

    private func start(_ workspace: Workspace, container: String) async throws -> CloudKitSync? {
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
            show(held)
            return nil
        }

        let cloud = CKContainer(identifier: container)
        let zone = try await CloudKitSync.join(store: store, container: cloud, ownZone: state.zone)
        let engine = CloudKitSync(store: store, container: cloud, zoneName: zone) {
            [weak self] status in
            Self.log.info("status: \(String(describing: status), privacy: .public)")
            Task { @MainActor in self?.show(status) }
        }
        self.zone = zone
        try await engine.start()
        UIApplication.shared.registerForRemoteNotifications()
        Self.log.info("started in \(zone, privacy: .public)")
        show(.syncing)
        return engine
    }

    private func show(_ status: SyncStatus?) {
        self.status = status
        if case .failed(let message) = status {
            lastError = message
            lastFailure = .init(message: message, at: Date())
        }
        Task { await refreshLine() }
    }

    private func refreshLine() async {
        var summary: SyncSummary?
        do {
            summary = try await workspace()?.syncSummary()
        } catch {
            Self.log.error(
                "reading what waits to send failed: \(FailureText.kind(error), privacy: .public): \(FailureText.message(error), privacy: .public)"
            )
            counts = "Couldn't read what waits to send: \(FailureText.message(error))"
        }
        let queue = summary.map {
            SyncStatusLine.Queue(
                toSend: Int($0.pending),
                needsUpdate: $0.needsUpdate,
                lastFetch: $0.lastFetchAt.flatMap(Self.parse),
                lastSent: $0.lastSentAt.flatMap(Self.parse),
                lastReceived: $0.lastReceivedAt.flatMap(Self.parse),
                lastFailure: lastFailure)
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
