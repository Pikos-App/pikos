// swift-tools-version: 5.9
import PackageDescription

// The editor is a single HTML file built by `pnpm --filter @pikos/editor-mobile build` and
// copied in by scripts/build-editor-bundle.sh; it is gitignored, not committed.
let package = Package(
    name: "PikosEditorBridge",
    // macOS is not shipped; it is declared so `swift test` runs the tests that touch no webview on the host.
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
