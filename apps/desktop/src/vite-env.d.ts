/// <reference types="vite/client" />
/// <reference types="@total-typescript/ts-reset" />

declare const __APP_VERSION__: string;
/** True only in the in-app benchmark's build (`VITE_BENCH=true`), which opens a scratch workspace,
 *  times real interactions, and quits. Test it where it's used, not through a re-exported const:
 *  only a literal at the branch lets the bundler drop the benchmark's files from a normal build. */
declare const __PIKOS_BENCH__: boolean;
/** True only in the staging build `pnpm qa:build` makes (`VITE_STAGING=true`): the app under its
 *  own identifier, for QA that can't reach the installed app's workspace. */
declare const __PIKOS_STAGING__: boolean;
