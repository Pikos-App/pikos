// swift-tools-version: 5.9
import PackageDescription

// The CloudKit transport for device sync, shared by the iPhone app and the Mac app. It decides
// nothing: the Rust engine builds and merges, reached through `ReplicaStore`, so this package
// builds and tests without the Rust framework.
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
