#!/usr/bin/env node
// Checks a pull request's title and description against the shape in the pr-description skill.
//
//   node scripts/check-pr-body.mjs --title "<title>" <body-file | ->
//
// CI runs it on every pull request, so a description that drifts fails where it was written.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The headings a description may use, in the order they appear. Only the first and Evidence are required. */
export const SECTIONS = ["What changes", "Migrations", "Evidence", "Try by hand"];
const REQUIRED = ["What changes", "Evidence"];
const TYPES = "feat|fix|docs|refactor|test|perf|chore|build|ci";
const TITLE = new RegExp(`^(?:(?:${TYPES})(?:\\([a-z0-9-]+\\))?|release): [a-z0-9]`);
const MAX_BULLET_WORDS = 60;
const MAX_BULLETS = 7;

const withoutCode = (text) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "code");

function sentences(text) {
  const plain = withoutCode(text).replace(/\b(?:e\.g|i\.e|vs|etc)\./gi, "x").replace(/\s+/g, " ").trim();
  return plain ? plain.split(/(?<=[.!?])\s+(?=[A-Z0-9"(*])/).length : 0;
}

/** Every way the title and body miss the shape, as plain sentences. Empty when they fit. */
export function prBodyProblems(title, body) {
  const problems = [];
  if (!TITLE.test(title ?? "")) {
    problems.push(`The title "${title}" isn't \`type(scope): subject\` with a lowercase subject. Types: ${TYPES.replaceAll("|", ", ")}.`);
  }

  const text = (body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();
  const parts = text.split(/^## +(.+?)\s*$/m);
  const opener = parts[0].trim();
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) sections.push({ name: parts[i], content: parts[i + 1].trim() });

  if (!opener) {
    problems.push("The description has to open with a sentence or two saying what the pull request is for, before any heading.");
  } else {
    if (/^(?:#|[-*] |\d+\. |\|)/m.test(opener)) {
      problems.push("The opening is prose only: move headings, lists and tables into a section.");
    }
    if (sentences(opener) > 2) problems.push(`The opening runs ${sentences(opener)} sentences. Keep it to two; the detail goes under "What changes".`);
    if (/`/.test(opener)) problems.push("The opening names code. Say what the pull request is for in plain words, and leave identifiers to the sections.");
  }

  if (/^# /m.test(text)) problems.push("Use only `##` section headings, never `#`.");
  const names = sections.map((s) => s.name);
  for (const name of names) {
    if (!SECTIONS.includes(name)) problems.push(`"## ${name}" isn't one of the sections: ${SECTIONS.join(", ")}.`);
  }
  for (const name of REQUIRED) {
    if (!names.includes(name)) problems.push(`"## ${name}" is missing.`);
  }
  const known = names.filter((n) => SECTIONS.includes(n));
  const sorted = [...known].sort((a, b) => SECTIONS.indexOf(a) - SECTIONS.indexOf(b));
  if (known.join() !== sorted.join()) problems.push(`The sections go in this order: ${SECTIONS.join(", ")}.`);
  if (new Set(names).size !== names.length) problems.push("A section appears twice.");

  for (const { name, content } of sections) {
    if (!content) problems.push(`"## ${name}" is empty. Leave out an optional section rather than leave it blank.`);
  }

  const changes = sections.find((s) => s.name === "What changes")?.content ?? "";
  const bullets = changes.split("\n").filter((l) => /^[-*] /.test(l));
  if (bullets.length > MAX_BULLETS) {
    problems.push(`"## What changes" has ${bullets.length} bullets, over ${MAX_BULLETS}. Group related changes under one claim; past that it's a tour of the diff.`);
  }
  for (const line of bullets) {
    const words = withoutCode(line).split(/\s+/).length - 1;
    if (words > MAX_BULLET_WORDS) {
      problems.push(`A "What changes" bullet runs ${words} words, over ${MAX_BULLET_WORDS}: "${line.slice(2, 60)}…". Say the change and its reason; what it means for a person goes in the release notes.`);
    }
  }

  const evidence = sections.find((s) => s.name === "Evidence")?.content ?? "";
  if (evidence && /^(?:all )?(?:tests? pass(?:es)?|ci (?:is |was )?green|verify (?:is |was )?green)[.!]?$/i.test(evidence)) {
    problems.push(`"## Evidence" only says the checks passed, which the checks already show. Say what was run and what it showed.`);
  }

  const prose = withoutCode(text).split("\n").filter((l) => !l.trim().startsWith("|"));
  if (prose.some((l) => /\s—\s|\s--\s/.test(l))) problems.push("An em dash is used as punctuation. Use a period or a comma.");

  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const at = process.argv.indexOf("--title");
  const source = process.argv.at(-1);
  if (at === -1 || process.argv.length < at + 3 || source === process.argv[at + 1]) {
    console.error('usage: node scripts/check-pr-body.mjs --title "<title>" <body-file | ->');
    process.exit(2);
  }
  const body = readFileSync(source === "-" ? 0 : source, "utf8");
  const problems = prBodyProblems(process.argv[at + 1], body);
  if (problems.length) {
    console.error(`✗ The pull request doesn't follow .claude/skills/pr-description/SKILL.md:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("✓ The pull request's title and description fit the shape.");
}
