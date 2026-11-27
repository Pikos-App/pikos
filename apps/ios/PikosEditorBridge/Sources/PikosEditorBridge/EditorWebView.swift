// UIKit-only, and gated so it says so: `UIViewRepresentable`, `UIScrollView` and `UIColor` exist only
// where UIKit does, and without the guard `swift test` could not build this package for the host.
#if canImport(UIKit)

import SwiftUI
import WebKit

/// The editor, as a SwiftUI view: a WKWebView hosting the shared Tiptap editor, the one
/// non-native surface in an otherwise native app.
public struct EditorWebView: UIViewRepresentable {
    /// Document to show. Changing the page id loads it; changing the JSON alone
    /// does not, since the editor is the authority on its own content once
    /// loaded and re-pushing it would fight the user's cursor. A newer body goes
    /// in through `EditorController.reload`, which the editor can refuse.
    public let pageId: String
    public let documentJSON: String

    public let assetRoot: URL

    /// Handle for sending commands in. Optional because a read-only editor needs none.
    public var controller: EditorController?
    public var colorScheme: ColorScheme = .light
    public var accentColor: String = "#d1603d"

    /// Whether the surface takes input. False for a page written by a newer schema than this build
    /// can save: a surface that accepts keystrokes and drops them reads as the app losing work.
    public var isEditable: Bool = true

    /// Fired when the document changes, already debounced in the webview.
    public var onDocumentChanged: (_ pageId: String, _ json: String, _ plainText: String) -> Void

    /// Fired when the selection moves; drives a native formatting toolbar.
    public var onSelectionChanged: (_ marks: [String], _ nodeType: String, _ isEmpty: Bool) -> Void

    /// Fired when a link is tapped. The webview does not navigate; the host decides.
    public var onLinkTapped: (URL) -> Void

    public var onImageRequested: () -> Void

    /// Fired once the editor reports ready, with how long the cold load took.
    public var onReady: (_ loadDuration: TimeInterval) -> Void

    /// How long the keystrokes since the last report took to reach the screen, in milliseconds.
    public var onInputTiming: (_ count: Int, _ medianMs: Double, _ worstMs: Double) -> Void

    /// Fired once for every `EditorController.reload` delivered, in order: whether the editor
    /// showed that body.
    public var onReloadAnswered: (_ pageId: String, _ applied: Bool) -> Void

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
        onReady: @escaping (TimeInterval) -> Void = { _ in },
        onInputTiming: @escaping (Int, Double, Double) -> Void = { _, _, _ in },
        onReloadAnswered: @escaping (String, Bool) -> Void = { _, _ in }
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
        self.onInputTiming = onInputTiming
        self.onReloadAnswered = onReloadAnswered
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

        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear

        // The editor is a text surface, not a web page. Bounce and zoom read as bugs, and a nested
        // scroll view inside a SwiftUI ScrollView fights itself, so the webview scrolls itself and
        // the host must not wrap it.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive

        #if DEBUG
        // Safari's Web Inspector can attach on a debug build, the only practical way to diagnose
        // layout inside the webview on a device. No availability check: the floor is iOS 17.
        webView.isInspectable = true
        #endif

        webView.hidesFormAccessory()

        context.coordinator.webView = webView
        controller?.attach(context.coordinator)

        context.coordinator.loadStartedAt = Date()
        // Loaded through the scheme handler rather than loadFileURL so the
        // document and its images share one origin.
        webView.load(URLRequest(url: EditorAssetSchemeHandler.editorURL))
        return webView
    }

    /// Unregister the message handler when the view goes away. `WKUserContentController` holds its
    /// handlers strongly, so without this each pushed editor screen would leak a webview.
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

    static func bundleURL() -> URL {
        guard let url = Bundle.module.url(forResource: "editor", withExtension: "html") else {
            // A clear failure beats a blank screen: a fresh checkout lacks the bundle until the script runs.
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
                // A version or type mismatch is a build problem. Loud in debug, ignored in release:
                // dropping a message the host cannot understand beats acting on a guess.
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
                    // Sent before the document can take a keystroke, so a locked page is never editable
                    // between ready and the first update pass.
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

            case .inputTiming(let payload):
                parent.onInputTiming(payload.count, payload.medianMs, payload.worstMs)

            case .reloadResult(let payload):
                parent.onReloadAnswered(payload.pageId, payload.applied)

            case .heightChanged:
                // Ignored: this host lets the webview scroll itself rather than sizing it inline.
                break
            }
        }

        public func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // The editor is a local document and must never navigate away. Exactly one URL is
            // permitted, the editor's own; anything else is refused, and a tapped link is reported to
            // the host to decide. An allowlist, because enumerating the ways user content could try
            // to navigate is a losing game.
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

extension WKWebView {
    /// Replace WebKit's form bar, the previous, next and done row over the keyboard, with an empty
    /// one: a document has no form fields, and it was a second bar under the host's formatting row.
    /// WebKit offers no switch, so the private content view that owns the keyboard gets a subclass
    /// whose `inputAccessoryView` is an empty view. Empty rather than nil: with a hardware keyboard
    /// the accessory is all iOS shows, and with none the keyboard notifications the host's
    /// formatting row waits for never arrive. If WebKit renames the view, nothing matches and the
    /// bar comes back.
    func hidesFormAccessory() {
        guard
            let content = scrollView.subviews.first(where: {
                String(describing: type(of: $0)).hasPrefix("WKContent")
            }),
            let base = object_getClass(content)
        else { return }
        let name = "\(NSStringFromClass(base))_PikosNoFormAccessory"
        if let existing = NSClassFromString(name) {
            object_setClass(content, existing)
            return
        }
        guard let subclass = objc_allocateClassPair(base, name, 0) else { return }
        let getter = #selector(getter: UIResponder.inputAccessoryView)
        let empty = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: 1))
        empty.backgroundColor = .clear
        let noAccessory: @convention(block) (AnyObject) -> UIView? = { _ in empty }
        guard let method = class_getInstanceMethod(UIResponder.self, getter) else { return }
        class_addMethod(
            subclass, getter, imp_implementationWithBlock(noAccessory), method_getTypeEncoding(method))
        objc_registerClassPair(subclass)
        object_setClass(content, subclass)
    }
}

#endif
