// Markdown paste detection. tiptap-markdown converts pasted markdown via `clipboardTextParser`, which
// runs only when the clipboard has no `text/html` (prosemirror-view: `asText = !!text && (plainText ||
// inCode || !html)`). VS Code, browsers and ChatGPT attach `text/html`, so the markdown is never
// converted. We intercept paste and force markdown only when the plain text looks like markdown, so
// genuine rich-text paste (an article whose plain text carries no syntax) is untouched.

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

/** Does this plain text contain markdown worth converting on paste? Conservative: bare prose and bare URLs return false so link-on-paste is preserved. */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 2) return false;
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}
