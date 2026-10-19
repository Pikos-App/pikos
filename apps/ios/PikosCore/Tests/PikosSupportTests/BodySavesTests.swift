import PikosCore
import PikosSupport
import XCTest

@MainActor
final class BodySavesTests: XCTestCase {
    private var saved: [(content: String, clock: String?)] = []
    private var movedTo: [(base: String, stored: String)] = []

    private func saves(answering answers: [BodySave?]) -> BodySaves {
        var answers = answers
        return BodySaves(
            stored: "loaded", clock: "c1",
            save: { [unowned self] content, clock in
                saved.append((content, clock))
                return answers.removeFirst()
            },
            moved: { [unowned self] base, stored in movedTo.append((base, stored)) })
    }

    func testEachSaveIsCheckedAgainstTheClockTheLastOneStoredAt() async {
        let saves = saves(answering: [.saved(clock: "c2"), .saved(clock: "c3")])

        await saves.save("one")
        await saves.save("two")

        XCTAssertEqual(saved.map(\.clock), ["c1", "c2"])
        XCTAssertTrue(movedTo.isEmpty)
    }

    func testARefusedSaveHandsTheEditorBothBodiesAndTheNextSaveTakesTheNewClock() async {
        let saves = saves(answering: [
            .saved(clock: "c2"), .moved(content: "from the phone", clock: "c9"), .saved(clock: "c10"),
        ])

        await saves.save("one")
        await saves.save("two")
        await saves.save("merged")

        XCTAssertEqual(movedTo.map(\.base), ["one"])
        XCTAssertEqual(movedTo.map(\.stored), ["from the phone"])
        XCTAssertEqual(saved.map(\.clock), ["c1", "c2", "c9"])
    }

    func testADocumentTypedOverTheStaleBodyIsNotSavedOverTheNewOne() async {
        var release: CheckedContinuation<Void, Never>?
        let saves = BodySaves(
            stored: "loaded", clock: "c1",
            save: { [unowned self] content, clock in
                saved.append((content, clock))
                guard saved.count == 1 else { return .saved(clock: "c10") }
                await withCheckedContinuation { release = $0 }
                return .moved(content: "from the phone", clock: "c9")
            },
            moved: { [unowned self] base, stored in movedTo.append((base, stored)) })

        async let first: Void = saves.save("one")
        while release == nil { await Task.yield() }
        await saves.save("one, then more")
        release?.resume()
        await first

        XCTAssertEqual(saved.map(\.content), ["one"])
        XCTAssertEqual(movedTo.map(\.stored), ["from the phone"])
    }
}
