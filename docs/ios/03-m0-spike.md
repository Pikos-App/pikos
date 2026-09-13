# M0 — editor-in-webview spike

**Status:** scaffolded and buildable; unrun. The measurements need a device.

M0 exists to test one assumption before anything is built on it: that a
WKWebView can host the Tiptap editor well enough to be the single non-native
surface in an otherwise native app. The plan is explicit that a failed spike
stops the project rather than being worked around, so everything here is
arranged to let it fail honestly.

## What is built

```
packages/editor-mobile/            the editor, built for a webview
  src/protocol.ts                  the bridge, declared once
  src/bridge.ts                    webview→host transport + debounce
  src/main.ts                      Tiptap mounted on the shared schema
  src/editor.css                   phone-shaped styling, deliberately plain
  scripts/gen-swift-protocol.ts    emits the Swift half of the protocol

apps/ios/PikosEditorBridge/
  Sources/…/EditorBridgeProtocol.swift    generated — do not edit
  Sources/…/EditorWebView.swift           SwiftUI host, measurement hooks
  Sources/…/EditorAssetSchemeHandler.swift  serves the editor and images
  Tests/…                                  protocol + path-traversal tests

scripts/build-editor-bundle.sh     builds and installs the editor. No Xcode.
```

The document schema comes from `@pikos/editor-schema`, shared with desktop, so
a page written on the phone is byte-identical to one written on the laptop.
That is what makes the round-trip item on the pass bar meaningful rather than a
formality — see `docs/ios/01-business-logic-inventory.md` for what the shared
package covers, including two extensions that look behavioural and are not.

## Running it

```bash
bash scripts/build-editor-bundle.sh            # anywhere
swift test --package-path apps/ios/PikosEditorBridge   # macOS
```

Then embed `EditorWebView` in a SwiftUI view with a page's JSON, point
`assetRoot` at a directory of images, and run on a physical device. The
simulator is not a valid venue for any of the timing measurements — it has the
host Mac's CPU and none of the memory pressure.

## The pass bar, and how to measure each item

The plan sets these. They are reproduced with a method for each, because
"typing latency indistinguishable from Notes" is not a measurement until
somebody says how to take it.

| Bar                                                                                  | How to measure                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typing latency indistinguishable from Notes                                          | Record both at 240fps, type the same sentence, count frames from key-down to glyph. A phone camera does this well enough; the difference being looked for is tens of milliseconds, not single frames.                                                                                           |
| No lost keystrokes                                                                   | Type a known 200-character string fast, compare the stored document to it byte-for-byte. Do it with the debounce flush path exercised: type, background the app immediately, foreground, compare.                                                                                               |
| Cold editor load < 300 ms                                                            | `EditorWebView` reports it: `onReady` receives the interval from `makeUIView` to the webview's `ready` message. Cold means first launch after install, on a device that has not run the app since boot.                                                                                         |
| Document round-trips desktop ↔ iOS with zero diff                                    | Write a page on desktop covering every node type, open and save on iOS without editing, diff the stored JSON. Then the reverse. The trailing-paragraph and `indent: 0` canonicalisations are expected on _both_ sides — the shared schema's tests pin them — so a diff means a real divergence. |
| Keyboard show/hide, safe areas, scroll-in-scroll, selection handles, IME/autocorrect | Hands-on, on device. Notes below.                                                                                                                                                                                                                                                               |

### Things to look at specifically

**Scroll-in-scroll.** `EditorWebView` configures the webview to scroll itself
and disables bouncing. Do not embed it in a SwiftUI `ScrollView` — that is the
nested-scrolling case the plan flags, and it will feel wrong. If inline sizing
is wanted later, the `heightChanged` message already exists for it and the host
ignores it today.

**Keyboard.** `keyboardDismissMode = .interactive` gives the drag-to-dismiss
gesture. What to check is whether the caret stays visible as the keyboard
appears, and whether the safe-area padding in `editor.css` holds when it does.

**Selection handles and autocorrect.** Entirely WebKit's, with no way to
influence them. If they feel wrong here, they will feel wrong in the shipped
app — this is the item most likely to fail the spike, and it should be judged
honestly rather than talked past.

**Memory.** Attach Instruments and watch the webview's footprint with a long
document open. A webview is the largest single allocation the app will make.

## If it fails

The plan says stop and revisit the decision, and that instruction should be
followed rather than softened. Concretely, a failure makes these the options:

1. **Fixed-height editor with native scrolling.** The plan's own fallback.
   `heightChanged` exists for it. Fixes scroll-in-scroll; fixes nothing about
   typing latency.
2. **Native editor, shared document model.** The thing the decision rejected,
   and the rejection was sound — a native rich-text editor that reads and writes
   ProseMirror JSON byte-compatibly is a multi-year project for one person.
3. **No mobile editing.** A read-only phone client with quick-add. Much smaller
   than it sounds: the inventory shows nearly everything else is already shared,
   and quick-add needs the parser, not the editor.

Worth noting which parts of the work so far survive each outcome. The Rust
port, the UniFFI boundary and the shared schema are useful under all three —
none of them depend on the editor being a webview. The parts that would be
discarded are `packages/editor-mobile` and `PikosEditorBridge`, which is a
deliberately small fraction, and the reason the spike was scaffolded this way.

## What has not been compiled

No Swift compiler was available where this was written, and `download.swift.org`
is blocked by the environment's network policy, so **none of the Swift here has
ever been built**. The Rust, the TypeScript and the generated bindings are all
tested; the hand-written Swift is reviewed but unproven. Expect the first
`swift build` to surface something, and treat that as normal rather than as a
sign the design is wrong.

Two specific things to expect:

- **Strict concurrency.** The plan calls for Swift 6 with strict concurrency,
  and nothing here is annotated for it. `EditorWebView.Coordinator` conforms to
  `WKScriptMessageHandler` and `WKNavigationDelegate`, both of which are
  main-actor bound in practice, so `@MainActor` annotations are likely needed.
  They were not added speculatively: guessing at isolation without a compiler
  to check against tends to produce annotations that are confidently wrong.
- **`Bundle.module`.** Available only because `Package.swift` declares the
  editor as a resource. If the editor bundle has not been built,
  `EditorWebView.bundleURL()` traps with a message saying so — that is
  deliberate, and the fix is to run `scripts/build-editor-bundle.sh`.

Three issues were found and fixed by reading rather than by compiling, which is
some indication of what a review pass catches and what it does not:

1. The coordinator was registered as a script message handler and never
   removed. `WKUserContentController` retains its handlers strongly, so pushing
   and popping editor screens would have accumulated a webview apiece — on a
   phone, a leak that ends in a jetsam kill rather than a visible bug. Now torn
   down in `dismantleUIView`.
2. The navigation policy claimed in a comment that the editor "must never
   navigate" while the code allowed everything that was not a tapped link. It
   is now an allowlist of exactly one URL, which is what the comment said.
3. The protocol version crossed as a `Double` and was compared for floating
   point equality. The protocol declaration now has an `integer` field type, so
   Swift gets an `Int`.

## Deliberate omissions

- **No database.** The editor takes a document and reports changes; the host
  decides what to store. M0 needs no persistence, and adding it would confound
  the measurements with SQLite timings.
- **No native toolbar.** `selectionChanged` is wired and reports marks and node
  type, but M0 does not need a toolbar to answer its question. It is M3 work.
- **No image picker.** `requestImagePicker` and `insertImage` exist on both
  sides of the bridge and are untested end-to-end.
- **Plain styling.** `editor.css` is minimal so that what is being judged is
  the webview's behaviour, not a theme.
