#if canImport(UIKit)

import SwiftUI
import WebKit

/// The editor, as a SwiftUI view.
public struct EditorWebView: UIViewRepresentable {
    /// Document to show. Changing the page id loads it; changing the JSON alone
    /// does not, since re-pushing it would fight the user's cursor.
    public let pageId: String
    public let documentJSON: String

    public let assetRoot: URL

    /// Handle for sending commands in; a read-only editor needs none.
    public var controller: EditorController?
    public var colorScheme: ColorScheme = .light
    public var accentColor: String = "#d1603d"

    /// Whether the surface takes input. False for a page written by a newer
    /// schema than this build can save: a surface that accepts keystrokes and
    /// drops them reads as the app losing work.
    public var isEditable: Bool = true

    /// Fired when the document changes, already debounced in the webview.
    public var onDocumentChanged: (_ pageId: String, _ json: String, _ plainText: String) -> Void

    /// Fired when the selection moves; drives a native formatting toolbar.
    public var onSelectionChanged: (_ marks: [String], _ nodeType: String, _ isEmpty: Bool) -> Void

    /// Fired when a link is tapped. The webview never navigates; the host decides.
    public var onLinkTapped: (URL) -> Void

    /// Fired when the user asks to insert an image.
    public var onImageRequested: () -> Void

    /// Fired once the editor reports ready, with how long the cold load took.
    public var onReady: (_ loadDuration: TimeInterval) -> Void

    /// How long the keystrokes since the last report took to reach the screen, in milliseconds.
    public var onInputTiming: (_ count: Int, _ medianMs: Double, _ worstMs: Double) -> Void

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
        onInputTiming: @escaping (Int, Double, Double) -> Void = { _, _, _ in }
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

        // The webview scrolls itself, so the host must not wrap it in a
        // ScrollView; bounce reads as a bug on a text surface.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive

        #if DEBUG
        // Lets Safari's Web Inspector attach on a debug build.
        webView.isInspectable = true
        #endif

        webView.hidesFormAccessory()

        context.coordinator.webView = webView
        controller?.attach(context.coordinator)

        context.coordinator.loadStartedAt = Date()
        // Through the scheme handler, not loadFileURL, so the document and its images share one origin.
        webView.load(URLRequest(url: EditorAssetSchemeHandler.editorURL))
        return webView
    }

    /// `WKUserContentController` holds its handlers strongly, so without this the
    /// coordinator and webview outlive the view, and each pushed editor screen
    /// leaks a webview until a jetsam kill.
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

    /// Shared by registration and teardown; a mismatch would silently leak.
    static let messageHandlerName = "pikos"

    static func bundleURL() -> URL {
        guard let url = Bundle.module.url(forResource: "editor", withExtension: "html") else {
            // A fresh checkout lacks the bundle; fail clearly rather than show a blank screen.
            fatalError(
                "editor.html is missing from the bundle. Run scripts/build-editor-bundle.sh."
            )
        }
        return url
    }

    public final class Coordinator: NSObject, EditorMessageSink, WKScriptMessageHandler,
        WKNavigationDelegate
    {
        var parent: EditorWebView
        /// Weak because the webview owns its configuration, which owns this through the message handler.
        weak var webView: WKWebView?
        var isReady = false
        var loadedPageId: String?
        var appliedTheme: String?
        /// The editor starts editable, so `nil` agrees with `true` without a message.
        var appliedEditable: Bool?
        var loadStartedAt: Date?
        /// Held so `dismantleUIView` can detach it: the view is a value type.
        var controller: EditorController?

        init(_ parent: EditorWebView) {
            self.parent = parent
            self.controller = parent.controller
        }

        func deliver(_ message: EditorBridge.Outgoing) {
            guard let webView else { return }
            send(message, on: webView)
        }

        func send(_ message: EditorBridge.Outgoing, on webView: WKWebView) {
            do {
                let json = try message.encoded()
                // Passed as a literal argument so document content with quotes or
                // newlines cannot break out of the expression.
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
                // A mismatch is a build problem: loud in debug, and in release
                // dropping a message beats acting on a guess.
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
                    // Sent now so a locked page is never editable before the first update pass.
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

            case .heightChanged:
                // Only a host that sizes the webview inline needs it; this one lets it scroll itself.
                break
            }
        }

        public func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Allowlist: only the editor's own URL. A tapped link is refused and
            // reported to the host. Not a denylist, since page content is user-controlled.
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
    /// Replace WebKit's form bar (previous, next, done) with an empty one: a document has no
    /// fields, so it was a second bar under the host's formatting row.
    ///
    /// WebKit offers no switch, and the view owning the keyboard is a private content view, so
    /// that instance gets a subclass whose `inputAccessoryView` is an empty view. Empty rather
    /// than nil: with a hardware keyboard the accessory is all iOS shows, and with none the
    /// keyboard notifications the formatting row waits for never arrive. If a future WebKit
    /// renames the view, nothing matches and the bar comes back.
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
