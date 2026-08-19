//! Human-readable rendering. `--json` bypasses all of this and prints the
//! pikos-db types verbatim, so these are the plain-text surface only.

use pikos_db::{Page, PageSummary, SearchResponse};

pub fn priority_label(p: i64) -> &'static str {
    match p {
        1 => "Urgent",
        2 => "High",
        3 => "Medium",
        4 => "Low",
        _ => "None",
    }
}

pub fn status_box(status: &str) -> &'static str {
    if status == "done" {
        "[x]"
    } else {
        "[ ]"
    }
}

pub fn render_summary(p: &PageSummary) -> String {
    let title = if p.title.is_empty() {
        "(untitled)"
    } else {
        &p.title
    };
    let mut meta: Vec<String> = Vec::new();
    if let Some(d) = &p.scheduled_start {
        meta.push(format!("due:{d}"));
    }
    if p.priority != 0 {
        meta.push(format!("p:{}", priority_label(p.priority)));
    }
    if !p.tags.is_empty() {
        meta.push(
            p.tags
                .iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    let tail = if meta.is_empty() {
        String::new()
    } else {
        format!("   {}", meta.join("  "))
    };
    format!("{} {title}{tail}   id:{}", status_box(&p.status), p.id)
}

pub fn render_summary_list(pages: &[PageSummary], empty: &str) -> String {
    if pages.is_empty() {
        return empty.to_string();
    }
    pages
        .iter()
        .map(render_summary)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_page(page: &Page) -> String {
    let title = if page.title.is_empty() {
        "(untitled)"
    } else {
        &page.title
    };
    let mut lines = vec![title.to_string()];
    let mut meta = vec![
        format!("status:{}", page.status),
        format!("priority:{}", priority_label(page.priority)),
    ];
    if let Some(d) = &page.scheduled_start {
        meta.push(format!("due:{d}"));
    }
    if !page.tags.is_empty() {
        meta.push(
            page.tags
                .iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    lines.push(meta.join("  "));
    lines.push(format!("id:{}", page.id));
    lines.push(format!(
        "created:{}  updated:{}",
        page.created_at, page.updated_at
    ));
    if let Some(body) = page.content_text.as_deref() {
        let body = body.trim();
        if !body.is_empty() {
            lines.push(String::new());
            lines.push(body.to_string());
        }
    }
    lines.join("\n")
}

pub fn render_search(resp: &SearchResponse) -> String {
    if resp.results.is_empty() {
        let note = if resp.completed_count > 0 {
            format!(
                " ({} completed hidden — use --include-completed)",
                resp.completed_count
            )
        } else {
            String::new()
        };
        return format!("No matches.{note}");
    }
    let mut lines: Vec<String> = resp
        .results
        .iter()
        .map(|r| {
            let title = if r.title.is_empty() {
                "(untitled)"
            } else {
                &r.title
            };
            let snippet = if r.excerpt.is_empty() {
                &r.content_preview
            } else {
                &r.excerpt
            };
            let head = format!(
                "{} {title}  ({})   id:{}",
                status_box(&r.status),
                r.match_source,
                r.id
            );
            if snippet.is_empty() {
                head
            } else {
                format!("{head}\n    {snippet}")
            }
        })
        .collect();
    if resp.completed_count > 0 {
        lines.push(format!(
            "\n{} completed hidden — use --include-completed to show.",
            resp.completed_count
        ));
    }
    lines.join("\n")
}

pub fn print_json<T: serde::Serialize>(value: &T) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("serialize output")
    );
}
