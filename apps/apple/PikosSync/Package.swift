// swift-tools-version: 5.9
import PackageDescription

// PikosSync: the CloudKit transport for device sync, shared by the iPhone app and the Mac app.
//
// It decides nothing. Apple's sync engine says when to send and what arrived; the workspace's own
// engine, in Rust, builds what goes out and merges what comes in. The package reaches that engine
// through `ReplicaStore`, so it builds and tests on its own, without the Rust framework; each app
// supplies a `ReplicaStore` backed by its workspace.
let package = Package(
    name: "PikosSync",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PikosSync", targets: ["PikosSync"]),
    ],
    targets: [
        .target(name: "PikosSync", path: "Sources/PikosSync"),
        .testTarget(
            name: "PikosSyncTests",
            dependencies: ["PikosSync"],
            path: "Tests/PikosSyncTests"
        ),
    ]
)
