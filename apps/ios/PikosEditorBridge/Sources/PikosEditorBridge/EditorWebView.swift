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
    public var colorScheme: ColorScheme = .light
    public var accentColor: String = "#d1603d"

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
        colorScheme: ColorScheme = .light,
        accentColor: String = "#d1603d",
        onDocumentChanged: @escaping (String, String, String) -> Void,
        onSelectionChanged: @escaping ([String], String, Bool) -> Void = { _, _, _ in },
        onLinkTapped: @escaping (URL) -> Void = { _ in },
        onImageRequested: @escaping () -> Void = {},
        onReady: @escaping (TimeInterval) -> Void = { _ in }
    ) {
        self.pageId = pageId
        self.documentJSON = documentJSON
        self.assetRoot = assetRoot
        self.colorScheme = colorScheme
        self.accentColor = accentColor
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
        configuration.userContentController.add(context.coordinator, name: "pikos")

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
        // the webview on a real device.
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        context.coordinator.loadStartedAt = Date()
        // Loaded through the scheme handler rather than loadFileURL so the
        // document and its images share one origin.
        webView.load(URLRequest(url: EditorAssetSchemeHandler.editorURL))
        return webView
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
    }

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

    public final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: EditorWebView
        var isReady = false
        var loadedPageId: String?
        var appliedTheme: String?
        var loadStartedAt: Date?

        init(_ parent: EditorWebView) {
            self.parent = parent
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
                guard payload.protocolVersion == Double(EditorBridge.protocolVersion) else {
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
            // The editor is a local document and must never navigate. Any
            // attempt to leave it — a stray link, an injected redirect — is
            // refused, and taps arrive through the bridge instead.
            if navigationAction.navigationType == .other, navigationAction.targetFrame?.isMainFrame != false,
                webView.url == nil
            {
                decisionHandler(.allow)
                return
            }
            if let url = navigationAction.request.url, navigationAction.navigationType == .linkActivated {
                parent.onLinkTapped(url)
            }
            decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
        }
    }
}
