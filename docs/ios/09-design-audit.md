# Pikos iOS: a design audit of every screen and widget

A pass over the phone app and its widgets, judged from screenshots rather than
from code: every screen in light, the main ones in dark and at the largest
accessibility text size, and each widget at each of its sizes. It follows the
earlier review (`08-design-review.md`) and does not reopen what that settled.

## How the screens were seen

The screen tour (`PikosUITests/Sources/ScreenTour.swift`, run by
`scripts/ios-screen-tour.sh`) gained three sections:

- **10 Widgets.** No test can photograph a home screen, so a debug build
  launched with `-PikosWidgetGallery <board>` shows the widgets' own views at
  each family's point size over sample entries: `list`, `now`, `list-edge`
  (long titles, an empty list, a failure, a long folder name), `now-edge`, and
  `lock`. Add `-PikosWidgetGalleryDark YES` for the dark theme. The widget
  views are compiled into the debug app only; release builds exclude them.
  Sizes are the HIG's for a 6.1-inch iPhone, and the lock screen is an
  approximation, since its vibrant rendering belongs to the system.
- **11 States.** The error alert, and an empty Inbox, Upcoming, day, month,
  search and trash.
- **12 Essentials.** One shot of each screen a person spends time in, meant to
  be run again after switching the simulator to dark or to the largest text
  size.

## What was fixed

**Widgets now look like the app.**

- The ground is the app's warm white and near-black, not the system's
  blue-grey fill.
- The checkbox is the app's square, not a circle, stroked red for urgent and
  amber for high as the list does. Medium and low used to be yellow and blue,
  which the app has never drawn.
- Times beside a title were teal, because a link tints a hierarchical colour.
  They are now the list's grey.
- "Now", "Free for …" and Focus use the darker teal that passes contrast as
  text; the bright one is kept for the plus.
- A countdown reads "Free for 37 minutes", not "38 min, 24 sec" that wrapped
  the small widget's headline and ticked every second.
- A wrapped title starts its second line under its first, not centred.
- "Can't read your notes" says "pages", the app's word.

**Text at the largest sizes no longer breaks.**

- The page header no longer draws title, subtitle and byline over one another;
  the editor gave it half the height it needed.
- A row moves its date under the title at accessibility sizes. Beside it, the
  title was one letter wide.
- The bar, the select-mode verbs, the pane headers, the calendar and the Up
  next tray stop growing at the largest non-accessibility size. Each is fixed
  geometry, and past that size "List" became "Li…", "Select" broke into
  "Se-lect" and the hour labels stacked a letter to a line.

**One look for sheets and forms.** Settings, Calendars, Repeat, Folders and
the CalDAV sheet now label their sections in the tracked small capitals the
list and the switcher already use, and every switch is the app's teal rather
than the system green.

**Smaller fixes.**

- The select-mode verbs' labels sit on one line; the taller calendar symbol
  pushed "When" lower than the rest.
- A section heading in select mode could be selected like a page.
- Menu items and choices are in sentence case like the rest of the app:
  "Move to folder", "Stop repeating", "This weekend", "Next week", "Pick a
  date…", "No date", "No priority", "Select all".
- The Repeat sheet's lone "Ends" row lost a heading that repeated its own
  label, and "On a Day" became "On a day".
- Trash, Folders and Calendars used the system's grey and orange; they use the
  tokens.

## Settled after the audit, and built

The audit's judgement calls went to Alex. What he chose:

- **One way to write a time.** Every time the phone and its widgets show reads
  `3:00pm`, through one formatter shared by the app, the widgets and the
  reminder text, the same rule the desktop already follows. An hour gridline
  keeps `3 PM`, which is too narrow for the minutes.
- **Overdue red and due-soon amber pass contrast as text.** The overdue red is
  one darker step everywhere, which also fixes the white label on a Delete
  button. Amber gets a separate darker step for text only; the bright amber
  stays for flags and checkbox strokes, where a darker one would merge with
  the red for a red-green colour-blind reader. Both apps take both.
- **The palette's red moved to rose,** so a red folder's dot no longer reads
  as overdue. A folder that stored the old red is drawn, and marked in the
  picker, as the new one, without rewriting anything stored.
- **Widgets.** An empty Now widget offers the plus, as the large size does.
  The small Now widget shows Focus as an icon so its reason has room. The
  small List widget shows two pages with two lines each instead of three cut
  at fifteen characters. (`round2-light/10-02 Gallery now, light.png`,
  `round2-light/10-03 Gallery list-edge, light.png`,
  `round2-light/10-04 Gallery now-edge, light.png`)
- **The largest text sizes.** The page header folds its byline to the folder
  and More, and quick add wraps its chips instead of scrolling them out of
  sight. (`round2-xxxl/12-11 Page.png`, `round2-xxxl/12-09 Quick add.png`)
- **Up next stays hidden over Today** until a page is lifted, and **the plus
  keeps the darker teal**: the code was right in both, and the design now
  says so.

## Writing space above the keyboard

Every place you type was measured with the keyboard up at the default text
size: points from the top of what you're typing to the first thing that isn't
your text (the keyboard, the formatting bar, or a control below the field). The
numbers come from the tour's own measurements (`13 Writing`), not from reading
screenshots by eye.

| Where                            | Before | After | What is above or below the text                                                                                              |
| -------------------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| A page's document                | 378pt  | 378pt | Back, timer and the page menu above; the formatting bar below. The header already hides while the document has the keyboard. |
| A page's title                   | 463pt  | 463pt | Back, timer and the page menu.                                                                                               |
| A page's subtitle                | 423pt  | 423pt | The title, which is the page's own text.                                                                                     |
| Quick add, with a sentence typed | 290pt  | 376pt | Cancel and Add above; the date, priority and folder chips below. The grammar hint now shows only before the first word.      |
| Rename                           | 35pt   | 35pt  | The system's rename alert: one line for one line of title.                                                                   |

No sheet has a note field. Tags, a folder's name and a typed date are single
lines inside forms.

## Still open

- **The widgets have not been seen on a real lock screen or a tinted home
  screen.** The gallery approximates the system's vibrant rendering, and the
  widgets draw in the app's own colours, which the system recolours in tinted
  and clear modes. Check the checkboxes and counts on a device before release.
  (`after1/10-21 Gallery lock screen.png`)
- **At the largest text size, quick add's date chip runs past the screen's
  edge** instead of truncating. The chips now wrap and the sheet no longer
  widens, but the chip's own label still overflows.
  (`round3-xxxl/12-09 Quick add.png`)
- **Medium and low priority read as words in yellow and blue,** which, like
  the amber before it, falls under the contrast bar as text on white. Not
  decided here.
