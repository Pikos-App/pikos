//! An event description as the plain text a page body holds.
//!
//! Google's web editor saves a description as HTML, while one written by an import or another
//! API client stays plain, and the Calendar API returns either as written. Read raw, the HTML
//! shows in the page as markup.

/// The description as text: HTML from Google's web editor rendered to the text Google shows for
/// it, anything else unchanged.
pub(crate) fn description_text(raw: &str) -> String {
    if looks_like_html(raw) {
        html_to_text(raw)
    } else {
        raw.to_string()
    }
}

/// Google's editor writes every line break as `<br>` and every `&` as `&amp;`, so one of its marks
/// is in any description it saved. Plain text gets the benefit of the doubt: a literal
/// `<passport>` or a bare `&` is someone's text, not markup.
fn looks_like_html(s: &str) -> bool {
    const MARKS: [&str; 9] = [
        "<br>", "<br/>", "<br />", "</", "&amp;", "&lt;", "&gt;", "&nbsp;", "&#",
    ];
    let lower = s.to_ascii_lowercase();
    MARKS.iter().any(|mark| lower.contains(mark))
}

fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut link: Option<(usize, String)> = None;
    let mut rest = html;
    while let Some(c) = rest.chars().next() {
        if c == '<' {
            if let Some(end) = rest.find('>') {
                apply_tag(&rest[1..end], &mut out, &mut link);
                rest = &rest[end + 1..];
                continue;
            }
        } else if c == '&' {
            if let Some((decoded, len)) = entity(rest) {
                out.push(decoded);
                rest = &rest[len..];
                continue;
            }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// What a tag leaves in the text. A link keeps its text, and its address too when the text
/// doesn't already say it, since a body has no other way to carry it.
fn apply_tag(tag: &str, out: &mut String, link: &mut Option<(usize, String)>) {
    let closing = tag.starts_with('/');
    let name = tag
        .trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match (name.as_str(), closing) {
        ("br", _) | ("p" | "div" | "li", true) => out.push('\n'),
        ("li", false) => out.push_str("- "),
        ("a", false) => *link = href(tag).map(|h| (out.len(), h)),
        ("a", true) => {
            if let Some((start, address)) = link.take() {
                if out[start..].trim() != address {
                    out.push_str(&format!(" ({address})"));
                }
            }
        }
        _ => {}
    }
}

fn href(tag: &str) -> Option<String> {
    let at = tag.find("href=")? + "href=".len();
    let value = &tag[at..];
    let quote = value.chars().next().filter(|q| *q == '"' || *q == '\'')?;
    let end = value[1..].find(quote)?;
    Some(html_to_text(&value[1..=end]))
}

/// The character an entity at the start of `s` stands for, and how many bytes it spans.
fn entity(s: &str) -> Option<(char, usize)> {
    let (end, _) = s.char_indices().take(12).find(|(_, c)| *c == ';')?;
    let name = &s[1..end];
    let decoded = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" | "#39" => '\'',
        "nbsp" => ' ',
        _ => {
            let code = match name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => name.strip_prefix('#')?.parse().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some((decoded, end + 1))
}

#[cfg(test)]
#[path = "description_tests.rs"]
mod description_tests;
