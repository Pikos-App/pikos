/**
 * The newest Pikos version anyone can download, read once per build, so notes and posts for a
 * version not yet published stay out of the site. A release merges to `main`, which the host
 * builds on every push, before it is tagged, built and published; the release workflow's publish
 * then rebuilds the site with them in.
 *
 * Read from where the download buttons point, `/releases/latest`, whose redirect names the tag.
 * Not the REST API: unauthenticated it allows 60 requests an hour per address, and a build host
 * shares its address. `PIKOS_PUBLISHED_VERSION` stands in for it in a local build or a test.
 *
 * A build that can't find out fails rather than guessing. Guessing low hides a published release's
 * notes; guessing high is the leak this exists to stop. A failed build leaves the last deploy up.
 */
const LATEST = "https://github.com/pikos-app/pikos/releases/latest";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function readPublishedVersion(
  env: Record<string, string | undefined> = process.env,
  get: Fetch = fetch
): Promise<string> {
  const pinned = env["PIKOS_PUBLISHED_VERSION"];
  if (pinned) return pinned;

  const response = await get(LATEST, { redirect: "manual" });
  const tag = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.headers.get("location") ?? "");
  if (!tag) {
    throw new Error(
      `${LATEST} didn't redirect to a release tag (status ${response.status}), so the build can't tell which release notes are published. Set PIKOS_PUBLISHED_VERSION to build anyway.`
    );
  }
  return tag[1];
}

let cached: Promise<string> | undefined;

export function publishedVersion(): Promise<string> {
  cached ??= readPublishedVersion();
  return cached;
}

/** Whether `version` (X.Y.Z) is at or below the published one, so its notes and post can show. */
export function isOut(version: string, published: string): boolean {
  const parts = (v: string) => v.split(".").map(Number);
  const [a, b] = [parts(version), parts(published)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}
