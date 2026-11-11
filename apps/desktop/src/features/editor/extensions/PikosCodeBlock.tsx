import type { Attributes } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  markdown: "Markdown",
  objectivec: "Objective-C",
  perl: "Perl",
  php: "PHP",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Shell session",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  xml: "HTML / XML",
  yaml: "YAML",
};

const PICKER_LANGUAGES = Object.keys(LANGUAGE_LABELS);

/**
 * How sure the highlighter must be before a paste labels a block. Real code
 * scores 4 to 7 on it, while a sentence of prose or a one-line assignment
 * scores 2 and gets guessed as VB.NET or INI.
 */
const MIN_GUESS_RELEVANCE = 4;

export function guessLanguage(code: string): string | null {
  const result = lowlight.highlightAuto(code, { subset: PICKER_LANGUAGES });
  const isConfident = (result.data?.relevance ?? 0) >= MIN_GUESS_RELEVANCE;

  return isConfident ? (result.data?.language ?? null) : null;
}

function pastedRanges(transactions: readonly Transaction[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];

  transactions.forEach((tr, index) => {
    const isPaste = tr.getMeta("paste") === true || tr.getMeta("uiEvent") === "paste";
    if (!isPaste) return;

    const later = transactions.slice(index + 1);
    tr.mapping.maps.forEach((map, step) => {
      const rest = tr.mapping.slice(step + 1);
      map.forEach((_oldFrom, _oldTo, from, to) => {
        let start = rest.map(from, -1);
        let end = rest.map(to, 1);
        for (const next of later) {
          start = next.mapping.map(start, -1);
          end = next.mapping.map(end, 1);
        }
        ranges.push({ from: start, to: end });
      });
    });
  });

  return ranges;
}

function CodeBlockView({ editor, node, updateAttributes }: ReactNodeViewProps) {
  const language = (node.attrs["language"] as string | null) ?? "";
  const isUnlisted = language !== "" && !(language in LANGUAGE_LABELS);

  return (
    <NodeViewWrapper as="pre" className="editor-code-block">
      <select
        aria-label="Code language"
        className="code-block-language"
        contentEditable={false}
        disabled={!editor.isEditable}
        onChange={(event) => updateAttributes({ language: event.target.value || null })}
        value={language}
      >
        <option value="">Plain text</option>
        {isUnlisted && <option value={language}>{language}</option>}
        {PICKER_LANGUAGES.map((id) => (
          <option key={id} value={id}>
            {LANGUAGE_LABELS[id]}
          </option>
        ))}
      </select>
      <NodeViewContent<"code"> as="code" />
    </NodeViewWrapper>
  );
}

/**
 * The code block, coloured by its language, with a picker for it. A block with
 * no language stays uncoloured rather than auto-detected on every render, so
 * the colours always match what the picker says. Pasting into a block with no
 * language labels it with a guess, which the picker shows and can undo.
 */
export const PikosCodeBlock = CodeBlockLowlight.extend({
  // The base block stores `defaultLanguage` as the attribute's default, which
  // would write "plaintext" into every new block and its exported fence.
  addAttributes() {
    const parent: Attributes = this.parent?.() ?? {};
    return { ...parent, language: { ...parent["language"], default: null } };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },

  addProseMirrorPlugins() {
    const name = this.name;
    const guessOnPaste = new Plugin({
      appendTransaction(transactions, _oldState, state) {
        const ranges = pastedRanges(transactions);
        if (ranges.length === 0) return null;

        const tr = state.tr;
        for (const { from, to } of ranges) {
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name !== name) return true;

            const hasLanguage = Boolean(node.attrs["language"]);
            const guess = hasLanguage ? null : guessLanguage(node.textContent);
            if (guess) tr.setNodeAttribute(pos, "language", guess);

            return false;
          });
        }

        return tr.docChanged ? tr : null;
      },
      key: new PluginKey("codeBlockGuessOnPaste"),
    });

    return [...(this.parent?.() ?? []), guessOnPaste];
  },
}).configure({
  defaultLanguage: "plaintext",
  HTMLAttributes: { class: "editor-code-block" },
  lowlight,
});
