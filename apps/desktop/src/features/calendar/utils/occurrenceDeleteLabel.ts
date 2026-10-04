/** The delete control's name on one occurrence of a series. It removes that date alone, and
 *  on an active mirror only Pikos' copy: the calendar keeps the event. */
export function occurrenceDeleteLabel(locked: boolean): string {
  return locked ? "Remove this occurrence from Pikos" : "Delete this occurrence";
}
