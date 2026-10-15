//! Convert Markdown → ProseMirror/Tiptap JSON, as the app's importer does.
//!
//! The reference is the desktop's `convertMarkdownToTiptap`: Tiptap with
//! `tiptap-markdown`, which needs a DOM and so can't run in the CLI or on the phone.
//! This port is graded against `tests/corpus/markdown-import.json`, which the
//! desktop suite generates from that reference and re-checks on every run, so a
//! Tiptap upgrade that changes an answer fails there before it can drift from here.
//!
//! Where the reference mangles an input (a list mixing tasks and bullets, a heading
//! inside a list item, code inside a link, which loses the link) or the editor has
//! no node for it (raw HTML, an image inside text), this refuses rather than copy
//! the damage or guess. The corpus marks those cases `refused`.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};
use serde_json::{json, Map, Value};

/// Why an input was refused, in words for whoever wrote it.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused(pub String);

pub fn markdown_to_prosemirror(markdown: &str) -> Result<Value, Refused> {
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let events: Vec<(Event, std::ops::Range<usize>)> = Parser::new_ext(markdown, options)
        .into_offset_iter()
        .collect();
    let mut reader = Reader {
        source: markdown,
        events,
        at: 0,
    };
    let mut blocks = reader.blocks(Scope::Top)?;
    if blocks.is_empty() {
        blocks.push(json!({ "type": "paragraph" }));
    } else if blocks.last().and_then(|b| b["type"].as_str()) != Some("paragraph") {
        // Tiptap's trailing node: a document never ends on anything but a paragraph.
        blocks.push(json!({ "type": "paragraph" }));
    }
    Ok(json!({ "type": "doc", "content": blank_line_paragraphs(markdown, blocks) }))
}

/// The importer's `insertBlankLineParagraphs`, quirks included: it counts every run of
/// blank lines in the source, nested ones too, and spends them on the top-level gaps in
/// order, one blank line wherever the count runs out.
fn blank_line_paragraphs(markdown: &str, blocks: Vec<Value>) -> Vec<Value> {
    if blocks.len() < 2 {
        return blocks;
    }
    let mut separators = Vec::new();
    let mut run = 0usize;
    for c in markdown.chars().chain(std::iter::once('\0')) {
        if c == '\n' {
            run += 1;
        } else {
            if run >= 2 {
                separators.push(run - 1);
            }
            run = 0;
        }
    }
    let last = blocks.len() - 1;
    let mut out = Vec::new();
    for (i, block) in blocks.into_iter().enumerate() {
        out.push(block);
        if i < last {
            for _ in 0..separators.get(i).copied().unwrap_or(1) {
                out.push(json!({ "type": "paragraph" }));
            }
        }
    }
    out
}

/// Where a run of blocks sits, which decides what may appear in it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Top,
    Quote,
    ListItem,
}

struct Reader<'a> {
    source: &'a str,
    events: Vec<(Event<'a>, std::ops::Range<usize>)>,
    at: usize,
}

fn refuse<T>(why: &str) -> Result<T, Refused> {
    Err(Refused(why.to_string()))
}

const HTML: &str = "raw HTML has no place in a Pikos page — write it as markdown instead.";

impl<'a> Reader<'a> {
    fn peek(&self) -> Option<&Event<'a>> {
        self.events.get(self.at).map(|(e, _)| e)
    }

    fn next(&mut self) -> Option<(Event<'a>, std::ops::Range<usize>)> {
        let item = self.events.get(self.at).cloned();
        self.at += 1;
        item
    }

    /// Blocks until the end tag that closes `scope`, which is left unconsumed.
    fn blocks(&mut self, scope: Scope) -> Result<Vec<Value>, Refused> {
        let mut out = Vec::new();
        while let Some(event) = self.peek() {
            if matches!(event, Event::End(_)) {
                break;
            }
            let (event, _) = self.next().expect("peeked");
            match event {
                Event::Start(Tag::Paragraph) => out.push(self.paragraph(scope)?),
                Event::Start(Tag::Heading { level, .. }) => {
                    if scope == Scope::ListItem {
                        return refuse("a heading inside a list item doesn't survive the editor — put it above the list.");
                    }
                    out.push(self.heading(level)?);
                }
                Event::Start(Tag::CodeBlock(kind)) => out.push(self.code_block(kind)?),
                Event::Start(Tag::BlockQuote(_)) => {
                    let content = self.blocks(Scope::Quote)?;
                    self.next();
                    out.push(json!({ "type": "blockquote", "content": content }));
                }
                Event::Start(Tag::List(start)) => out.push(self.list(start)?),
                Event::Start(Tag::Table(_)) => out.push(self.table()?),
                Event::Rule => out.push(json!({ "type": "horizontalRule" })),
                Event::Html(_) | Event::InlineHtml(_) | Event::Start(Tag::HtmlBlock) => {
                    return refuse(HTML)
                }
                // A tight list item holds its text with no paragraph around it.
                Event::Text(_)
                | Event::Code(_)
                | Event::SoftBreak
                | Event::HardBreak
                | Event::Start(
                    Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. },
                ) if scope == Scope::ListItem => {
                    self.at -= 1;
                    let content = self.inline_until(|e| {
                        matches!(
                            e,
                            Event::End(_)
                                | Event::Start(
                                    Tag::List(_) | Tag::BlockQuote(_) | Tag::CodeBlock(_)
                                )
                        )
                    })?;
                    out.push(paragraph_of(content));
                }
                _ => return refuse("this markdown uses something a Pikos page can't hold."),
            }
        }
        Ok(out)
    }

    fn paragraph(&mut self, scope: Scope) -> Result<Value, Refused> {
        if let Some(Event::Start(Tag::Image { .. })) = self.peek() {
            let image = self.image(scope)?;
            return match self.next() {
                Some((Event::End(TagEnd::Paragraph), _)) => Ok(image),
                _ => refuse("an image has to sit on a line of its own."),
            };
        }
        let content = self.inline_until(|e| matches!(e, Event::End(TagEnd::Paragraph)))?;
        self.next();
        Ok(paragraph_of(content))
    }

    fn image(&mut self, scope: Scope) -> Result<Value, Refused> {
        let Some((
            Event::Start(Tag::Image {
                dest_url, title, ..
            }),
            _,
        )) = self.next()
        else {
            unreachable!("peeked an image");
        };
        if scope != Scope::Top {
            return refuse("an image has to sit on a line of its own, outside lists and quotes.");
        }
        let mut alt = String::new();
        loop {
            match self.next() {
                Some((Event::End(TagEnd::Image), _)) => break,
                Some((Event::Text(t) | Event::Code(t), _)) => alt.push_str(&t),
                Some((Event::SoftBreak | Event::HardBreak, _)) => alt.push(' '),
                Some(_) => {}
                None => break,
            }
        }
        Ok(json!({
            "type": "image",
            "attrs": {
                "src": normalize_url(&dest_url),
                "alt": alt,
                "title": none_if_empty(&title),
                "width": null,
                "height": null,
            }
        }))
    }

    fn heading(&mut self, level: HeadingLevel) -> Result<Value, Refused> {
        let content = self.inline_until(|e| matches!(e, Event::End(TagEnd::Heading(_))))?;
        self.next();
        let level = level as u8;
        // The editor has three levels; a deeper heading arrives as plain text.
        if level > 3 {
            return Ok(paragraph_of(content));
        }
        let mut node = json!({ "type": "heading", "attrs": { "level": level } });
        if !content.is_empty() {
            node["content"] = Value::Array(content);
        }
        Ok(node)
    }

    fn code_block(&mut self, kind: CodeBlockKind) -> Result<Value, Refused> {
        let language = match kind {
            CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(str::to_string),
            CodeBlockKind::Indented => None,
        };
        let mut text = String::new();
        loop {
            match self.next() {
                Some((Event::End(TagEnd::CodeBlock), _)) | None => break,
                Some((Event::Text(t), _)) => text.push_str(&t),
                Some(_) => {}
            }
        }
        if text.ends_with('\n') {
            text.pop();
        }
        let mut node = json!({ "type": "codeBlock", "attrs": { "language": language } });
        if !text.is_empty() {
            node["content"] = json!([{ "type": "text", "text": text }]);
        }
        Ok(node)
    }

    fn list(&mut self, start: Option<u64>) -> Result<Value, Refused> {
        let mut items = Vec::new();
        let mut tight = true;
        let mut tasks = Vec::new();
        while let Some((event, _)) = self.next() {
            match event {
                Event::End(TagEnd::List(_)) => break,
                Event::Start(Tag::Item) => {
                    let (content, checked, loose) = self.item()?;
                    tight &= !loose;
                    tasks.push(checked);
                    items.push(content);
                }
                _ => return refuse("this list holds something a Pikos list can't."),
            }
        }
        let task_count = tasks.iter().filter(|t| t.is_some()).count();
        if task_count > 0 {
            if start.is_some() {
                return refuse(
                    "a numbered list can't hold checkboxes — use - [ ] for a task list.",
                );
            }
            if task_count != tasks.len() {
                return refuse("a list mixes tasks and plain items — give each its own list.");
            }
            let content: Vec<Value> = items
                .into_iter()
                .zip(tasks)
                .map(|(content, checked)| {
                    json!({ "type": "taskItem", "attrs": { "checked": checked == Some(true) }, "content": content })
                })
                .collect();
            return Ok(json!({ "type": "taskList", "content": content }));
        }
        let content: Vec<Value> = items
            .into_iter()
            .map(|content| json!({ "type": "listItem", "content": content }))
            .collect();
        Ok(match start {
            Some(n) => json!({
                "type": "orderedList",
                "attrs": { "tight": tight, "start": n, "type": null },
                "content": content,
            }),
            None => {
                json!({ "type": "bulletList", "attrs": { "tight": tight }, "content": content })
            }
        })
    }

    /// An item's blocks, its checkbox if it has one, and whether it was written loose.
    fn item(&mut self) -> Result<(Vec<Value>, Option<bool>, bool), Refused> {
        let loose = matches!(self.peek(), Some(Event::Start(Tag::Paragraph)));
        let mut checked = None;
        let at_marker = if loose { self.at + 1 } else { self.at };
        if let Some((Event::TaskListMarker(c), _)) = self.events.get(at_marker) {
            checked = Some(*c);
            self.events.remove(at_marker);
        }
        let mut content = self.blocks(Scope::ListItem)?;
        self.next();
        if content.is_empty() {
            content.push(json!({ "type": "paragraph" }));
        }
        Ok((content, checked, loose))
    }

    fn table(&mut self) -> Result<Value, Refused> {
        let mut rows = Vec::new();
        while let Some((event, _)) = self.next() {
            match event {
                Event::End(TagEnd::Table) => break,
                Event::Start(Tag::TableHead) => {
                    let cells = self.cells("tableHeader", TagEnd::TableHead)?;
                    rows.push(json!({ "type": "tableRow", "content": cells }));
                }
                Event::Start(Tag::TableRow) => {
                    let cells = self.cells("tableCell", TagEnd::TableRow)?;
                    rows.push(json!({ "type": "tableRow", "content": cells }));
                }
                _ => return refuse("this table holds something a Pikos table can't."),
            }
        }
        Ok(json!({ "type": "table", "content": rows }))
    }

    fn cells(&mut self, kind: &str, end: TagEnd) -> Result<Vec<Value>, Refused> {
        let mut cells = Vec::new();
        while let Some((event, _)) = self.next() {
            match event {
                Event::End(e) if e == end => break,
                Event::Start(Tag::TableCell) => {
                    let content =
                        self.inline_until(|e| matches!(e, Event::End(TagEnd::TableCell)))?;
                    self.next();
                    cells.push(json!({
                        "type": kind,
                        "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null },
                        "content": [paragraph_of(content)],
                    }));
                }
                _ => return refuse("this table holds something a Pikos table can't."),
            }
        }
        Ok(cells)
    }

    /// Inline nodes up to the first event `stop` accepts, which is left unconsumed.
    fn inline_until(&mut self, stop: impl Fn(&Event) -> bool) -> Result<Vec<Value>, Refused> {
        let mut out: Vec<Value> = Vec::new();
        let mut marks: Vec<Value> = Vec::new();
        // A strike opened with one tilde, which the reference leaves as literal tildes.
        let mut literal_strikes: Vec<bool> = Vec::new();
        while let Some(event) = self.peek() {
            if stop(event) && marks.is_empty() && literal_strikes.is_empty() {
                break;
            }
            let (event, range) = self.next().expect("peeked");
            match event {
                Event::Text(t) => push_text(&mut out, &t, &marks),
                Event::Code(t) => {
                    if marks.iter().any(|m| m["type"] == "link") {
                        return refuse("code inside a link loses the link in the editor — keep the link text plain.");
                    }
                    // The code mark excludes every other mark.
                    push_text(&mut out, &t, &[json!({ "type": "code" })]);
                }
                Event::SoftBreak | Event::HardBreak => out.push(json!({ "type": "hardBreak" })),
                Event::Start(Tag::Strong) => marks.push(json!({ "type": "bold" })),
                Event::Start(Tag::Emphasis) => marks.push(json!({ "type": "italic" })),
                Event::Start(Tag::Strikethrough) => {
                    if self.source[range.start..].starts_with("~~") {
                        marks.push(json!({ "type": "strike" }));
                        literal_strikes.push(false);
                    } else {
                        push_text(&mut out, "~", &marks);
                        literal_strikes.push(true);
                    }
                }
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    ..
                }) => {
                    let href = match link_type {
                        LinkType::Email => format!("mailto:{dest_url}"),
                        _ => normalize_url(&dest_url),
                    };
                    marks.push(json!({
                        "type": "link",
                        "attrs": {
                            "href": href,
                            "target": "_blank",
                            "rel": "noopener noreferrer nofollow",
                            "class": null,
                            "title": none_if_empty(&title),
                        }
                    }));
                }
                Event::End(TagEnd::Strikethrough) => {
                    if literal_strikes.pop() == Some(true) {
                        push_text(&mut out, "~", &marks);
                    } else {
                        marks.pop();
                    }
                }
                Event::End(TagEnd::Strong | TagEnd::Emphasis | TagEnd::Link) => {
                    marks.pop();
                }
                Event::Html(_) | Event::InlineHtml(_) => return refuse(HTML),
                Event::Start(Tag::Image { .. }) => {
                    return refuse("an image has to sit on a line of its own.")
                }
                _ => return refuse("this markdown uses something a Pikos page can't hold."),
            }
        }
        Ok(out)
    }
}

fn paragraph_of(content: Vec<Value>) -> Value {
    if content.is_empty() {
        json!({ "type": "paragraph" })
    } else {
        json!({ "type": "paragraph", "content": content })
    }
}

fn none_if_empty(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s.to_string())
    }
}

/// The editor's mark order, which is how ProseMirror sorts a node's marks.
fn mark_rank(mark: &Value) -> usize {
    match mark["type"].as_str() {
        Some("link") => 0,
        Some("bold") => 1,
        Some("code") => 2,
        Some("italic") => 3,
        Some("strike") => 4,
        _ => 5,
    }
}

/// Append text, merging into the previous node when its marks match, as ProseMirror does.
fn push_text(out: &mut Vec<Value>, text: &str, marks: &[Value]) {
    if text.is_empty() {
        return;
    }
    let mut sorted = marks.to_vec();
    sorted.sort_by_key(mark_rank);
    if let Some(last) = out.last_mut() {
        let same = last["type"] == "text"
            && last
                .get("marks")
                .map_or(sorted.is_empty(), |m| *m == Value::Array(sorted.clone()));
        if same {
            let joined = format!("{}{text}", last["text"].as_str().unwrap_or(""));
            last["text"] = Value::String(joined);
            return;
        }
    }
    let mut node = Map::new();
    node.insert("type".into(), "text".into());
    if !sorted.is_empty() {
        node.insert("marks".into(), Value::Array(sorted));
    }
    node.insert("text".into(), text.into());
    out.push(Value::Object(node));
}

/// markdown-it's link normalisation: percent-encode what a URL can't carry, and leave an
/// escape that is already there alone.
fn normalize_url(url: &str) -> String {
    const KEEP: &[u8] = b";/?:@&=+$,-_.!~*'()#";
    let bytes = url.as_bytes();
    let mut out = String::with_capacity(url.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let escaped = b == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit();
        if b.is_ascii_alphanumeric() || KEEP.contains(&b) || escaped {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
        i += 1;
    }
    out
}

#[cfg(test)]
#[path = "markdown_import_tests.rs"]
mod tests;
