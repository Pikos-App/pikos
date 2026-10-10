import { parseISO } from "date-fns";
import { describe, expect, it } from "vitest";

import { downloadResponse } from "./download";

const NOW = parseISO("2026-10-04T12:00:00Z");
const PERSON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const SCRAPER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function get(installer: string, { agent = PERSON, method = "GET" } = {}) {
  const recorded: string[] = [];
  const response = downloadResponse(
    new Request(`https://pikos.app/get/${installer}`, { headers: { "user-agent": agent }, method }),
    installer,
    NOW,
    (name) => recorded.push(name),
  );
  return { recorded, response };
}

describe("downloadResponse", () => {
  it("records a person's download and sends them to the installer", () => {
    const { recorded, response } = get("mac");
    expect(recorded).toEqual(["mac"]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/pikos-app/pikos/releases/latest/download/Pikos-macos-universal.dmg",
    );
  });

  it("sends each Linux format to its own file", () => {
    expect(get("appimage").response.headers.get("location")).toMatch(/Pikos-linux-x86_64\.AppImage$/);
    expect(get("deb").response.headers.get("location")).toMatch(/Pikos-linux-x86_64\.deb$/);
  });

  it("redirects a scraper without recording it", () => {
    const { recorded, response } = get("appimage", { agent: SCRAPER });
    expect(recorded).toEqual([]);
    expect(response.status).toBe(302);
  });

  it("does not record a HEAD request", () => {
    expect(get("mac", { method: "HEAD" }).recorded).toEqual([]);
  });

  it("refuses a name that is not an installer, including inherited ones", () => {
    for (const name of ["windows", "toString", "__proto__"]) {
      const { recorded, response } = get(name);
      expect(response.status).toBe(404);
      expect(recorded).toEqual([]);
    }
  });
});
