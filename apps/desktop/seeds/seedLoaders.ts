// Registry of dev/test seed scenarios, shared by the paths that plant one:
// the launch flag (`VITE_SEED=…`, read once on mount), the developer menu's
// reset-and-seed, and scripts/seed-ios-simulator.sh. Each seed module is
// imported lazily so none of this reaches a user build's main chunk.
//
// This directory sits beside `src/`, not inside it, and the app reaches it
// through the `@seeds` alias (vite.config.ts, vitest.config.ts,
// tsconfig.app.json). The fixtures are several thousand lines of data that no
// production code path reads; keeping them out of the source tree keeps greps
// and whole-tree reads pointed at real code.

import type { StorageAdapter } from "@pikos/core";

/** Scenarios the developer menu offers (see DeveloperSettings). */
export type SeedScenario = "calendar" | "deep" | "editor" | "synced" | "tutorial" | "wide";

/** Every scenario that exists. `demo` and `marketing` are launch-only — see LAUNCH_SEEDS. */
export type SeedName = SeedScenario | "demo" | "marketing";

export interface SeedContext {
  adapter: StorageAdapter;
  /** Which path is planting the seed. A scenario may want to do more on one
   *  than the other — see `synced`. */
  phase: "launch" | "reset";
  /** Tutorial hands the first page back so the shell can navigate to it. */
  setPendingNavigation: (nav: { pageId: string; folderId: string }) => void;
}

export type SeedLoader = (ctx: SeedContext) => Promise<void>;

// The dev-only loaders live behind a static `import.meta.env.DEV` so Rollup
// drops their `import()` calls — and therefore their chunks — from a user
// build. They are unreachable there anyway: launchSeedLoader refuses dev-only
// names in a non-dev build, and the only other caller is the developer menu,
// which is itself DEV-gated (SettingsNav/SettingsPage). The stubs below keep
// every key present so `isSeedName`'s `in` check stays truthful in both builds.
const DEV_LOADERS: Partial<Record<SeedName, SeedLoader>> | undefined = import.meta.env.DEV
  ? {
      calendar: async ({ adapter }) => {
        const { seedCalendar } = await import("./calendar");
        await seedCalendar(adapter);
      },
      deep: async ({ adapter }) => {
        const { seedDeep } = await import("./deep");
        await seedDeep(adapter);
      },
      demo: async ({ adapter }) => {
        const { seedDemo } = await import("./demo");
        await seedDemo(adapter);
      },
      editor: async ({ adapter }) => {
        const { seedEditor } = await import("./editor");
        await seedEditor(adapter);
      },
      marketing: async ({ adapter }) => {
        const { seedMarketing } = await import("./marketing");
        await seedMarketing(adapter);
      },
      wide: async ({ adapter }) => {
        const { seedWide } = await import("./wide");
        await seedWide(adapter);
      },
    }
  : undefined;

const unavailable: SeedLoader = async () => {
  // A dev-only fixture requested from a user build; nothing to plant.
};

export const SEED_LOADERS: Record<SeedName, SeedLoader> = {
  calendar: DEV_LOADERS?.calendar ?? unavailable,
  deep: DEV_LOADERS?.deep ?? unavailable,
  demo: DEV_LOADERS?.demo ?? unavailable,
  editor: DEV_LOADERS?.editor ?? unavailable,
  marketing: DEV_LOADERS?.marketing ?? unavailable,
  synced: async ({ adapter, phase }) => {
    // Only reset lays the realistic week under the mirrors; the launch flag
    // plants the mirrors alone, which the synced-calendar e2e fixtures expect.
    if (phase === "reset") {
      const { plantRealistic } = await import("./realistic");
      await plantRealistic(adapter);
    }
    const { plantSyncedLayer } = await import("./plant");
    await plantSyncedLayer(adapter);
  },
  tutorial: async ({ adapter, setPendingNavigation }) => {
    const { seedTutorial } = await import("./tutorial");
    const result = await seedTutorial(adapter);
    if (result) {
      setPendingNavigation({ folderId: result.folderId, pageId: result.welcomePageId });
    }
  },
  wide: DEV_LOADERS?.wide ?? unavailable,
};

/**
 * Scenarios `VITE_SEED=` accepts at launch, and the build each one needs.
 *
 * `marketing` and `demo` only ever arrive through the launch flag — scripts/record-hero.sh
 * and playwright.tour.config.ts set them, and the developer menu doesn't list them.
 *
 * "any-build" scenarios must also work with import.meta.env.DEV false, since a
 * production `vite preview` build can be launched with one.
 */
const LAUNCH_SEEDS: Partial<Record<SeedName, "any-build" | "dev-only">> = {
  calendar: "dev-only",
  deep: "dev-only",
  demo: "dev-only",
  editor: "dev-only",
  marketing: "dev-only",
  synced: "any-build",
  tutorial: "any-build",
  wide: "dev-only",
};

function isSeedName(name: string): name is SeedName {
  return name in SEED_LOADERS;
}

/** Resolve a raw `VITE_SEED` value, or null when this build won't plant it. */
export function launchSeedLoader(name: string | undefined): SeedLoader | null {
  if (name === undefined || !isSeedName(name)) return null;
  const build = LAUNCH_SEEDS[name];
  if (build === undefined) return null;
  if (build === "dev-only" && !import.meta.env.DEV) return null;
  return SEED_LOADERS[name];
}
