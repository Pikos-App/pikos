import { storageErrorUserMessage, toStorageError } from "@pikos/core";

/** What to show for a failed calendar action. Only an `Invalid` message is the backend's own: the
 *  sync crates write it for the person (a refused password, a revoked grant). Every other kind's
 *  message is error text that can quote a server's reply, so it gets the copy for its kind. */
export function calendarErrorMessage(e: unknown, verb: string): string {
  const error = toStorageError(e);
  if (error.kind === "Invalid" && error.message) return error.message;
  return storageErrorUserMessage(error, verb);
}
