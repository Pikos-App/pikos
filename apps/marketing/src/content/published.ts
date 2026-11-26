/**
 * The newest Pikos version anyone can download, read once per build, so notes and posts for an
 * unpublished version stay out of the site: a release merges to `main` and builds before it is
 * tagged and published.
 *
 * Read from `/releases/latest`, whose redirect names the tag, not the REST API, which allows an
 * unauthenticated address 60 requests an hour and a build host shares its address.
 * `PIKOS_PUBLISHED_VERSION` stands in for it locally and in tests.
 *
 * A build that can't find out fails rather than guessing: guessing low hides a published
 * release's notes, and guessing high leaks an unpublished one. A failed build leaves the last
 * deploy up.
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

export function isOut(version: string, published: string): boolean {
  const parts = (v: string) => v.split(".").map(Number);
  const [a, b] = [parts(version), parts(published)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}
