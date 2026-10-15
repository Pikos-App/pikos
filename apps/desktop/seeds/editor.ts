// The writing surface: every node, mark and attribute the shared schema stores,
// documents long enough to feel in scrolling and search, text that breaks
// layouts (RTL, CJK, combining marks, unbroken tokens), search probes whose
// match sits in the title, the body or a tag, and a journal with real dates.
// Deliberately light on schedules.

import type { StorageAdapter } from "@pikos/core";
import { addDays, format, startOfDay } from "date-fns";

import {
  bold,
  br,
  bullets,
  code,
  codeBlock,
  doc,
  EMPTY_DOC,
  h1,
  h2,
  h3,
  hr,
  indentedH,
  indentedP,
  italic,
  link,
  type Node,
  ordered,
  orderedFrom,
  p,
  quote,
  strike,
  table,
  tasks,
  text,
  underline,
} from "./doc";
import { at, day, ensureFolder, instant, plantOnce, plantPage, random } from "./plant";

export async function seedEditor(adapter: StorageAdapter): Promise<void> {
  await plantOnce(adapter, "Editor seed marker", () => plantEditor(adapter));
}

async function plantEditor(adapter: StorageAdapter): Promise<void> {
  const reference = await ensureFolder(adapter, "Reference", { color: "#64748b" });
  const writing = await ensureFolder(adapter, "Writing", { color: "#0ea5e9" });
  const journal = await ensureFolder(adapter, "Journal", { color: "#f59e0b" });
  const edges = await ensureFolder(adapter, "Text edge cases", { color: "#ec4899" });

  await plantPage(adapter, {
    content: formattingReference(),
    folderId: reference.id,
    subtitle: "Every node and mark the editor stores",
    tags: ["reference"],
    title: "Formatting reference",
  });
  await plantPage(adapter, {
    content: listsReference(),
    folderId: reference.id,
    subtitle: "Nesting, numbering, checklists and Tab indents",
    tags: ["reference"],
    title: "Lists and indentation",
  });
  await plantPage(adapter, {
    content: tablesReference(),
    folderId: reference.id,
    subtitle: "Header rows, marks in cells, a table wider than the page",
    tags: ["reference"],
    title: "Tables",
  });
  await plantPage(adapter, {
    content: codeReference(),
    folderId: reference.id,
    subtitle: "Languages, no language, long lines, a long block",
    tags: ["reference", "dev"],
    title: "Code",
  });

  await plantPage(adapter, {
    content: longRead(),
    folderId: writing.id,
    subtitle: "About 6,000 words, for scrolling, find and search",
    tags: ["essay"],
    title: "Long read — On keeping notes you will actually reread",
  });
  await plantPage(adapter, {
    content: doc(
      h1("Pikos 0.5: your notes on your phone"),
      p(
        "Short version: ",
        bold("the iPhone app is here"),
        ", it reads the same file as your Mac, and nothing leaves your devices."
      ),
      quote(
        p("I wanted my notes in my pocket without handing them to anyone. — every early email")
      ),
      h2("What's in it"),
      bullets(
        "Today, Upcoming and your folders",
        {
          children: bullets("Capture from the lock screen", "Siri: “Add a page to Pikos”"),
          text: "Quick add, everywhere",
        },
        "Calendar sync over CalDAV"
      ),
      hr,
      p(
        "Read the ",
        link("full changelog", "https://pikos.app/changelog"),
        " or ",
        italic("just open the app"),
        "."
      )
    ),
    folderId: writing.id,
    start: at(1, 10),
    subtitle: "Draft for the blog and the release email",
    tags: ["writing", "release"],
    title: "Draft: announcement post",
  });
  await plantPage(adapter, {
    content: doc(
      h2("Design crit — list density"),
      p(bold("Present: "), "Jordan, Priya, Alex", br, bold("Decider: "), "Jordan"),
      table(
        ["Question", "Decision", "Owner"],
        ["Compact rows by default?", bold("No"), "Priya"],
        ["Show subtitles on phone?", "Only when set", "Alex"],
        ["Tag chips in the row", strike("Always"), "Jordan"]
      ),
      h3("Actions"),
      tasks(
        { checked: true, text: "Post screenshots in the channel" },
        {
          checked: false,
          children: tasks(
            { checked: false, text: "Measure at 320 pt" },
            { checked: true, text: "Dynamic Type XXL" }
          ),
          text: "Prototype the two densities",
        }
      )
    ),
    done: at(-2, 15),
    folderId: writing.id,
    subtitle: "Decisions table and actions with sub-tasks",
    tags: ["meeting", "design"],
    title: "Meeting notes — design crit",
  });
  await plantPage(adapter, {
    content: doc(
      h2("Weeknight dal"),
      p(italic("Serves 4. 35 minutes.")),
      h3("Ingredients"),
      bullets(
        "250 g red lentils",
        "1 onion, 3 garlic cloves, thumb of ginger",
        "1 tsp each: cumin, turmeric, garam masala",
        "400 ml coconut milk"
      ),
      h3("Method"),
      ordered(
        "Rinse the lentils until the water runs clear.",
        {
          children: bullets("Don't let the garlic brown."),
          text: "Soften the onion, then the garlic and ginger.",
        },
        "Add spices for a minute, then lentils, coconut milk and 500 ml water.",
        "Simmer 20 minutes, stirring now and then."
      ),
      p("Finish with lime.", br, "Rice or flatbread.")
    ),
    folderId: writing.id,
    subtitle: "Ordered steps with a nested note, and hard breaks",
    tags: ["recipe", "food"],
    title: "Recipe — weeknight dal",
  });

  await plantJournal(adapter, journal.id);
  await plantTextEdgeCases(adapter, edges.id);

  await plantPage(adapter, {
    content: doc(
      p(
        link(
          "https://www.inkandswitch.com/local-first/",
          "https://www.inkandswitch.com/local-first/"
        )
      )
    ),
    tags: ["reading"],
    title: "Local-first software (link to read)",
  });
  await plantPage(adapter, {
    content: doc(
      tasks(
        { checked: false, text: "Passport" },
        { checked: false, text: "Chargers" },
        { checked: true, text: "Adapter" }
      )
    ),
    start: day(3),
    title: "Packing list",
  });
  await plantPage(adapter, { title: "Call the garage about the MOT" });
}

/** The page that holds every node, mark and attribute once. Wide plants it too. */
export function formattingReference(): string {
  return doc(
    h1("Heading 1"),
    h2("Heading 2"),
    h3("Heading 3"),
    p(
      "Plain, ",
      bold("bold"),
      ", ",
      italic("italic"),
      ", ",
      underline("underline"),
      ", ",
      strike("strike"),
      ", ",
      code("inline code"),
      ", ",
      text("bold italic", "bold", "italic"),
      " and a ",
      link("link", "https://pikos.app"),
      "."
    ),
    p("A line", br, "broken with Shift-Enter", br, "twice."),
    indentedP(1, "Indented once with Tab."),
    indentedP(2, "Indented twice."),
    indentedH(2, 1, "An indented heading"),
    quote(p("A quotation, with ", italic("emphasis"), "."), bullets("and a list inside it")),
    hr,
    bullets("Bullet", { children: bullets("Nested bullet"), text: "Bullet with a child" }),
    ordered("First", "Second", "Third"),
    tasks({ checked: true, text: "A finished task" }, { checked: false, text: "An open task" }),
    codeBlock("typescript", 'const greeting: string = "hello";\nconsole.log(greeting);'),
    table(["Column", "Another"], ["cell", bold("bold cell")]),
    p()
  );
}

function listsReference(): string {
  const deep = (level: number): Node =>
    bullets(
      level === 4 ? "Level 4, the deepest" : { children: deep(level + 1), text: `Level ${level}` }
    );
  return doc(
    h2("Nested bullets"),
    deep(1),
    h2("Numbered, starting at 7"),
    orderedFrom(7, "Seven", "Eight", {
      children: ordered("Nine point one", "Nine point two"),
      text: "Nine",
    }),
    h2("Mixed nesting"),
    ordered({
      children: bullets("a bullet under a number", {
        children: tasks({ checked: false, text: "and a task under that" }),
        text: "deeper",
      }),
      text: "Number",
    }),
    h2("Checklist with sub-tasks"),
    tasks(
      {
        checked: false,
        children: tasks(
          { checked: true, text: "Book the venue" },
          { checked: false, text: "Send invitations" }
        ),
        text: "Plan the party (half done)",
      },
      {
        checked: true,
        children: tasks({ checked: true, text: "Everything under it" }),
        text: "Done with done children",
      }
    ),
    h2("Tab indents"),
    ...[0, 1, 2, 3, 4].map((level) => indentedP(level, `Paragraph at indent ${level}.`))
  );
}

function tablesReference(): string {
  return doc(
    h2("A small table"),
    table(
      ["Plan", "Price", "Notes"],
      ["Free", "£0", italic("forever")],
      ["Pro", bold("£4 / month"), link("compare", "https://pikos.app/pricing")],
      ["Empty cell", "", "↖ that one"]
    ),
    h2("Wider than the page"),
    table(
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Total"],
      ["2h", "3h", "1h", "4h", "2h", "0h", "0h", "12h"],
      ["Standups", "Planning", "Review", "Workshop", "Retro", "—", "—", "5 meetings"]
    ),
    h2("Long text in a cell"),
    table(
      ["Decision", "Why"],
      [
        "SQLite on device",
        "One file per workspace is something a person can hold, back up and move without asking anyone. The alternatives were all a server by another name.",
      ]
    )
  );
}

function codeReference(): string {
  const longBlock = Array.from(
    { length: 120 },
    (_, i) => `  step${i + 1}: ${i % 7 === 0 ? "await flush();" : `total += ${i};`}`
  ).join("\n");
  return doc(
    p("Inline: call ", code("plantPage(adapter, spec)"), " and read ", code("page.id"), "."),
    codeBlock("rust", 'pub fn greet(name: &str) -> String {\n    format!("hello, {name}")\n}'),
    codeBlock(
      "sql",
      "SELECT title FROM pages\nWHERE status = 'done'\nORDER BY completed_at DESC\nLIMIT 20;"
    ),
    codeBlock("swift", 'struct Greeting: View {\n    var body: some View { Text("hello") }\n}'),
    codeBlock(null, "No language selected.\n    Indentation is kept."),
    codeBlock("typescript", `const oneLongLine = "${"x".repeat(220)}";`),
    h3("A 120-line block"),
    codeBlock("javascript", `async function run() {\n${longBlock}\n}`)
  );
}

export const SENTENCES = [
  "A note earns its keep the second time you read it, not the first time you write it.",
  "Most systems fail quietly: nothing breaks, you just stop opening them.",
  "The cheapest capture is the one you make before the thought has finished forming.",
  "Titles are for the person searching in six months, who will not remember your clever phrasing.",
  "A folder is a promise about where something will be, and promises should be few.",
  "Tags are better at describing than at organising.",
  "Rereading is where the connections happen, and it only happens if the note is findable.",
  "Every review that feels like a chore is a sign the system asks too much.",
  "Dates turn a vague intention into something the calendar can argue with.",
  "The inbox is not a place to live; it is a place to pass through.",
  "Writing a summary at the top costs a minute and saves the reread.",
  "A long document wants headings the way a long road wants signposts.",
  "You do not need to decide where a note belongs before you write it down.",
  "Search is only as good as the words you actually used.",
  "Completed tasks are a record, and records are worth keeping.",
  "The best template is the one you stopped noticing you use.",
  "A daily page gives the scattered things a place to land.",
  "When a list grows past a screen, it has usually become two lists.",
  "Links between notes are cheap to make and expensive to maintain, so make the ones you will follow.",
  "Some notes are for thinking, and those can be deleted once the thinking is done.",
];

function longRead(): string {
  const rng = random(7);
  const paragraph = (): Node => p(rng.sample(SENTENCES, rng.int(5, 8)).join(" "));
  const blocks: Node[] = [
    p(italic("A seed document: long enough to scroll, find in page and search across.")),
  ];
  for (let section = 1; section <= 12; section++) {
    blocks.push(h2(`${section}. ${rng.pick(SENTENCES).replace(/[.,:;].*$/, "")}`));
    for (let i = 0; i < 6; i++) {
      blocks.push(paragraph());
      if (i === 2) blocks.push(h3("An aside"), quote(p(rng.pick(SENTENCES))));
    }
    if (section % 3 === 0) blocks.push(bullets(...rng.sample(SENTENCES, 4)));
  }
  return doc(...blocks);
}

async function plantJournal(adapter: StorageAdapter, folderId: string): Promise<void> {
  const rng = random(21);
  const moods = ["Focused", "Scattered", "Tired but fine", "Good day", "Slow start", "Calm"];
  for (let offset = -13; offset <= 0; offset++) {
    const date = addDays(startOfDay(new Date()), offset);
    const written = at(offset, 21, rng.int(0, 45));
    await plantPage(adapter, {
      content: doc(
        p(bold(rng.pick(moods)), " — ", rng.pick(SENTENCES)),
        tasks(
          { checked: true, text: "Walk" },
          { checked: rng.chance(0.6), text: "Read 20 minutes" },
          { checked: rng.chance(0.3), text: "No phone after 10" }
        ),
        p(rng.pick(SENTENCES))
      ),
      createdAt: instant(written),
      folderId,
      tags: ["journal"],
      title: format(date, "EEEE d MMMM"),
      updatedAt: instant(offset === 0 ? at(0, 21, 50) : written),
    });
  }
}

async function plantTextEdgeCases(adapter: StorageAdapter, folderId: string): Promise<void> {
  const edge = (
    title: string,
    content: string,
    extra: { subtitle?: string; tags?: string[] } = {}
  ) => plantPage(adapter, { content, folderId, title, ...extra });

  await edge(
    "A very long title that keeps going well past the width of any row, any card and any calendar block, to see where it truncates, whether it wraps in the editor header, and what the widget does with it on a small phone",
    doc(p("The title is 220 characters."))
  );
  await edge(
    "Unbroken_token_" + "abcdefghij".repeat(10),
    doc(
      p("https://example.com/" + "a-very-long-path-segment/".repeat(8) + "?query=" + "x".repeat(60))
    )
  );
  await edge(
    "🌱 Garden plan 🍅🥒🌶️",
    doc(p("Tomatoes by the fence 🍅, courgettes in the raised bed 🥒. 👩🏽‍🌾")),
    {
      tags: ["🌱garden", "home"],
    }
  );
  await edge(
    "日本語のメモ — 買い物リスト",
    doc(
      p("牛乳、卵、パン。明日の朝までに買う。"),
      p("中文：记得给妈妈打电话。"),
      p("한국어: 회의는 3시에 시작합니다.")
    )
  );
  await edge(
    "ملاحظات الاجتماع",
    doc(
      p("اجتماع الفريق يوم الأحد الساعة العاشرة."),
      p("עברית: פגישה ביום ראשון בעשר."),
      p("Mixed: the file is called ", code("تقرير.pdf"), " and it is 12 MB.")
    )
  );
  await edge(
    "Tiếng Việt — ghi chú",
    doc(p("Họp nhóm lúc 3 giờ chiều. Zoë's café: naïve résumé, jalapeño, Ångström."))
  );
  await edge("Untitled draft", EMPTY_DOC);
  await edge("Subtitle only", EMPTY_DOC, {
    subtitle:
      "A subtitle long enough to need truncating everywhere it appears: in the page list row, under the title in the editor header, and on a calendar block that is only fifteen minutes tall.",
  });
  await edge("Many tags", doc(p("Fifteen tags, including two that differ only by case.")), {
    tags: [
      "work",
      "Work",
      "planning",
      "q4",
      "urgent-ish",
      "follow-up",
      "meeting",
      "1:1",
      "deep work",
      "reading",
      "finance",
      "health",
      "home",
      "travel",
      "someday",
    ],
  });
  await edge("Search probe: quokka", doc(p("The match for this probe is in the title only.")), {
    tags: ["search-probe"],
  });
  await edge(
    "Search probe: body",
    doc(p("A marsupial, the quokka, appears only here in the body.")),
    {
      tags: ["search-probe"],
    }
  );
  await edge("Search probe: tag", doc(p("The match for this probe is the tag.")), {
    tags: ["search-probe", "quokka"],
  });
}
