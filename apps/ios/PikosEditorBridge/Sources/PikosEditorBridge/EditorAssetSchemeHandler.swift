import Foundation
import WebKit

/// Serves the editor bundle and page images over a single custom URL scheme.
///
/// Two hosts, one origin:
///
///   `pikos-asset://app/index.html`   the editor document
///   `pikos-asset://asset/<path>`     an image from the workspace
///
/// Both go through this scheme rather than the editor loading from `file://`,
/// because that would put the document and its images on different origins.
/// WKWebView treats `file://` as uniquely restricted, and bridging between the
/// two means granting directory-wide read access — handing the webview more of
/// the filesystem than it should ever see. One scheme keeps the webview's reach
/// to exactly what this class chooses to answer.
///
/// The callbacks run on the main thread, which is also the thread that must
/// stay responsive for typing. Reads are dispatched off it for that reason, and
/// the editor bundle is inlined into a single document so a cold load is one
/// round trip rather than several.
public final class EditorAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    public static let scheme = "pikos-asset"

    /// Host component that serves the editor document.
    static let appHost = "app"
    /// Host component that serves workspace images.
    static let assetHost = "asset"

    /// URL the editor itself is loaded from.
    public static let editorURL = URL(string: "\(scheme)://\(appHost)/index.html")!

    /// Directory that asset paths resolve within. Anything outside it is
    /// refused — see `resolve(_:)`.
    private let assetRoot: URL
    /// The built editor document.
    private let editorBundle: URL
    private let queue = DispatchQueue(label: "app.pikos.editor.assets", qos: .userInitiated)

    /// Tasks WebKit has started and not yet stopped.
    ///
    /// Delivering a response to a stopped task is not a no-op — WKWebView
    /// raises `NSInternalInconsistencyException` and the app dies. It happens
    /// whenever a load is cancelled while a read is in flight, which here means
    /// scrolling a long page fast enough that images go out of view before
    /// their data arrives. Only ever touched on the main thread, which is where
    /// both callbacks and the delivery hop run.
    private var live: Set<ObjectIdentifier> = []

    public init(assetRoot: URL, editorBundle: URL) {
        self.assetRoot = assetRoot.standardizedFileURL
        self.editorBundle = editorBundle
        super.init()
    }

    /// Map a request URL onto a file, or `nil` when it escapes the asset root.
    ///
    /// Path traversal is the obvious attack here — a document is user content,
    /// and an image path inside it could be anything, including `../../`
    /// sequences aimed at the app container. Resolving symlinks and then
    /// requiring the result to still sit under the root defeats that without
    /// trying to enumerate bad inputs.
    func resolve(_ url: URL) -> URL? {
        switch url.host {
        case Self.appHost:
            // Exactly one document is served here. Serving by name rather than
            // by path means no request to the app host can reach the filesystem.
            return url.path == "/index.html" ? editorBundle : nil

        case Self.assetHost:
            // `URL.path` is already percent-decoded. Decoding it a second time
            // was both wrong and dangerous: wrong because a file legitimately
            // named `50%.png` arrives as `50%.png` and a second pass mangles
            // it, and dangerous because `%252e%252e` would survive the first
            // decode as `%2e%2e` and become `..` on the second. The root check
            // below catches that today, but a filter that depends on a second
            // filter to be correct is one edit away from not being.
            let relative = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !relative.isEmpty else { return nil }

            let candidate = assetRoot.appendingPathComponent(relative).standardizedFileURL
            let rootPath = assetRoot.resolvingSymlinksInPath().path
            let candidatePath = candidate.resolvingSymlinksInPath().path

            guard candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/") else {
                return nil
            }
            return candidate

        default:
            return nil
        }
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let token = ObjectIdentifier(urlSchemeTask)
        begin(token)

        guard let url = urlSchemeTask.request.url, let file = resolve(url) else {
            forget(token)
            urlSchemeTask.didFailWithError(
                NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
            return
        }

        queue.async {
            do {
                let data = try Data(contentsOf: file)
                let response = URLResponse(
                    url: url,
                    mimeType: Self.mimeType(for: file.pathExtension),
                    expectedContentLength: data.count,
                    textEncodingName: nil
                )
                DispatchQueue.main.async {
                    guard self.finish(token) else { return }
                    urlSchemeTask.didReceive(response)
                    urlSchemeTask.didReceive(data)
                    urlSchemeTask.didFinish()
                }
            } catch {
                DispatchQueue.main.async {
                    guard self.finish(token) else { return }
                    urlSchemeTask.didFailWithError(error)
                }
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // The read already in flight cannot be cancelled, but its result must
        // not be delivered: WebKit throws on a stopped task rather than
        // ignoring the call. Forgetting the task here is what makes the check
        // in `finish` say no.
        forget(ObjectIdentifier(urlSchemeTask))
    }

    // MARK: - Task bookkeeping
    //
    // Three one-line methods rather than inline set operations, so the rule
    // lives in one place and a test can drive exactly the decision the
    // callbacks make — a `WKURLSchemeTask` cannot be constructed in a unit
    // test, so testing through the callbacks is not an option.

    func begin(_ token: ObjectIdentifier) {
        live.insert(token)
    }

    func forget(_ token: ObjectIdentifier) {
        live.remove(token)
    }

    /// Claim a task for delivery, or refuse if WebKit has since stopped it.
    /// Refuses a second time too, so a double delivery cannot slip through.
    func finish(_ token: ObjectIdentifier) -> Bool {
        live.remove(token) != nil
    }

    /// Content types for what a page can legitimately contain.
    ///
    /// An explicit list rather than a lookup: anything not on it is served as
    /// binary, so an unexpected file cannot be coaxed into executing as script
    /// inside the editor's origin.
    static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "heic": return "image/heic"
        case "avif": return "image/avif"
        case "html": return "text/html"
        default: return "application/octet-stream"
        }
    }
}
