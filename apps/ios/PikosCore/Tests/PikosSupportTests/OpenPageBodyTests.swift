import Foundation
import PikosCore
import PikosSupport
import XCTest

@MainActor
final class OpenPageBodyTests: XCTestCase {
    private var writer: FakeWriter!
    private var editor: FakeEditor!

    override func setUp() async throws {
        writer = FakeWriter(stored: "A")
        editor = FakeEditor()
    }

    private func openBody(loaded: String = "A") -> OpenPageBody {
        OpenPageBody(
            loaded: loaded,
            save: { [writer] typed, base in await writer!.save(typed, over: base) },
            read: { [writer] in await writer!.read() },
            offer: { [editor] body, changesSeen in editor!.offer(body, changesSeen) })
    }

    func testTheFirstSaveIsTypedOverTheLoadedBodyAndTheNextOverTheOneSaved() async {
        let body = openBody()

        body.typed("A1")
        await body.settled()
        body.typed("A2")
        await body.settled()

        XCTAssertEqual(writer.saves, [.init("A1", over: "A"), .init("A2", over: "A1")])
        XCTAssertEqual(editor.offers, [])
    }

    func testAMergeIsOfferedWhenNothingWasTypedSince() async {
        let body = openBody()
        writer.stored = "B"

        body.typed("A1")
        await body.settled()

        XCTAssertEqual(editor.offers, [.init("merge(A|B|A1)", changesSeen: 1)])
    }

    func testAMergeIsNotOfferedOverTypingThatCameAfterIt() async {
        let body = openBody()
        writer.stored = "B"
        writer.holdsSaves = true

        body.typed("A1")
        await writer.untilASaveIsHeld()
        body.typed("A2")
        writer.release()
        await body.settled()

        XCTAssertEqual(writer.saves, [.init("A1", over: "A"), .init("A2", over: "A1")])
        XCTAssertEqual(editor.offers, [.init("merge(A1|merge(A|B|A1)|A2)", changesSeen: 2)])
    }

    func testTypingWhileASaveIsOutIsSavedAfterItInOneSave() async {
        let body = openBody()
        writer.holdsSaves = true

        body.typed("A1")
        await writer.untilASaveIsHeld()
        body.typed("A2")
        body.typed("A3")
        writer.release()
        await body.settled()

        XCTAssertEqual(writer.saves, [.init("A1", over: "A"), .init("A3", over: "A1")])
    }

    func testAMergeTheEditorShowedIsWhatTheNextTypingWasTypedOver() async {
        let body = openBody()
        writer.stored = "B"
        body.typed("A1")
        await body.settled()

        body.answered(applied: true)
        body.typed("M1")
        await body.settled()

        XCTAssertEqual(writer.saves.last, .init("M1", over: "merge(A|B|A1)"))
    }

    func testAMergeTheEditorRefusedLeavesTheTypingOverWhatWasTyped() async {
        let body = openBody()
        writer.stored = "B"
        body.typed("A1")
        await body.settled()

        body.answered(applied: false)
        body.typed("A2")
        await body.settled()

        XCTAssertEqual(writer.saves.last, .init("A2", over: "A1"))
    }

    func testAnswersPairWithTheBodiesTheEditorTookInOrder() async {
        let body = openBody()
        editor.isListening = false
        writer.stored = "B"
        body.storedMayHaveChanged()
        await body.settled()

        editor.isListening = true
        writer.stored = "C"
        body.storedMayHaveChanged()
        await body.settled()
        body.answered(applied: true)
        body.typed("C1")
        await body.settled()

        XCTAssertEqual(writer.saves, [.init("C1", over: "C")])
    }

    func testAFailedSaveLeavesTheNextOneOverTheBodyStillStored() async {
        let body = openBody()
        writer.failsNextSave = true

        body.typed("A1")
        await body.settled()
        body.typed("A2")
        await body.settled()

        XCTAssertEqual(writer.saves.last, .init("A2", over: "A"))
        XCTAssertEqual(writer.stored, "A2")
    }

    func testAnEditorWithNothingToSaveIsOfferedABodyChangedElsewhere() async {
        let body = openBody()
        writer.stored = "B"

        body.storedMayHaveChanged()
        await body.settled()

        XCTAssertEqual(editor.offers, [.init("B", changesSeen: 0)])
    }

    func testABodyThatDidNotChangeIsNotOffered() async {
        let body = openBody()
        body.storedMayHaveChanged()
        await body.settled()

        body.typed("A1")
        await body.settled()
        body.storedMayHaveChanged()
        await body.settled()

        XCTAssertEqual(editor.offers, [])
    }

    func testAChangeThatLandedWhileASaveWasOutIsCheckedOnceTheSaveIsBack() async {
        let body = openBody()
        writer.holdsSaves = true

        body.typed("A1")
        await writer.untilASaveIsHeld()
        writer.stored = "C"
        body.storedMayHaveChanged()
        writer.release()
        await body.settled()

        XCTAssertEqual(editor.offers, [.init("C", changesSeen: 1)])
    }

    func testABodyReadWhileTypingArrivedIsNotOffered() async {
        let body = openBody()
        writer.stored = "B"
        writer.holdsReads = true

        body.storedMayHaveChanged()
        await writer.untilAReadIsHeld()
        body.typed("A1")
        writer.release()
        await body.settled()

        XCTAssertEqual(editor.offers, [.init("merge(A|B|A1)", changesSeen: 1)])
    }

    // qa: CLOUD-135
    /// The phone's editor types one line of a note whose other line the Mac changed and synced
    /// since the phone opened it, on the real writer.
    func testTypingOverANoteChangedOnAnotherDeviceKeepsBothEditsAndOffersTheMerge() async throws {
        let (workspace, pageId) = try await noteOnTheRealWriter(["Flights", "Passports", "Hotel"])
        let body = try await openBody(on: workspace, pageId)

        _ = try await workspace.updatePage(
            id: pageId, edit: PageEdit(content: document(["Flights", "Passports", "Hotel booked"])))
        body.typed(document(["Flights on Friday", "Passports", "Hotel"]))
        await body.settled()

        let stored = try await workspace.getPage(id: pageId).content
        XCTAssertEqual(paragraphs(stored), ["Flights on Friday", "Passports", "Hotel booked"])
        XCTAssertEqual(editor.offers.map { paragraphs($0.body) }, [["Flights on Friday", "Passports", "Hotel booked"]])
    }

    /// Telling a merge from a plain save rests on the writer handing the editor's own body back
    /// byte for byte when nothing else changed it.
    func testASaveNobodyElseTouchedIsNotOfferedBack() async throws {
        let (workspace, pageId) = try await noteOnTheRealWriter(["Flights", "Hotel"])
        let body = try await openBody(on: workspace, pageId)

        body.typed(document(["Flights on Friday", "Hotel"]))
        await body.settled()
        body.typed(document(["Flights on Friday", "Hotel booked"]))
        await body.settled()

        XCTAssertEqual(editor.offers, [])
    }

    private func noteOnTheRealWriter(_ lines: [String]) async throws -> (Workspace, String) {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-\(UUID().uuidString).db").path
        addTeardownBlock {
            for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) }
        }
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(page: NewPage(title: "Trip", content: document(lines)))
        return (workspace, page.id)
    }

    private func openBody(on workspace: Workspace, _ pageId: String) async throws -> OpenPageBody {
        let loaded = try await workspace.getPage(id: pageId).content
        return OpenPageBody(
            loaded: loaded,
            save: { typed, base in
                try? await workspace.updatePage(
                    id: pageId, edit: PageEdit(content: typed, baseContent: base)
                ).content
            },
            read: { try? await workspace.getPage(id: pageId).content },
            offer: { [editor] body, changesSeen in editor!.offer(body, changesSeen) })
    }

    /// A body as the editor serialises one: the node's type before its content.
    private func document(_ lines: [String]) -> String {
        let blocks = lines.map { #"{"type":"paragraph","content":[{"type":"text","text":"\#($0)"}]}"# }
        return #"{"type":"doc","content":["# + blocks.joined(separator: ",") + "]}"
    }

    private func paragraphs(_ document: String) -> [String] {
        let parsed = try? JSONSerialization.jsonObject(with: Data(document.utf8)) as? [String: Any]
        let blocks = parsed?["content"] as? [[String: Any]] ?? []
        return blocks.map { block in
            let runs = block["content"] as? [[String: Any]] ?? []
            return runs.compactMap { $0["text"] as? String }.joined()
        }
    }
}

/// A writer that keeps one body and merges as the real one decides to: over the body stored, a
/// save lands as typed; over any other, it stores a merge of the three, spelled out.
@MainActor
private final class FakeWriter {
    struct Save: Equatable {
        let typed: String
        let base: String
        init(_ typed: String, over base: String) {
            self.typed = typed
            self.base = base
        }
    }

    var stored: String
    private(set) var saves: [Save] = []
    var failsNextSave = false
    /// Holds each save's answer, after the write, until `release`.
    var holdsSaves = false
    /// Holds each read until `release`.
    var holdsReads = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private var heldSaves = 0
    private var heldReads = 0

    init(stored: String) {
        self.stored = stored
    }

    func save(_ typed: String, over base: String) async -> String? {
        saves.append(Save(typed, over: base))
        if failsNextSave {
            failsNextSave = false
            return nil
        }

        stored = base == stored ? typed : "merge(\(base)|\(stored)|\(typed))"
        let written = stored
        if holdsSaves {
            heldSaves += 1
            await withCheckedContinuation { held.append($0) }
        }
        return written
    }

    func read() async -> String? {
        if holdsReads {
            heldReads += 1
            await withCheckedContinuation { held.append($0) }
        }
        return stored
    }

    func release() {
        holdsSaves = false
        holdsReads = false
        for waiting in held { waiting.resume() }
        held = []
    }

    func untilASaveIsHeld() async {
        while heldSaves == 0 { await Task.yield() }
    }

    func untilAReadIsHeld() async {
        while heldReads == 0 { await Task.yield() }
    }
}

/// The webview's side: records each body offered, and whether one was there to take it.
@MainActor
private final class FakeEditor {
    struct Offer: Equatable {
        let body: String
        let changesSeen: Int
        init(_ body: String, changesSeen: Int) {
            self.body = body
            self.changesSeen = changesSeen
        }
    }

    private(set) var offers: [Offer] = []
    var isListening = true

    func offer(_ body: String, _ changesSeen: Int) -> Bool {
        guard isListening else { return false }
        offers.append(Offer(body, changesSeen: changesSeen))
        return true
    }
}
