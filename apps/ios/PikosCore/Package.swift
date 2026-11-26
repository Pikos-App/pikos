// swift-tools-version: 5.9
import PackageDescription

// The Swift bindings are committed so the API is reviewed like any source, but the
// XCFramework is a multi-megabyte binary build artifact that is not, so this package
// does not build until scripts/build-ios-framework.sh has run once on a Mac.
let package = Package(
    name: "PikosCore",
    // iOS 17 for modern SwiftUI plus interactive WidgetKit.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PikosCore", targets: ["PikosCore"]),
        .library(name: "PikosSupport", targets: ["PikosSupport"]),
    ],
    targets: [
        .binaryTarget(
            name: "PikosFFI",
            path: "Frameworks/PikosFFI.xcframework"
        ),
        .target(
            name: "PikosCore",
            dependencies: ["PikosFFI"],
            path: "Sources/PikosCore"
        ),
        // Hand-written, so apart from Sources/PikosCore, which the generator overwrites.
        .target(
            name: "PikosSupport",
            dependencies: ["PikosCore"],
            path: "Sources/PikosSupport"
        ),
        .testTarget(
            name: "PikosCoreTests",
            dependencies: ["PikosCore"],
            path: "Tests/PikosCoreTests"
        ),
        .testTarget(
            name: "PikosSupportTests",
            dependencies: ["PikosSupport"],
            path: "Tests/PikosSupportTests"
        ),
    ]
)
