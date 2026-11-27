import XCTest

@testable import PikosEditorBridge

/// The wire protocol is generated from packages/editor-mobile/src/protocol.ts, so these do not
/// re-test field names; they cover the encoding and decoding around it, which is hand-written.
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

    /// Documents routinely contain quotes, backslashes and newlines, and the encoded message is
    /// interpolated into a JavaScript call, so anything escaping its string literal would run as code.
    func testDocumentContentCannotEscapeItsEncoding() throws {
        let hostile = #"{"text":"\" ; window.evil() ; \"","newline":"a\nb"}"#
        let json = try EditorBridge.Outgoing
            .load(.init(doc: hostile, pageId: "p"))
            .encoded()

        // Round-trips to exactly what went in: no interpretation happened along the way.
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

    func testSetEditableEncodesABareBoolean() throws {
        let locked = try EditorBridge.Outgoing.setEditable(.init(editable: false)).encoded()
        XCTAssertTrue(locked.contains("\"type\":\"setEditable\""))
        // A JSON boolean, not a string or a number: the webview flips
        // `contenteditable` on exactly this value, and "false" is truthy.
        XCTAssertTrue(locked.contains("\"editable\":false"))
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

    /// The webview refuses marks outside its allowlist, and a silently dropped name looks like a
    /// dead button.
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

    func testAnEditorsAnswerToANewerBodyDecodes() throws {
        let data = Data(#"{"v":1,"type":"reloadResult","payload":{"applied":true,"pageId":"p"}}"#.utf8)
        guard case .reloadResult(let payload) = try JSONDecoder().decode(
            EditorBridge.Incoming.self, from: data)
        else {
            return XCTFail("expected reloadResult")
        }
        XCTAssertTrue(payload.applied)
        XCTAssertEqual(payload.pageId, "p")
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

@MainActor
private final class RecordingSink: EditorMessageSink {
    var isReady = false
    var delivered: [EditorBridge.Outgoing] = []

    func deliver(_ message: EditorBridge.Outgoing) {
        delivered.append(message)
    }

    /// The message types that arrived, in order. Type names rather than payloads, so assertions
    /// stay about routing, which the controller decides.
    var types: [String] {
        delivered.compactMap { message -> String? in
            guard let json = try? message.encoded(),
                let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
                let fields = object as? [String: Any]
            else { return nil }
            return fields["type"] as? String
        }
    }
}

/// `EditorController` decides whether a command goes anywhere, and wrong routing looks like a bug
/// in the editor: a toolbar button that does nothing.
@MainActor
final class EditorControllerTests: XCTestCase {

    func testCommandsAreDroppedWithNoEditorAttached() {
        let controller = EditorController()
        XCTAssertFalse(controller.isReady)
        // The bar is that this does not trap; there is nowhere for it to go.
        controller.toggleMark(.bold)
        controller.focus()
    }

    /// The editor is mounted but still loading: sending now would reach a `window.pikosEditor` that
    /// does not exist yet, and the command would be lost silently.
    func testCommandsAreDroppedUntilTheEditorReports() {
        let sink = RecordingSink()
        let controller = EditorController()
        controller.attach(sink)

        controller.toggleMark(.bold)
        XCTAssertEqual(sink.delivered.count, 0)

        sink.isReady = true
        controller.toggleMark(.bold)
        XCTAssertEqual(sink.types, ["toggleMark"])
    }

    func testEveryCommandRoutesToItsMessage() {
        let sink = RecordingSink()
        sink.isReady = true
        let controller = EditorController()
        controller.attach(sink)

        controller.toggleMark(.italic)
        controller.toggleBlock(.heading(level: 2))
        controller.focus()
        controller.blur()
        controller.insertImage(assetPath: "assets/a.png")

        XCTAssertEqual(
            sink.types, ["toggleMark", "toggleBlock", "focus", "blur", "insertImage"])
    }

    /// Every reload delivered gets one answer, and the host pairs answers with bodies in order, so
    /// it has to know which bodies went nowhere.
    func testANewerBodySaysWhetherAnEditorTookIt() {
        let sink = RecordingSink()
        let controller = EditorController()
        controller.attach(sink)

        XCTAssertFalse(controller.reload(pageId: "p", doc: "{}", changesSeen: 0))

        sink.isReady = true
        XCTAssertTrue(controller.reload(pageId: "p", doc: "{}", changesSeen: 2))
        XCTAssertEqual(sink.types, ["reload"])
    }

    func testDetachingStopsDelivery() {
        let sink = RecordingSink()
        sink.isReady = true
        let controller = EditorController()
        controller.attach(sink)
        controller.detach()

        controller.focus()
        XCTAssertEqual(sink.delivered.count, 0)
        XCTAssertFalse(controller.isReady)
    }

    /// The controller holds the sink weakly, so a torn-down editor is not kept alive by a controller
    /// the screen still holds.
    func testTheSinkIsNotRetained() {
        let controller = EditorController()
        do {
            let sink = RecordingSink()
            sink.isReady = true
            controller.attach(sink)
            XCTAssertTrue(controller.isReady)
        }
        XCTAssertFalse(controller.isReady, "the sink should have been released")
    }
}

/// The scheme handler is the webview's only route to the filesystem, and the paths it receives
/// come out of user content, so these cover the boundary rather than the happy path.
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

    /// `URL.path` decodes once already. Decoding again turned the percent sign in `50%.png` into an
    /// escape sequence, so the image silently failed to load.
    func testPercentSignsInFilenamesSurvive() throws {
        try Data("x".utf8).write(to: root.appendingPathComponent("50%.png"))
        XCTAssertEqual(
            resolve("pikos-asset://asset/50%25.png")?.lastPathComponent, "50%.png")
    }

    /// A doubly-encoded traversal is read literally: a directory named `%2e%2e`, still inside the
    /// root, rather than decoded into `..` and left to the root check.
    func testDoublyEncodedTraversalIsTakenLiterally() throws {
        let resolved = resolve("pikos-asset://asset/%252e%252e/secret")
        XCTAssertEqual(resolved?.pathComponents.suffix(2).joined(separator: "/"), "%2e%2e/secret")
        XCTAssertTrue(
            resolved?.path.hasPrefix(root.resolvingSymlinksInPath().path) ?? false,
            "still inside the asset root")
    }

    /// WebKit raises `NSInternalInconsistencyException` if a response is delivered to a task it has
    /// already stopped, which happens whenever a load is cancelled while a read is in flight.
    func testAStoppedTaskIsNotDeliveredTo() {
        // Held for the whole test: `ObjectIdentifier` is an address, and a freed one can be handed
        // to the next allocation, making this pass or fail by luck.
        let task = NSObject()
        withExtendedLifetime(task) {
            let token = ObjectIdentifier(task)
            handler.begin(token)
            handler.forget(token)
            XCTAssertFalse(handler.finish(token))
        }
    }

    func testALiveTaskIsDeliveredToExactlyOnce() {
        let task = NSObject()
        withExtendedLifetime(task) {
            let token = ObjectIdentifier(task)
            handler.begin(token)
            XCTAssertTrue(handler.finish(token))
            XCTAssertFalse(handler.finish(token), "a second delivery would also throw")
        }
    }

    func testAnUnknownTaskIsRefused() {
        let task = NSObject()
        withExtendedLifetime(task) {
            XCTAssertFalse(handler.finish(ObjectIdentifier(task)))
        }
    }

    /// Anything not recognised is served as binary, so an unexpected file
    /// cannot be coaxed into executing as script inside the editor's origin.
    func testUnknownExtensionsAreServedAsBinary() {
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "js"), "application/octet-stream")
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "html"), "text/html")
        XCTAssertEqual(EditorAssetSchemeHandler.mimeType(for: "PNG"), "image/png")
    }
}
