import { StorageError } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { calendarErrorMessage } from "./calendarErrorMessage";

describe("calendarErrorMessage", () => {
  it("shows the backend's own words for something the person can fix", () => {
    const refused = new StorageError(
      "Invalid",
      "The server refused the sign-in. Check the username and app password."
    );

    expect(calendarErrorMessage(refused, "connecting the account")).toBe(
      "The server refused the sign-in. Check the username and app password."
    );
  });

  it("blames the connection only when the network failed", () => {
    const offline = new StorageError("Network", "network: CalDAV network error: dns error");
    const locked = new StorageError("Db", "db error: database is locked");

    expect(calendarErrorMessage(offline, "syncing the account")).toMatch(/network|connection/i);
    expect(calendarErrorMessage(locked, "syncing the account")).not.toMatch(/network|connection/i);
    expect(calendarErrorMessage(locked, "syncing the account")).not.toContain("locked");
  });
});
