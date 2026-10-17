// swift-tools-version: 5.9
import PackageDescription

// PikosEditorBridge — the native half of the editor webview.
//
// Contains the WKWebView host, the custom scheme handler that serves the
// editor and its assets, and the generated wire protocol. The editor itself is
// a single HTML file built by `pnpm --filter @pikos/editor-mobile build` and
// copied in by scripts/build-editor-bundle.sh; it is a build artifact, so it is
// gitignored rather than committed.
let package = Package(
    name: "PikosEditorBridge",
    // macOS is not a shipping target — `EditorWebView` is `#if canImport(UIKit)`
    // and simply is not there. It is declared so `swift test` can run the
    // protocol, controller and scheme-handler tests on the host in seconds
    // rather than through a simulator; those touch no webview.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PikosEditorBridge", targets: ["PikosEditorBridge"])
    ],
    targets: [
        .target(
            name: "PikosEditorBridge",
            path: "Sources/PikosEditorBridge",
            resources: [.copy("Resources/editor.html")]
        ),
        .testTarget(
            name: "PikosEditorBridgeTests",
            dependencies: ["PikosEditorBridge"],
            path: "Tests/PikosEditorBridgeTests"
        ),
    ]
)
