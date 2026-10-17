// Mutants for Swift source, generated here because no Swift mutation tool builds on this machine's
// Xcode without installing one. A small operator set, applied only to code: comments, string
// literals and their interpolations are masked out first, and so are `#if DEBUG` blocks and
// `#Preview`s, which no shipped build runs.

/** Each operator's matches on a line of code. A comparison or an arithmetic sign needs a space on
 *  both sides, which Swift requires of a binary operator and which leaves generics, `->` and ranges
 *  alone. A string concatenation's `+` is left out: its `-` never compiles. */
const OPERATORS = [
  { mutator: "EqualityOperator", re: /(?<![=!<>])==(?!=)/g, to: () => "!=" },
  { mutator: "EqualityOperator", re: /!=(?!=)/g, to: () => "==" },
  {
    mutator: "EqualityOperator",
    re: /(?<=\s)(?:<=|>=|<|>)(?=\s)/g,
    to: (op) => ({ "<": ">=", "<=": ">", ">": "<=", ">=": "<" })[op],
  },
  { mutator: "LogicalOperator", re: /&&/g, to: () => "||" },
  { mutator: "LogicalOperator", re: /\|\|/g, to: () => "&&" },
  { mutator: "BooleanLiteral", re: /(?<![\w.])true\b/g, to: () => "false" },
  { mutator: "BooleanLiteral", re: /(?<![\w.])false\b/g, to: () => "true" },
  { mutator: "NegationRemoval", re: /(?<![\w)\]!?"'])!(?=[\w($.])/g, to: () => "" },
  { mutator: "ArithmeticOperator", re: /(?<=\s)\+=(?=\s)/g, to: () => "-=" },
  { mutator: "ArithmeticOperator", re: /(?<=\s)-=(?=\s)/g, to: () => "+=" },
  { mutator: "ArithmeticOperator", re: /(?<=\s)\+(?=\s)/g, to: () => "-", notBeside: '"' },
  { mutator: "ArithmeticOperator", re: /(?<=\s)-(?=\s)/g, to: () => "+" },
];

/** A one-line `guard` whose condition binds nothing, made to always pass, which removes its early
 *  exit. A binding guard can't be: the code after it needs the name. */
const GUARD = /\bguard\s+(.+?)\s+else\s*\{/;
const BINDS = /\b(?:let|var|case)\b|#available|#unavailable/;

/** Lines no mutant is placed on: debug-only checks, and the compiler directives themselves. */
const SKIP_LINE = /^\s*(?:#(?:if|elseif|else|endif)\b|import\s|assert\(|assertionFailure\()/;

/**
 * Which characters of `text` are code, as one flag per character. Swift nests block comments and
 * interpolates code into strings, which may hold strings of their own, so this keeps a stack rather
 * than a single state.
 */
export function codeMask(text) {
  const mask = new Uint8Array(text.length);
  const stack = [];
  const top = () => stack.at(-1);
  let i = 0;
  while (i < text.length) {
    const state = top();
    const c = text[i];
    const next = text[i + 1];
    if (!state || state.kind === "interp") {
      if (state?.kind === "interp") {
        if (c === "(") state.depth++;
        else if (c === ")" && --state.depth === 0) {
          stack.pop();
          i++;
          continue;
        }
      }
      if (c === "/" && next === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && next === "*") {
        stack.push({ kind: "block", depth: 1 });
        i += 2;
        continue;
      }
      const raw = /^(#*)("""|")/.exec(text.slice(i, i + 12));
      if (raw && (raw[1] || c === '"')) {
        stack.push({ hashes: raw[1], kind: "string", quote: raw[2] });
        i += raw[0].length;
        continue;
      }
      if (!state) mask[i] = 1;
      i++;
      continue;
    }
    if (state.kind === "block") {
      if (c === "/" && next === "*") {
        state.depth++;
        i += 2;
      } else if (c === "*" && next === "/") {
        if (--state.depth === 0) stack.pop();
        i += 2;
      } else i++;
      continue;
    }
    const escape = `\\${state.hashes}`;
    if (text.startsWith(escape, i)) {
      if (text[i + escape.length] === "(") {
        stack.push({ depth: 1, kind: "interp" });
        i += escape.length + 1;
      } else i += escape.length + 1;
      continue;
    }
    if (text.startsWith(state.quote + state.hashes, i)) {
      stack.pop();
      i += state.quote.length + state.hashes.length;
      continue;
    }
    i++;
  }
  return mask;
}

/** Line numbers, 1-based, inside a `#if DEBUG` block or a `#Preview { … }`. */
function unshippedLines(lines) {
  const out = new Set();
  let debugDepth = 0;
  let ifDepth = 0;
  const debugAt = [];
  let preview = 0;
  for (const [i, line] of lines.entries()) {
    const directive = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
    if (directive) {
      const [, kind, rest] = directive;
      if (kind === "if") {
        ifDepth++;
        if (/^\s*DEBUG\b/.test(rest)) debugAt.push(ifDepth);
      } else if (kind === "endif") {
        if (debugAt.at(-1) === ifDepth) debugAt.pop();
        ifDepth--;
      } else if (debugAt.at(-1) === ifDepth) debugAt.pop();
      debugDepth = debugAt.length;
    }
    if (preview === 0 && /^\s*#Preview\b/.test(line)) preview = 0.5;
    if (preview > 0) {
      for (const ch of line) {
        if (ch === "{") preview = Math.floor(preview) + 1;
        else if (ch === "}") preview--;
      }
      out.add(i + 1);
      if (preview <= 0) preview = 0;
      continue;
    }
    if (debugDepth > 0) out.add(i + 1);
  }
  return out;
}

/**
 * Every mutant on the given lines of a Swift file, as `{ line, start, end, mutator, original,
 * replacement }` with 1-based lines and columns and an exclusive end, the shape the e2e stage's
 * `apply` takes.
 */
export function swiftMutants(text, spans) {
  const lines = text.split("\n");
  const mask = codeMask(text);
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const unshipped = unshippedLines(lines);
  const isCode = (lineIndex, from, to) => {
    for (let k = offsets[lineIndex] + from; k < offsets[lineIndex] + to; k++) {
      if (!mask[k]) return false;
    }
    return true;
  };
  const mutants = [];
  for (const [a, b] of spans) {
    for (let n = a; n <= Math.min(b, lines.length); n++) {
      const text = lines[n - 1];
      if (unshipped.has(n) || SKIP_LINE.test(text)) continue;
      const add = (col, length, mutator, replacement) =>
        mutants.push({
          end: { column: col + length + 1, line: n },
          line: n,
          mutator,
          original: text.trim(),
          replacement,
          start: { column: col + 1, line: n },
        });
      for (const { mutator, notBeside, re, to } of OPERATORS) {
        for (const m of text.matchAll(re)) {
          if (!isCode(n - 1, m.index, m.index + m[0].length)) continue;
          if (notBeside) {
            const before = text.slice(0, m.index).trimEnd().at(-1);
            const after = text.slice(m.index + m[0].length).trimStart()[0];
            if (before === notBeside || after === notBeside) continue;
          }
          add(m.index, m[0].length, mutator, to(m[0]));
        }
      }
      const guard = GUARD.exec(text);
      if (guard && !BINDS.test(guard[1]) && isCode(n - 1, guard.index, guard.index + 5)) {
        add(guard.index + guard[0].indexOf(guard[1]), guard[1].length, "GuardCondition", "true");
      }
    }
  }
  return mutants;
}
