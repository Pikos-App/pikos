// The hand-written types and the ones generated from the Rust wire structs must
// describe the same shape. Assignability is checked in both directions, so a field
// added, removed, renamed or re-nulled on either side fails to compile — which is
// the guarantee that lets `types.ts` and `pikos-db` be edited independently without
// drifting. `exactOptionalPropertyTypes` makes optional-vs-nullable a difference too.
//
// A failure here is not a test to relax: one of the two sides is lying about what
// the backend sends. Fix that side, then regenerate with scripts/gen-ts-bindings.sh.

import type { Folder as GFolder } from "./generated/Folder";
import type { Page as GPage } from "./generated/Page";
import type { PageRecurrenceRule as GRule } from "./generated/PageRecurrenceRule";
import type { PageReminder as GReminder } from "./generated/PageReminder";
import type { PageSchedule as GSchedule } from "./generated/PageSchedule";
import type { PageSummary as GSummary } from "./generated/PageSummary";
import type { SearchResult as GSearchResult } from "./generated/SearchResult";
import type {
  Folder,
  Page,
  PageRecurrenceRule,
  PageReminder,
  PageSchedule,
  PageSummary,
  SearchResult,
} from "./types";

const page: GPage = {} as Page;
const pageBack: Page = {} as GPage;
const folder: GFolder = {} as Folder;
const folderBack: Folder = {} as GFolder;
const schedule: GSchedule = {} as PageSchedule;
const scheduleBack: PageSchedule = {} as GSchedule;
const rule: GRule = {} as PageRecurrenceRule;
const ruleBack: PageRecurrenceRule = {} as GRule;
const reminder: GReminder = {} as PageReminder;
const reminderBack: PageReminder = {} as GReminder;
const summary: GSummary = {} as PageSummary;
const summaryBack: PageSummary = {} as GSummary;
const result: GSearchResult = {} as SearchResult;
const resultBack: SearchResult = {} as GSearchResult;

void [
  page,
  pageBack,
  folder,
  folderBack,
  schedule,
  scheduleBack,
  rule,
  ruleBack,
  reminder,
  reminderBack,
  summary,
  summaryBack,
  result,
  resultBack,
];
