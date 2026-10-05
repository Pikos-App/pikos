import { differenceInWeeks, parseISO } from "date-fns";

const AUTOMATED = /bot|crawl|spider|slurp|preview|fetch|scan|headless|compatible/i;

/**
 * Chrome ships a major version every four weeks and updates itself, so one more than a year behind
 * is almost always a script with a pinned user agent. On the first day the site counted visitors,
 * scrapers posing as Chrome 124 to 131 outnumbered people several times over. The current version
 * is reckoned from a known release rather than from the day's traffic, which scripts can outnumber.
 */
const CHROME_RELEASE = { major: 141, on: "2025-09-30" };
const CHROME_YEAR_BEHIND = 12;
/** Safari before 15 means a device too old for any current OS, and it is a common scanner default. */
const SAFARI_OLDEST = 15;

/** Whether a request comes from a person in a current browser, judged by its user agent alone. */
export function isPerson(request: Request, now: Date): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  if (!agent.startsWith("Mozilla/") || AUTOMATED.test(agent)) return false;
  const chrome = /Chrome\/(\d+)/.exec(agent);
  if (chrome) {
    const weeks = differenceInWeeks(now, parseISO(CHROME_RELEASE.on));
    const current = CHROME_RELEASE.major + Math.floor(weeks / 4);
    return Number(chrome[1]) >= current - CHROME_YEAR_BEHIND;
  }
  const safari = /Version\/(\d+)\S* (?:Mobile\/\S+ )?Safari/.exec(agent);
  return !safari || Number(safari[1]) >= SAFARI_OLDEST;
}
