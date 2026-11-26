import { isPerson } from "./person";

const RELEASE = "https://github.com/pikos-app/pikos/releases/latest/download/";

const INSTALLERS: Record<string, string> = {
  appimage: "Pikos-linux-x86_64.AppImage",
  deb: "Pikos-linux-x86_64.deb",
  mac: "Pikos-macos-universal.dmg",
};

/**
 * Redirects a /get/ link to the installer on GitHub, recording the download first when a person
 * asked. GitHub's own count includes scrapers, so this is the human figure and GitHub's the ceiling.
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
