// Registry of dev/test seed scenarios, shared by the two paths that plant one:
// the launch flag (`VITE_SEED=…`, read once on mount) and the developer menu's
// reset-and-seed. Each seed module is imported lazily so none of this reaches a
// user build's main chunk.

import type { StorageAdapter } from "@pikos/core";

/** Scenarios the developer menu offers (see DeveloperSettings). */
export type SeedScenario =
  | "calendar"
  | "calendar-colors"
  | "calendar-edges"
  | "notifications"
  | "realistic"
  | "stress"
  | "synced"
  | "tutorial";

/** Every scenario that exists. `marketing` is launch-only — see LAUNCH_SEEDS. */
export type SeedName = SeedScenario | "marketing";

export interface SeedContext {
  adapter: StorageAdapter;
  /** Which path is planting the seed. A scenario may want to do more on one
   *  than the other — see `synced`. */
  phase: "launch" | "reset";
  /** Tutorial hands the first page back so the shell can navigate to it. */
  setPendingNavigation: (nav: { pageId: string; folderId: string }) => void;
}

export type SeedLoader = (ctx: SeedContext) => Promise<void>;

export const SEED_LOADERS: Record<SeedName, SeedLoader> = {
  calendar: async ({ adapter }) => {
    const { seedCalendar } = await import("@/shared/seeds/calendar");
    await seedCalendar(adapter);
  },
  "calendar-colors": async ({ adapter }) => {
    const { seedCalendarColors } = await import("@/shared/seeds/calendarColors");
    await seedCalendarColors(adapter);
  },
  "calendar-edges": async ({ adapter }) => {
    const { seedCalendarEdgeCases } = await import("@/shared/seeds/calendarEdgeCases");
    await seedCalendarEdgeCases(adapter);
  },
  marketing: async ({ adapter }) => {
    const { seedMarketing } = await import("@/shared/seeds/marketing");
    await seedMarketing(adapter);
  },
  notifications: async ({ adapter }) => {
    const { seedNotifications } = await import("@/shared/seeds/notifications");
    await seedNotifications(adapter);
  },
  realistic: async ({ adapter }) => {
    const { seedRealistic } = await import("@/shared/seeds/realistic");
    await seedRealistic(adapter);
  },
  stress: async ({ adapter }) => {
    const { seedStress } = await import("@/shared/seeds/stress");
    await seedStress(adapter);
  },
  synced: async ({ adapter, phase }) => {
    // Believable native data + a mock external-calendar sync on top, so the
    // synced treatment can be spot-checked alongside normal pages. Only the
    // reset path lays the native data down; the launch flag seeds the mirrors
    // alone, which is what the synced-calendar e2e fixtures expect.
    if (phase === "reset") {
      const { seedRealistic } = await import("@/shared/seeds/realistic");
      await seedRealistic(adapter);
    }
    // The mock adapter seeds synced rows directly; the real app routes through
    // the dev Tauri command (no network/keychain). The launch path only ever
    // runs under VITE_TEST_MODE, so it always takes the mock branch.
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      const { seedSyncedCalendar } = await import("@/shared/seeds/syncedCalendar");
      await seedSyncedCalendar(adapter);
    } else {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("dev_seed_synced_calendar");
    }
  },
  tutorial: async ({ adapter, setPendingNavigation }) => {
    const { seedTutorial } = await import("@/shared/seeds/tutorial");
    const result = await seedTutorial(adapter);
    if (result) {
      setPendingNavigation({ folderId: result.folderId, pageId: result.welcomePageId });
    }
  },
};

/**
 * Scenarios `VITE_SEED=` accepts at launch, and the build each one needs.
 *
 * The two paths are deliberately not the same set. `marketing` only ever
 * arrives through the launch flag — scripts/record-hero.sh sets it, and the
 * developer menu doesn't list it. `notifications` is the mirror image: its
 * fixtures are anchored to the moment they're planted and you watch them fire
 * over the following minutes, which is a menu action, so it has no launch
 * entry here.
 *
 * "any-build" scenarios must also work with import.meta.env.DEV false: the
 * Playwright perf project serves a production `vite preview` build.
 */
const LAUNCH_SEEDS: Partial<Record<SeedName, "any-build" | "dev-only">> = {
  calendar: "dev-only",
  "calendar-colors": "dev-only",
  "calendar-edges": "dev-only",
  marketing: "dev-only",
  realistic: "dev-only",
  stress: "dev-only",
  synced: "any-build",
  tutorial: "any-build",
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
