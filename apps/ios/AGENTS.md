# iOS app

Read `README.md` before changing code here.

- `pnpm verify` doesn't build Swift. Check a change with `swift test --package-path` on
  `apps/ios/PikosCore`, `apps/ios/PikosEditorBridge`, and `apps/apple/PikosSync`. A
  change to the app itself also has to build for the simulator, the way the "Build the
  app" step in `.github/workflows/_ios.yml` does it.
- The `PikosCore` target is generated bindings. Change `crates/pikos-ffi` and rerun
  `scripts/gen-swift-bindings.sh`. Never edit them by hand.
