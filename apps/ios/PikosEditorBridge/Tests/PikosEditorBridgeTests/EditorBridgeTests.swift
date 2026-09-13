import XCTest

@testable import PikosEditorBridge

/// The wire protocol is generated from packages/editor-mobile/src/protocol.ts,
/// so these do not re-test the field names — a mismatch there is impossible by
/// construction. What they cover is the encoding and decoding around it, where
/// hand-written code still sits.
final class EditorBridgeProtocolTests: XCTestCase {

    func testOutgoingMessagesEncodeAsVersionedEnvelopes() throws {
        let json = try EditorBridge.Outgoing
            .load(.init(doc: #"{"type":"doc"}"#, pageId: "page-1"))
            .encoded()

        let parsed = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        XCTAssertEqual(parsed?["v"] as? Int, EditorBridge.protocolVersion)
        XCTAssertEqual(parsed?["type"] as? String, "load")

        let payload = parsed?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["pageId"] as? String, "page-1")
    }

    /// Documents are arbitrary user text and routinely contain quotes,
    /// backslashes and newlines. The encoded message is interpolated into a
    /// JavaScript call, so anything that escapes its string literal would be
    /// evaluated as code.
    func testDocumentContentCannotEscapeItsEncoding() throws {
        let hostile = #"{"text":"\" ; window.evil() ; \"","newline":"a\nb"}"#
        let json = try EditorBridge.Outgoing
            .load(.init(doc: hostile, pageId: "p"))
            .encoded()

        // Round-trips back to exactly what went in, which is the property that
        // matters: no interpretation happened along the way.
        let parsed = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        let payload = parsed?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["doc"] as? String, hostile)
        XCTAssertFalse(json.contains("\n"), "a raw newline would break the evaluated statement")
    }

    func testEmptyPayloadMessagesEncode() throws {
        let json = try EditorBridge.Outgoing.focus(.init()).encoded()
        XCTAssertTrue(json.contains("\"type\":\"focus\""))
        XCTAssertTrue(json.contains("\"payload\":{}"))
    }

    func testFormattingCommandsEncode() throws {
        let mark = try EditorBridge.Outgoing.toggleMark(.init(mark: "bold")).encoded()
        XCTAssertTrue(mark.contains("\"type\":\"toggleMark\""))
        XCTAssertTrue(mark.contains("\"mark\":\"bold\""))

        let block = try EditorBridge.Outgoing
            .toggleBlock(.init(headingLevel: 2, nodeType: "heading"))
            .encoded()
        XCTAssertTrue(block.contains("\"nodeType\":\"heading\""))
        // An Int, not a Double: the field is declared `integer` in the protocol,
        // so this must not encode as 2.0.
        XCTAssertTrue(block.contains("\"headingLevel\":2"))
    }

    /// The mark names the controller can send must all be ones the webview
    /// accepts — it refuses anything outside its allowlist, and a name that is
    /// silently dropped looks to the user like a dead button.
    func testEveryControllerMarkIsOneTheEditorAccepts() {
        let accepted: Set<String> = ["bold", "italic", "underline", "strike", "code"]
        for mark in EditorController.Mark.allCases {
            XCTAssertTrue(accepted.contains(mark.rawValue), "\(mark.rawValue) is not accepted")
        }
    }

    /// The caret sits inside a `listItem`, not the list, so a toolbar matching
    /// on the toggle name would leave list buttons permanently inactive.
    func testListBlocksMatchTheirItemNodeType() {
        XCTAssertEqual(EditorController.Block.bulletList.nodeType, "bulletList")
        XCTAssertEqual(EditorController.Block.heading(level: 2).headingLevel, 2)
        XCTAssertEqual(EditorController.Block.paragraph.headingLevel, 0)
    }

    func testIncomingMessagesDecode() throws {
        let data = Data(
            #"{"v":1,"type":"docChanged","payload":{"doc":"{}","pageId":"p","plainText":"hi"}}"#
                .utf8)
        guard case .docChanged(let payload) = try JSONDecoder().decode(
            EditorBridge.Incoming.self, from: data)
        else {
            return XCTFail("expected docChanged")
        }
        XCTAssertEqual(payload.pageId, "p")
        XCTAssertEqual(payload.plainText, "hi")
    }

    /// An app update can replace the native shell while a webview is still
    /// live. Acting on a message from a version this build does not understand
    /// is worse than dropping it.
    func testMismatchedProtocolVersionIsRejected() {
        let data = Data(#"{"v":99,"type":"ready","payload":{"protocolVersion":99}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(EditorBridge.Incoming.self, from: data)) {
            XCTAssertEqual(
                $0 as? EditorBridge.Incoming.DecodingFailure, .unsupportedVersion(99))
        }
    }

    func testUnknownMessageTypeIsRejected() {
        let data = Data(#"{"v":1,"type":"selfDestruct","payload":{}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(EditorBridge.Incoming.self, from: data)) {
            XCTAssertEqual(
                $0 as? EditorBridge.Incoming.DecodingFailure, .unknownType("selfDestruct"))
        }
    }
}

/// The scheme handler is the webview's only route to the filesystem, and the
/// paths it receives come out of documents — which are user content. These
/// cover the boundary rather than the happy path.
final class EditorAssetSchemeHandlerTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var handler: EditorAssetSchemeHandler!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("image".utf8).write(to: root.appendingPathComponent("photo.png"))

        bundle = root.appendingPathComponent("editor.html")
        try Data("<html></html>".utf8).write(to: bundle)

        handler = EditorAssetSchemeHandler(assetRoot: root, editorBundle: bundle)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func resolve(_ string: String) -> URL? {
        guard let url = URL(string: string) else { return nil }
        return handler.resolve(url)
    }

    func testServesAnAssetInsideTheRoot() {
        XCTAssertEqual(
            resolve("pikos-asset://asset/photo.png")?.lastPathComponent, "photo.png")
    }

    func testServesTheEditorDocument() {
        XCTAssertEqual(resolve("pikos-asset://app/index.html"), bundle)
    }

    /// The app host serves exactly one document by name. If it resolved paths
    /// instead, a request there would reach the filesystem.
    func testAppHostServesNothingElse() {
        XCTAssertNil(resolve("pikos-asset://app/other.html"))
        XCTAssertNil(resolve("pikos-asset://app/../../etc/passwd"))
    }

    /// Asset paths come from documents, and a document is user content. A path
    /// aimed out of the workspace must be refused rather than sanitised, since
    /// sanitising invites an escape the filter did not anticipate.
    func testRefusesPathTraversal() {
        for hostile in [
            "pikos-asset://asset/../secret",
            "pikos-asset://asset/../../etc/passwd",
            "pikos-asset://asset/nested/../../escape",
            "pikos-asset://asset/%2e%2e/%2e%2e/etc/passwd",
        ] {
            XCTAssertNil(resolve(hostile), "should have refused \(hostile)")
        }
    }

    func testRefusesUnknownHostsAndEmptyPaths() {
        XCTAssertNil(resolve("pikos-asset://elsewhere/photo.png"))
        XCTAssertNil(resolve("pikos-asset://asset/"))
        XCTAssertNil(resolve("pikos-asset://asset"))
    }

    func testDecodesPercentEncodedPaths() throws {
        try Data("x".utf8).write(to: root.appendingPathComponent("my photo.png"))
        XCTAssertEqual(
            resolve("pikos-asset://asset/my%20photo.png")?.lastPathComponent, "my photo.png")
    }

    /// Anything not recognised is served as binary, so an unexpected file
    /// cannot be coaxed into executing as script inside the editor's origin.
    func testUnknownExtensionsAreServedAsBinary() {
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "js"), "application/octet-stream")
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "html"), "text/html")
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "PNG"), "image/png")
    }
}
