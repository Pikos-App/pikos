/**
 * The competitor comparison, stated once. The compare page and `llms.txt` both render this
 * table, so a fact changed here changes on both, and the two can't drift apart the way two
 * hand-kept copies did. Prose elsewhere on the site restates some of these facts in sentences
 * and is checked against this file at release, not generated from it.
 *
 * `COMPARISON_CHECKED` is read by `scripts/release.sh`, which refuses to tag once it is more
 * than three months old. Keep it on one line as an ISO date.
 */

export type Cell = boolean | "Paid" | "Plugin";

export interface ComparedApp {
  name: string;
  notes: Cell;
  tasks: Cell;
  calendar: Cell;
  onDevice: Cell;
  noAccount: Cell;
  phone: Cell;
  sync: Cell;
  noSubscription: Cell;
  price: string;
  sourceAvailable: boolean;
  /** Where each fact was checked. Pikos has none because its row is owned by the release. */
  sources: string[];
}

export const COMPARISON_CHECKED = "2026-09-26";

export const LEGEND =
  "Price is the base app. Paid means that part costs extra on top of it, and Plugin means it needs a community plugin. No subscription means nothing in the row needs one; a one-off purchase doesn't count.";

export const apps: ComparedApp[] = [
  {
    name: "Pikos",
    notes: true, tasks: true, calendar: true, onDevice: true, noAccount: true,
    phone: false, sync: false, noSubscription: true, price: "Free", sourceAvailable: true,
    sources: [],
  },
  {
    name: "NotePlan",
    notes: true, tasks: true, calendar: true, onDevice: true, noAccount: true,
    phone: true, sync: true, noSubscription: false, price: "$99/yr", sourceAvailable: false,
    sources: [
      "https://noteplan.co/features",
      "https://noteplan.co/pricing",
      "https://help.noteplan.co/article/31-where-are-my-notes-saved",
      "https://help.noteplan.co/article/16-what-is-the-difference-between-cloudkit-vs-icloud-drive",
    ],
  },
  {
    name: "Notion",
    notes: true, tasks: true, calendar: true, onDevice: false, noAccount: false,
    phone: true, sync: true, noSubscription: true, price: "Free", sourceAvailable: false,
    sources: ["https://www.notion.com/pricing", "https://www.notion.com/help/use-pages-offline"],
  },
  {
    name: "Obsidian",
    notes: true, tasks: "Plugin", calendar: "Plugin", onDevice: true, noAccount: true,
    phone: true, sync: "Paid", noSubscription: false, price: "Free", sourceAvailable: false,
    sources: ["https://obsidian.md/pricing", "https://obsidian.md/help/bases"],
  },
  {
    name: "Logseq",
    notes: true, tasks: true, calendar: "Plugin", onDevice: true, noAccount: true,
    phone: true, sync: "Paid", noSubscription: false, price: "Free", sourceAvailable: true,
    sources: ["https://github.com/logseq/docs/blob/master/db-version.md"],
  },
  {
    name: "TickTick",
    notes: true, tasks: true, calendar: "Paid", onDevice: false, noAccount: false,
    phone: true, sync: true, noSubscription: false, price: "Free", sourceAvailable: false,
    sources: ["https://ticktick.com/upgrade", "https://help.ticktick.com/articles/7055780476358754304"],
  },
  {
    name: "Things",
    notes: false, tasks: true, calendar: false, onDevice: true, noAccount: true,
    phone: "Paid", sync: true, noSubscription: true, price: "$49.99", sourceAvailable: false,
    sources: [
      "https://apps.apple.com/us/app/things-3/id904280696?mt=12",
      "https://apps.apple.com/us/app/things-3/id904237743",
      "https://culturedcode.com/things/support/articles/2803583/",
      "https://culturedcode.com/things/support/articles/2803586/",
    ],
  },
  {
    name: "Todoist",
    notes: false, tasks: true, calendar: "Paid", onDevice: false, noAccount: false,
    phone: true, sync: true, noSubscription: false, price: "Free", sourceAvailable: false,
    sources: [
      "https://www.todoist.com/pricing",
      "https://todoist.com/help/articles/use-the-calendar-layout-in-todoist-lPHRQTu0o",
      "https://www.todoist.com/help/articles/add-a-task-description-rOryWIHn",
    ],
  },
];

type FeatureKey = Exclude<keyof ComparedApp, "name" | "sources">;

/** `label` is the site's short column head; `longLabel` is the `llms.txt` row name. */
export const features: { key: FeatureKey; label: string; longLabel: string; onSite: boolean }[] = [
  { key: "notes", label: "Notes", longLabel: "Notes", onSite: true },
  { key: "tasks", label: "Tasks", longLabel: "Tasks", onSite: true },
  { key: "calendar", label: "Calendar", longLabel: "Calendar view", onSite: true },
  { key: "onDevice", label: "On device", longLabel: "On-device storage", onSite: true },
  { key: "noAccount", label: "No account", longLabel: "No account required", onSite: true },
  { key: "phone", label: "Phone app", longLabel: "Phone app", onSite: true },
  { key: "sync", label: "Sync", longLabel: "Sync", onSite: true },
  { key: "noSubscription", label: "No subscription", longLabel: "No subscription needed", onSite: true },
  { key: "price", label: "Price", longLabel: "Price", onSite: true },
  { key: "sourceAvailable", label: "Source", longLabel: "Source available", onSite: false },
];

/** "September 2026". Parsed by hand for the reason `formatDate` in `posts.ts` gives. */
export function checkedMonth(): string {
  const [year, month] = COMPARISON_CHECKED.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function comparisonMarkdown(): string {
  const text = (v: Cell | string) => (v === true ? "Yes" : v === false ? "No" : v);
  const rows = [
    ["Feature", ...apps.map((a) => a.name)],
    ...features.map((f) => [f.longLabel, ...apps.map((a) => text(a[f.key]))]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  const rule = `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`;
  return [line(rows[0]), rule, ...rows.slice(1).map(line)].join("\n");
}
