import Foundation
import WebKit

/// Serves the editor bundle and page images over a single custom URL scheme.
///
/// Two hosts, one origin:
///
///   `pikos-asset://app/index.html`   the editor document
///   `pikos-asset://asset/<path>`     an image from the workspace
///
/// Not `file://`, which would put the document and its images on different
/// origins and need directory-wide read access to bridge them. One scheme keeps
/// the webview's reach to what this class answers.
///
/// Callbacks run on the main thread, so reads are dispatched off it to keep typing responsive.
public final class EditorAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    public static let scheme = "pikos-asset"

    static let appHost = "app"
    static let assetHost = "asset"

    public static let editorURL = URL(string: "\(scheme)://\(appHost)/index.html")!

    /// Asset paths resolve within this directory; see `resolve(_:)`.
    private let assetRoot: URL
    private let editorBundle: URL
    private let queue = DispatchQueue(label: "app.pikos.editor.assets", qos: .userInitiated)

    /// Tasks WebKit has started and not yet stopped.
    ///
    /// Delivering a response to a stopped task raises
    /// `NSInternalInconsistencyException` and kills the app, which happens when
    /// a load is cancelled mid-read, such as fast scrolling past images. Only
    /// touched on the main thread.
    private var live: Set<ObjectIdentifier> = []

    public init(assetRoot: URL, editorBundle: URL) {
        self.assetRoot = assetRoot.standardizedFileURL
        self.editorBundle = editorBundle
        super.init()
    }

    /// Map a request URL onto a file, or `nil` when it escapes the asset root.
    ///
    /// An image path in a document is user content and could be `../../` aimed at
    /// the app container. Resolving symlinks and requiring the result to sit
    /// under the root defeats that without enumerating bad inputs.
    func resolve(_ url: URL) -> URL? {
        switch url.host {
        case Self.appHost:
            // One document, served by name, so no request here reaches the filesystem.
            return url.path == "/index.html" ? editorBundle : nil

        case Self.assetHost:
            // `URL.path` is already percent-decoded. Decoding again mangles a file
            // named `50%.png` and lets `%252e%252e` become `..`; the root check
            // would catch that, but one filter shouldn't depend on another.
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
        // The in-flight read can't be cancelled, so forgetting the task makes `finish` refuse delivery.
        forget(ObjectIdentifier(urlSchemeTask))
    }

    // Separate methods because a `WKURLSchemeTask` can't be built in a unit test,
    // so tests drive the callbacks' decision through these.

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

    /// An explicit list, not a lookup: anything else is served as binary so an
    /// unexpected file cannot execute as script in the editor's origin.
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
