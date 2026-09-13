# Pikos for iOS

Three pieces:

| Directory           | What it is                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `PikosCore`         | Swift package over the shared Rust logic (`crates/pikos-ffi`). Generated bindings, committed. |
| `PikosEditorBridge` | The WKWebView host for the shared Tiptap editor, and the generated wire protocol.             |
| `Pikos`             | The app. SwiftUI, generated Xcode project.                                                    |

## First run

Two of the inputs are build artifacts and are not committed — a multi-megabyte
binary and a bundled web page. Produce them first:

```bash
# 1. The XCFramework PikosCore links against. macOS only: cross-compiling to
#    Apple targets needs the Apple linker, and create-xcframework has no Linux
#    equivalent. Also regenerates the Swift bindings so they match the build.
bash scripts/build-ios-framework.sh

# 2. The editor. Runs anywhere Node runs.
bash scripts/build-editor-bundle.sh

# 3. The Xcode project, from project.yml.
brew install xcodegen        # once
cd apps/ios/Pikos && xcodegen generate
```

Then set `DEVELOPMENT_TEAM` in Xcode (deliberately blank in `project.yml`, since
it is a local setting) and enable the **App Groups** capability with
`group.app.pikos` on every target. `WorkspaceLocation` throws rather than
falling back to the app's private container if that group is unreachable — a
silent fallback would work perfectly in the app and leave widgets reading an
empty database, which looks like a widget bug for weeks before anyone suspects
provisioning.

## Tests

```bash
swift test --package-path apps/ios/PikosCore
swift test --package-path apps/ios/PikosEditorBridge
```

`PikosCore` has two targets: `PikosCore` (generated bindings, overwritten by
`scripts/gen-swift-bindings.sh`) and `PikosSupport` (hand-written, shared by the
app and the widget — it is where the App Group path is decided, and the app and
its extensions disagreeing about that would mean a widget reading a different
database).

`PikosCore`'s tests cover the FFI boundary — optionals that must stay nil,
unsigned counts that must not wrap, enum payloads, UTF-8, and the workspace's
async and read-only behaviour. `PikosEditorBridge`'s cover the wire protocol's
encoding and the scheme handler's path handling, including traversal attempts.

The editor's own behaviour is tested separately and more thoroughly, in a real
browser: `pnpm --filter @pikos/editor-mobile test:e2e`.

## Status

**None of this Swift has been compiled.** It was written where no Swift
toolchain was available, so expect the first build to surface work — most
likely strict-concurrency annotations on `EditorWebView.Coordinator`, which
conforms to two WebKit delegate protocols. `docs/ios/03-m0-spike.md` says what
to expect and why annotations were not added speculatively.

Everything beneath the Swift _is_ tested: the Rust is graded against a corpus
generated from the TypeScript it replaces, and the editor against a browser
suite.

## What is deliberately missing

- **Natural-language quick add.** The parser is still TypeScript. Quick add uses
  a native date picker instead, which on a phone is arguably better anyway —
  when the parser lands it should be added alongside, not replace it. See
  `docs/ios/04-parser-grammar.md`.
- **Calendar screens.** M3.
- **Formatting commands.** The toolbar reflects the caret's state; sending
  commands back to the editor is the return path, and M3 work.
- **Share extension.** M4. Capturing a URL or a selection into a new page.
- **Notifications.** The scheduler exists in Rust and drives the desktop app;
  delivering through `UNUserNotificationCenter` is the remaining half.
