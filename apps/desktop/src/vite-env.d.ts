/// <reference types="vite/client" />
/// <reference types="@total-typescript/ts-reset" />

declare const __APP_VERSION__: string;
/** True only in the in-app benchmark's build (`VITE_BENCH=true`), which opens a scratch workspace,
 *  times real interactions, and quits. Test it where it's used, not through a re-exported const:
 *  only a literal at the branch lets the bundler drop the benchmark's files from a normal build. */
declare const __PIKOS_BENCH__: boolean;
/** True in the builds `pnpm qa:build` makes (`VITE_NO_UPDATER=true`), Pikos Staging and Pikos Beta:
 *  an update is the public app, and installing it would replace them with it. */
declare const __PIKOS_NO_UPDATER__: boolean;
/** True only in a build with iCloud sync compiled in (`VITE_ICLOUD_SYNC=true`, set with the Rust
 *  `icloud-sync` feature by `pnpm qa:build --icloud`). Test it where it's used, as the benchmark's. */
declare const __PIKOS_ICLOUD_SYNC__: boolean;
