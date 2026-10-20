//! Merging a page body that changed on two sides since both started from the same one.
//!
//! The unit is a top-level block of the Tiptap document. Each side is lined up against the body
//! both started from, and a run of blocks only one side changed takes that side; a run both changed
//! keeps both, the stored side first, so nothing typed is lost and the clash shows on the page.
//! Not a conflict copy, which leaves a second page to reconcile by hand, and not a character-level
//! merge, which needs a CRDT under the editor and a different way of storing bodies.

use serde_json::Value;

/// Past this many block pairs, a changed middle stretch is treated as one run rather than lined up
/// block by block. Lining up costs a cell per pair, so a paste of thousands of blocks against
/// thousands more would hold a save for seconds; as one run, a stretch both sides changed keeps
/// both whole, which loses nothing.
const MAX_ALIGNED_PAIRS: usize = 4_000_000;

fn blocks(doc: &Value) -> &[Value] {
    doc.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// For each block of `base`, the index of the block in `other` it lines up with, if any: a longest
/// common subsequence, so the matches only ever move forward through both.
fn line_up(base: &[Value], other: &[Value]) -> Vec<Option<usize>> {
    let mut matched = vec![None; base.len()];

    let prefix = base.iter().zip(other).take_while(|(a, b)| a == b).count();
    for (i, slot) in matched.iter_mut().enumerate().take(prefix) {
        *slot = Some(i);
    }

    let suffix = base[prefix..]
        .iter()
        .rev()
        .zip(other[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    for k in 0..suffix {
        matched[base.len() - 1 - k] = Some(other.len() - 1 - k);
    }

    let a = &base[prefix..base.len() - suffix];
    let b = &other[prefix..other.len() - suffix];
    let is_too_large = a.len().saturating_mul(b.len()) > MAX_ALIGNED_PAIRS;
    if a.is_empty() || b.is_empty() || is_too_large {
        return matched;
    }

    let width = b.len() + 1;
    let mut longest = vec![0u32; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            longest[i * width + j] = if a[i] == b[j] {
                longest[(i + 1) * width + j + 1] + 1
            } else {
                longest[(i + 1) * width + j].max(longest[i * width + j + 1])
            };
        }
    }

    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            matched[prefix + i] = Some(prefix + j);
            i += 1;
            j += 1;
        } else if longest[(i + 1) * width + j] >= longest[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }

    matched
}

/// The merge of one run between two blocks both sides kept as they were.
fn merge_run(out: &mut Vec<Value>, base: &[Value], theirs: &[Value], mine: &[Value]) {
    let is_theirs_unchanged = theirs == base;
    let is_mine_unchanged = mine == base;

    if is_theirs_unchanged || theirs == mine {
        out.extend_from_slice(mine);
    } else if is_mine_unchanged {
        out.extend_from_slice(theirs);
    } else {
        out.extend_from_slice(theirs);
        out.extend_from_slice(mine);
    }
}

/// Merges `mine` and `theirs`, both edited from `base`. `theirs` is the body stored now, so on a
/// clash its blocks come first. The document's own attributes are `mine`'s.
pub fn merge_bodies(base: &Value, theirs: &Value, mine: &Value) -> Value {
    let (base_blocks, their_blocks, my_blocks) = (blocks(base), blocks(theirs), blocks(mine));
    let to_theirs = line_up(base_blocks, their_blocks);
    let to_mine = line_up(base_blocks, my_blocks);

    let mut merged = Vec::with_capacity(their_blocks.len().max(my_blocks.len()));
    let (mut b, mut t, mut m) = (0, 0, 0);
    loop {
        let kept_by_both =
            (b..base_blocks.len()).find_map(|i| Some((i, to_theirs[i]?, to_mine[i]?)));
        let (b_end, t_end, m_end) =
            kept_by_both.unwrap_or((base_blocks.len(), their_blocks.len(), my_blocks.len()));

        merge_run(
            &mut merged,
            &base_blocks[b..b_end],
            &their_blocks[t..t_end],
            &my_blocks[m..m_end],
        );

        if kept_by_both.is_none() {
            break;
        }

        merged.push(base_blocks[b_end].clone());
        (b, t, m) = (b_end + 1, t_end + 1, m_end + 1);
    }

    let mut doc = mine.clone();
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("content".to_string(), Value::Array(merged));
    }
    doc
}

#[cfg(test)]
#[path = "body_merge_tests.rs"]
mod tests;
