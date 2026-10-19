import CloudKit
import XCTest

@testable import PikosSync

private actor FakeEngine: StartedSync {
    private(set) var fetches = 0
    private(set) var isStopped = false

    func fetchNow() async { fetches += 1 }
    func localChangesHappened() async {}
    func stop() async { isStopped = true }
}

/// iCloud as the starter's attempt sees it: unreachable until told otherwise, and able to hold an
/// attempt open until released.
private actor FakeCloud {
    var isReachable = false
    private(set) var attempts = 0
    private(set) var failures: [String] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var holdsNext = false

    func comeOnline() { isReachable = true }

    func holdNextAttempt() { holdsNext = true }

    func release() {
        gate?.resume()
        gate = nil
    }

    var isHolding: Bool { gate != nil }

    func attempt(_ engine: FakeEngine) async throws -> FakeEngine {
        attempts += 1
        if holdsNext {
            holdsNext = false
            await withCheckedContinuation { gate = $0 }
        }
        guard isReachable else { throw CKError(.networkUnavailable) }

        return engine
    }

    func failed(_ error: Error) { failures.append(error.localizedDescription) }
}

final class SyncStarterTests: XCTestCase {
    private func starter(_ cloud: FakeCloud, _ engine: FakeEngine) -> SyncStarter<FakeEngine> {
        SyncStarter { try await cloud.attempt(engine) } failed: { await cloud.failed($0) }
    }

    func testAFirstStartWithICloudUnreachableSaysSoAndStartsAtTheNextFetchOnceReachable() async {
        let cloud = FakeCloud()
        let engine = FakeEngine()
        let sync = starter(cloud, engine)

        await sync.fetchNow()
        let failuresOffline = await cloud.failures.count
        XCTAssertEqual(failuresOffline, 1)

        await cloud.comeOnline()
        await sync.fetchNow()
        let fetches = await engine.fetches
        XCTAssertEqual(fetches, 1)

        await sync.fetchNow()
        let attempts = await cloud.attempts
        XCTAssertEqual(attempts, 2)
    }

    func testTurningSyncOffWhileAStartIsUnderwayStopsWhatItStarts() async {
        let cloud = FakeCloud()
        let engine = FakeEngine()
        await cloud.comeOnline()
        await cloud.holdNextAttempt()
        let sync = starter(cloud, engine)

        let starting = Task { await sync.fetchNow() }
        while !(await cloud.isHolding) { await Task.yield() }
        await sync.stop()
        await cloud.release()
        await starting.value

        let isStopped = await engine.isStopped
        let fetches = await engine.fetches
        XCTAssertTrue(isStopped)
        XCTAssertEqual(fetches, 0)
    }

    func testAFetchWhileAStartIsUnderwayDoesNotStartASecond() async {
        let cloud = FakeCloud()
        let engine = FakeEngine()
        await cloud.comeOnline()
        await cloud.holdNextAttempt()
        let sync = starter(cloud, engine)

        let starting = Task { await sync.fetchNow() }
        while !(await cloud.isHolding) { await Task.yield() }
        await sync.fetchNow()
        await cloud.release()
        await starting.value

        let attempts = await cloud.attempts
        XCTAssertEqual(attempts, 1)
    }
}
