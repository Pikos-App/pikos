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
        // The Mac app's half, a static library the desktop's build script links in: its Rust serves
        // the workspace through `pikos_replica_call`, and this exports `pikos_sync_start`.
        .library(name: "PikosSyncMac", type: .static, targets: ["PikosSyncMac"]),
    ],
    targets: [
        .target(name: "PikosSync", path: "Sources/PikosSync"),
        .target(name: "PikosReplicaC", path: "Sources/PikosReplicaC"),
        .target(
            name: "PikosSyncMac",
            dependencies: ["PikosSync", "PikosReplicaC"],
            path: "Sources/PikosSyncMac"
        ),
        .testTarget(
            name: "PikosSyncTests",
            dependencies: ["PikosSync"],
            path: "Tests/PikosSyncTests"
        ),
    ]
)
