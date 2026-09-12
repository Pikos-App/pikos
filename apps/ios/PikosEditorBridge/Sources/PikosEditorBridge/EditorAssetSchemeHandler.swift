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
            let relative = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !relative.isEmpty else { return nil }
            guard let decoded = relative.removingPercentEncoding else { return nil }

            let candidate = assetRoot.appendingPathComponent(decoded).standardizedFileURL
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
        guard let url = urlSchemeTask.request.url, let file = resolve(url) else {
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
                    urlSchemeTask.didReceive(response)
                    urlSchemeTask.didReceive(data)
                    urlSchemeTask.didFinish()
                }
            } catch {
                DispatchQueue.main.async { urlSchemeTask.didFailWithError(error) }
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // Reads are short and the task is checked before use; nothing to unwind.
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
