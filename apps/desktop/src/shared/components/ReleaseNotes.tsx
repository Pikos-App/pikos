import { Fragment, type ReactNode } from "react";

/**
 * Renders the narrow markdown subset used in release notes — headings (as
 * compact section labels), bullet lists, **bold**, and `inline code`. The notes
 * are authored by us to a convention (not arbitrary user input), so the subset
 * is deliberately small. Text is rendered as React children (never
 * dangerouslySetInnerHTML), so it can't inject markup.
 */

type Block =
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;

function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ items: bullets, kind: "bullets" });
      bullets = [];
    }
  };

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flushParagraph();
      flushBullets();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushBullets();
      blocks.push({ kind: "heading", text: (heading[1] ?? "").trim() });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push((bullet[1] ?? "").trim());
      continue;
    }

    flushBullets();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushBullets();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (match[2] !== undefined) {
      nodes.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(
        <code className="rounded bg-muted px-1 py-0.5 text-xs" key={key++}>
          {match[3]}
        </code>
      );
    }
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function ReleaseNotes({ body }: { body: string }) {
  const blocks = parseBlocks(body);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          return (
            <p
              className="text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0 [&:not(:first-child)]:mt-3"
              key={i}
            >
              {block.text}
            </p>
          );
        }
        if (block.kind === "bullets") {
          return (
            <ul className="list-disc space-y-1 pl-4" key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Fragment>{renderInline(block.text)}</Fragment>
          </p>
        );
      })}
    </div>
  );
}
