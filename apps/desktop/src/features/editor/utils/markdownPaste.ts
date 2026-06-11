// Markdown paste detection.
//
// tiptap-markdown converts pasted markdown via ProseMirror's `clipboardTextParser`,
// which only runs when the clipboard has NO `text/html` (prosemirror-view:
// `asText = !!text && (plainText || inCode || !html)`). The apps people copy
// markdown from — VS Code, browsers, ChatGPT — attach `text/html` too, so
// ProseMirror takes the HTML path and the markdown is never converted.
//
// To fix that we intercept paste ourselves and force markdown interpretation,
// but only when the plain text actually looks like markdown — otherwise we'd
// clobber genuine rich-text/HTML paste (e.g. an article copied from the web,
// whose plain-text form carries no markdown syntax).

/** Patterns that signal intentional markdown syntax in pasted plain text. */
const MARKDOWN_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading: "# Title"
  /^\s*>\s+\S/m, // blockquote: "> quote"
  /^\s*[-*+]\s+\[[ xX]\]\s/m, // task item: "- [ ] todo"
  /^\s*[-*+]\s+\S/m, // bullet list: "- item"
  /^\s*\d+[.)]\s+\S/m, // ordered list: "1. item"
  /^\s*(?:```|~~~)/m, // fenced code block
  /^\s*(?:\*\s*){3,}$/m, // thematic break: "***"
  /^\s*(?:-\s*){3,}$/m, // thematic break: "---"
  /^\s*(?:_\s*){3,}$/m, // thematic break: "___"
  /^\|.*\|\s*$/m, // table row: "| a | b |"
  /\*\*[^\s*][^*]*\*\*/, // bold: "**text**"
  /__[^\s_][^_]*__/, // bold: "__text__"
  /(?:^|[^*\w])\*[^\s*][^*]*\*(?:[^*\w]|$)/, // italic: "*text*"
  /`[^`\n]+`/, // inline code: "`code`"
  /!?\[[^\]]+\]\([^)\s]+\)/, // link or image: "[text](url)"
];

/**
 * Heuristic: does this plain text contain markdown block/inline syntax worth
 * converting on paste? Conservative — bare prose and bare URLs return false so
 * normal paste handling (including link-on-paste) is preserved.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 2) return false;
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}
