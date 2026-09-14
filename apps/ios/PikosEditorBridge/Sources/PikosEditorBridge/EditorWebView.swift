// UIKit-only, and gated so it says so.
//
// `UIViewRepresentable`, `UIScrollView` and `UIColor` exist only where UIKit
// does. Without this guard the package cannot build for the host at all, which
// would mean `swift test --package-path apps/ios/PikosEditorBridge` had to go
// through a simulator — minutes instead of seconds — to run protocol and
// scheme-handler tests that touch no webview.
#if canImport(UIKit)

import SwiftUI
import WebKit

/// The editor, as a SwiftUI view.
///
/// This is the M0 spike's subject: whether a WKWebView can host the Tiptap
/// editor well enough to be the one non-native surface in an otherwise native
/// app. Everything here exists to give that question a fair test — the
/// measurements in `EditorMetrics`, the keyboard and scroll configuration, and
/// the single-document load.
public struct EditorWebView: UIViewRepresentable {
    /// Document to show. Changing the page id loads it; changing the JSON alone
    /// does not, since the editor is the authority on its own content once
    /// loaded and re-pushing it would fight the user's cursor.
    public let pageId: String
    public let documentJSON: String

    public let assetRoot: URL

    /// Handle for sending commands in. Optional because a read-only editor
    /// needs none, and passing one that is never used would suggest otherwise.
    public var controller: EditorController?
    public var colorScheme: ColorScheme = .light
    public var accentColor: String = "#d1603d"

    /// Whether the surface takes input. False for a page written by a newer
    /// schema than this build can save: refusing to save is not enough on its
    /// own, because a surface that still accepts keystrokes and drops them
    /// reads as the app losing work rather than protecting it.
    public var isEditable: Bool = true

    /// Fired when the document changes, already debounced in the webview.
    public var onDocumentChanged: (_ pageId: String, _ json: String, _ plainText: String) -> Void

    /// Fired when the selection moves; drives a native formatting toolbar.
    public var onSelectionChanged: (_ marks: [String], _ nodeType: String, _ isEmpty: Bool) -> Void

    /// Fired when a link is tapped. The webview does not navigate — the host
    /// decides, so a tap inside a note cannot take the user out of the app
    /// unexpectedly.
    public var onLinkTapped: (URL) -> Void

    /// Fired when the user asks to insert an image.
    public var onImageRequested: () -> Void

    /// Fired once the editor reports ready, with how long the cold load took.
    /// M0's pass bar is < 300 ms on iPhone 12-class hardware.
    public var onReady: (_ loadDuration: TimeInterval) -> Void

    public init(
        pageId: String,
        documentJSON: String,
        assetRoot: URL,
        controller: EditorController? = nil,
        colorScheme: ColorScheme = .light,
        accentColor: String = "#d1603d",
        isEditable: Bool = true,
        onDocumentChanged: @escaping (String, String, String) -> Void,
        onSelectionChanged: @escaping ([String], String, Bool) -> Void = { _, _, _ in },
        onLinkTapped: @escaping (URL) -> Void = { _ in },
        onImageRequested: @escaping () -> Void = {},
        onReady: @escaping (TimeInterval) -> Void = { _ in }
    ) {
        self.pageId = pageId
        self.documentJSON = documentJSON
        self.assetRoot = assetRoot
        self.controller = controller
        self.colorScheme = colorScheme
        self.accentColor = accentColor
        self.isEditable = isEditable
        self.onDocumentChanged = onDocumentChanged
        self.onSelectionChanged = onSelectionChanged
        self.onLinkTapped = onLinkTapped
        self.onImageRequested = onImageRequested
        self.onReady = onReady
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    public func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            EditorAssetSchemeHandler(assetRoot: assetRoot, editorBundle: Self.bundleURL()),
            forURLScheme: EditorAssetSchemeHandler.scheme
        )
        configuration.userContentController.add(context.coordinator, name: Self.messageHandlerName)

        // The editor manages its own focus through the bridge, so the webview
        // must not require a tap to bring the keyboard up when the host calls
        // focus().
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear

        // The editor is a text surface, not a web page. Bounce and zoom both
        // read as bugs here, and a nested scroll view inside a SwiftUI
        // ScrollView is the "scroll-in-scroll" problem M0 is asked to measure —
        // so the webview scrolls itself and the host must not wrap it.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive

        #if DEBUG
        // Safari's Web Inspector can attach to the editor on a debug build,
        // which is the only practical way to diagnose a layout problem inside
        // the webview on a real device. No availability check: `isInspectable`
        // arrived in 16.4 and this package's floor is iOS 17.
        webView.isInspectable = true
        #endif

        context.coordinator.webView = webView
        controller?.attach(context.coordinator)

        context.coordinator.loadStartedAt = Date()
        // Loaded through the scheme handler rather than loadFileURL so the
        // document and its images share one origin.
        webView.load(URLRequest(url: EditorAssetSchemeHandler.editorURL))
        return webView
    }

    /// Unregister the message handler when the view goes away.
    ///
    /// `WKUserContentController` holds its handlers strongly, so the
    /// coordinator — and through the configuration, the webview — would outlive
    /// the view without this. Pushing and popping editor screens would then
    /// accumulate a webview apiece, which on a phone is the kind of leak that
    /// ends in a jetsam kill rather than a visible bug.
    public static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: messageHandlerName)
        webView.navigationDelegate = nil
        webView.stopLoading()
        coordinator.controller?.detach()
    }

    public func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.isReady else { return }

        if context.coordinator.loadedPageId != pageId {
            context.coordinator.loadedPageId = pageId
            context.coordinator.send(
                .load(.init(doc: documentJSON, pageId: pageId)), on: webView)
        }

        let scheme = colorScheme == .dark ? "dark" : "light"
        if context.coordinator.appliedTheme != scheme {
            context.coordinator.appliedTheme = scheme
            context.coordinator.send(
                .setTheme(.init(accent: accentColor, scheme: scheme)), on: webView)
        }

        if context.coordinator.appliedEditable != isEditable {
            context.coordinator.appliedEditable = isEditable
            context.coordinator.send(.setEditable(.init(editable: isEditable)), on: webView)
        }
    }

    /// Name the webview posts messages under. Declared once so registration
    /// and teardown cannot drift — a mismatch there would silently leak.
    static let messageHandlerName = "pikos"

    /// The built editor, copied into the package's resources by
    /// scripts/build-editor-bundle.sh.
    static func bundleURL() -> URL {
        guard let url = Bundle.module.url(forResource: "editor", withExtension: "html") else {
            // A clear failure beats a blank screen: the bundle is a build
            // artifact, and a fresh checkout will not have it until the script
            // has run once.
            fatalError(
                "editor.html is missing from the bundle. Run scripts/build-editor-bundle.sh."
            )
        }
        return url
    }

    // MARK: - Coordinator

    public final class Coordinator: NSObject, EditorMessageSink, WKScriptMessageHandler,
        WKNavigationDelegate
    {
        var parent: EditorWebView
        /// The webview this coordinator drives. Weak because the webview owns
        /// its configuration, which owns this through the message handler.
        weak var webView: WKWebView?
        var isReady = false
        var loadedPageId: String?
        var appliedTheme: String?
        /// The editor starts editable, so `nil` here and `true` in the view
        /// agree without a message; only a locked page costs one.
        var appliedEditable: Bool?
        var loadStartedAt: Date?
        /// Held so `dismantleUIView` can detach it — the view itself is a value
        /// type and will not be the same instance by then.
        var controller: EditorController?

        init(_ parent: EditorWebView) {
            self.parent = parent
            self.controller = parent.controller
        }

        /// `EditorMessageSink`. The controller has no webview of its own, so
        /// the one attached in `makeUIView` is the one commands go to.
        func deliver(_ message: EditorBridge.Outgoing) {
            guard let webView else { return }
            send(message, on: webView)
        }

        func send(_ message: EditorBridge.Outgoing, on webView: WKWebView) {
            do {
                let json = try message.encoded()
                // Passed as a literal argument rather than interpolated into a
                // statement, so document content containing quotes or newlines
                // cannot break out of the expression.
                webView.evaluateJavaScript("window.pikosEditor.receive(\(json))")
            } catch {
                assertionFailure("could not encode a bridge message: \(error)")
            }
        }

        public func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                let data = try? JSONSerialization.data(withJSONObject: body)
            else { return }

            let incoming: EditorBridge.Incoming
            do {
                incoming = try JSONDecoder().decode(EditorBridge.Incoming.self, from: data)
            } catch let failure as EditorBridge.Incoming.DecodingFailure {
                // A version or type mismatch means the webview and the shell
                // disagree, which is a build problem rather than a runtime one.
                // Loud in debug, ignored in release — dropping a message the
                // host cannot understand is better than acting on a guess.
                assertionFailure("editor bridge rejected a message: \(failure)")
                return
            } catch {
                assertionFailure("editor bridge could not decode a message: \(error)")
                return
            }

            switch incoming {
            case .ready(let payload):
                guard payload.protocolVersion == EditorBridge.protocolVersion else {
                    assertionFailure(
                        "editor speaks protocol \(payload.protocolVersion), host speaks "
                            + "\(EditorBridge.protocolVersion)")
                    return
                }
                isReady = true
                if let started = loadStartedAt {
                    parent.onReady(Date().timeIntervalSince(started))
                }
                if let webView = message.webView {
                    loadedPageId = parent.pageId
                    send(.load(.init(doc: parent.documentJSON, pageId: parent.pageId)), on: webView)
                    appliedTheme = parent.colorScheme == .dark ? "dark" : "light"
                    send(
                        .setTheme(.init(accent: parent.accentColor, scheme: appliedTheme ?? "light")),
                        on: webView)
                    // Sent before the document can take a keystroke, so a
                    // locked page is never editable for the beat between
                    // ready and the first update pass.
                    if !parent.isEditable {
                        appliedEditable = false
                        send(.setEditable(.init(editable: false)), on: webView)
                    }
                }

            case .docChanged(let payload):
                parent.onDocumentChanged(payload.pageId, payload.doc, payload.plainText)

            case .selectionChanged(let payload):
                parent.onSelectionChanged(payload.marks, payload.nodeType, payload.isEmpty)

            case .linkTapped(let payload):
                if let url = URL(string: payload.url) {
                    parent.onLinkTapped(url)
                }

            case .requestImagePicker:
                parent.onImageRequested()

            case .heightChanged:
                // Only meaningful for a host that sizes the webview inline. This
                // one lets the webview scroll itself, so the message is ignored
                // rather than acted on — see the scrollView configuration above.
                break
            }
        }

        public func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // The editor is a local document and must never navigate away from
            // itself. Exactly one URL is permitted — the editor's own — and
            // everything else is refused, including a link the user taps, which
            // is reported to the host instead so the app decides what to do
            // with it.
            //
            // An allowlist rather than a denylist: a page is user content, and
            // enumerating the ways content could try to navigate is a losing
            // game.
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            if url == EditorAssetSchemeHandler.editorURL {
                decisionHandler(.allow)
                return
            }

            if navigationAction.navigationType == .linkActivated {
                parent.onLinkTapped(url)
            }
            decisionHandler(.cancel)
        }
    }
}

#endif
