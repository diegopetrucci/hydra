// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "HydraPackage",
    platforms: [
        .macOS(.v26),
    ],
    products: [
        .library(name: "DaemonClient", targets: ["DaemonClient"]),
        .library(name: "AppFeature", targets: ["AppFeature"]),
    ],
    dependencies: [
        .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.26.0"),
        .package(url: "https://github.com/pointfreeco/swift-dependencies", from: "1.17.0"),
        .package(url: "https://github.com/pointfreeco/swift-concurrency-extras", from: "1.4.0"),
    ],
    targets: [
        .target(
            name: "DaemonClient",
            dependencies: [
                .product(name: "Dependencies", package: "swift-dependencies"),
                .product(name: "DependenciesMacros", package: "swift-dependencies"),
            ]
        ),
        .target(
            name: "AppFeature",
            dependencies: [
                "DaemonClient",
                .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
                .product(name: "Dependencies", package: "swift-dependencies"),
                .product(name: "DependenciesMacros", package: "swift-dependencies"),
            ]
        ),
        .testTarget(
            name: "DaemonClientTests",
            dependencies: [
                "DaemonClient",
            ]
        ),
        .testTarget(
            name: "AppFeatureTests",
            dependencies: [
                "AppFeature",
                .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
                .product(name: "ConcurrencyExtras", package: "swift-concurrency-extras"),
            ]
        ),
    ]
)
