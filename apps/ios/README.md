# Pikos for iOS

| Directory           | What it is                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `PikosCore`         | Swift package over the shared Rust logic (`crates/pikos-ffi`). Generated bindings, committed. |
| `PikosEditorBridge` | The WKWebView host for the shared Tiptap editor, and the generated wire protocol.             |
| `Pikos`             | The app. SwiftUI, generated Xcode project.                                                    |
| `PikosWidgets`      | The widgets and Control Center buttons, one row and one workspace opener shared.              |
| `PikosUITests`      | XCUITest flows and the screen tour.                                                           |

`PikosCore` has two targets: `PikosCore` (generated bindings, overwritten by
`scripts/gen-swift-bindings.sh`) and `PikosSupport` (hand-written, shared by the app and the
widgets).

## First run

Two inputs are build artifacts and are not committed. Produce them first:

```bash
bash scripts/build-ios-framework.sh   # macOS only; also regenerates the Swift bindings
bash scripts/build-editor-bundle.sh
brew install xcodegen                 # once
cd apps/ios/Pikos && xcodegen generate
```

Then set `DEVELOPMENT_TEAM` in Xcode (blank in `project.yml` because it is a local setting) and
enable the **App Groups** capability with `group.app.pikos` on every target.

## Rules

- **The App Group path never falls back.** `WorkspaceLocation` throws if the group is
  unreachable instead of using the app's private container. A fallback works in the app and
  leaves the widgets reading an empty database.
- **The app and its extensions open the workspace through `PikosSupport`.** If they decided the
  path separately, a widget could read a different database.
- **Arithmetic goes in `PikosSupport`, not in a view.** It needs no XCFramework, database or
  device, so it is tested on the host in seconds. `CalendarGeometry`, `DayLabel` and
  `StorageTimestamp` are the examples.
- **Accessibility labels are the UI tests' selectors.** `Mark as done`, `New page` and the
  navigation title are contract. Change one and the tier-1 flows break.
- **Storage location is not an input in a release build.** The debug-only
  `WorkspaceLocation.workspaceOverrideKey` is how each UI test gets an empty workspace.
- **iOS 26 symbols sit behind `#if compiler(>=6.2)`**, so the tree still builds with an older
  Xcode. Glass is for the navigation layer, never the content.
- **Anything UIKit-bound in `PikosEditorBridge` is behind `#if canImport(UIKit)`**, so
  `swift test` builds on macOS.

## Tests

Three layers, and the cheapest carries the most:

| Layer                                        | Where                                            | Needs                 |
| -------------------------------------------- | ------------------------------------------------ | --------------------- |
| The logic under the Swift                    | `crates/`                                        | nothing               |
| `swift test` for the packages                | `PikosCore`, `PikosSupport`, `PikosEditorBridge` | a Mac, no simulator   |
| `xcodebuild test -only-testing:PikosUITests` | the tier-1 flows                                 | a Mac and a simulator |

```bash
swift test --package-path apps/ios/PikosCore
swift test --package-path apps/ios/PikosEditorBridge
pnpm --filter @pikos/editor-mobile test:e2e   # the editor, in a real browser
```

The first `swift test` needs the XCFramework and the second the editor bundle from **First run**;
without them `Bundle.module` fails naming the file, not the reason. The UI suite covers only
the desktop's `@tier1` flows: detail belongs in the layers above. CI runs the
first two layers on every push, and the UI flows behind the `run-ui-tests` input
(`.github/workflows/_ios.yml`).
