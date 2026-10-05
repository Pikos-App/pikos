import { isPerson } from "./person";

const RELEASE = "https://github.com/pikos-app/pikos/releases/latest/download/";

/** Each installer the download page offers, by the name its /get/ link uses. */
const INSTALLERS: Record<string, string> = {
  appimage: "Pikos-linux-x86_64.AppImage",
  deb: "Pikos-linux-x86_64.deb",
  mac: "Pikos-macos-universal.dmg",
};

/**
 * The response to a /get/ link: a redirect to the installer on GitHub, recording the download first
 * when a person asked for it. GitHub's own count includes every scraper that follows the link, so
 * this is the human figure and GitHub's is the ceiling.
 */
export function downloadResponse(
  request: Request,
  installer: string,
  now: Date,
  record: (installer: string) => void,
): Response {
  if (!Object.hasOwn(INSTALLERS, installer)) return new Response("Not found", { status: 404 });
  if (request.method === "GET" && isPerson(request, now)) record(installer);
  return Response.redirect(RELEASE + INSTALLERS[installer], 302);
}
