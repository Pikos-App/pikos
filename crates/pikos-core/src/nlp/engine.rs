//! The parse pipeline: run every parser over the text, then refine.
//!
//! chrono-node's execution model, reproduced rather than reinvented, because
//! the order-dependent parts are what decide the result. Parsers run
//! independently and may all claim overlapping spans; the refiners then merge
//! ("april 18" + "3pm"), drop overlaps (longest wins), push implied dates
//! forward, and finally filter out the implausible. Change the order and the
//! same text parses differently.

use fancy_regex::{Captures, Regex};

use super::components::{ParsingComponents, ParsingResult, Reference};

pub struct Context<'a> {
    pub text: &'a str,
    pub reference: Reference,
    pub forward_date: bool,
}

/// A regex match, in the mutable form chrono-node's parsers expect: `index`
/// is theirs to move, which is how a parser says "I rejected this, resume
/// past it" rather than "resume one character on".
#[derive(Clone, Debug)]
pub struct MatchData {
    /// Byte offset into the full text.
    pub index: usize,
    /// Group 0 is the whole match; the rest are capture groups.
    pub groups: Vec<Option<String>>,
}

impl MatchData {
    pub(crate) fn from_captures(captures: &Captures<'_, str>, offset: usize) -> Self {
        let index = captures.get(0).expect("group 0 always matches").start() + offset;
        let groups = (0..captures.len())
            .map(|i| captures.get(i).map(|m| m.as_str().to_string()))
            .collect();
        Self { index, groups }
    }

    pub fn whole(&self) -> &str {
        self.groups[0].as_deref().unwrap_or_default()
    }

    pub fn group(&self, i: usize) -> Option<&str> {
        self.groups.get(i).and_then(|g| g.as_deref())
    }

    /// Drop the leading word-boundary group, shifting the rest down — the
    /// bookkeeping `AbstractParserWithWordBoundaryChecking` does so its
    /// subclasses can number groups from 1 without knowing about the boundary.
    fn strip_boundary_group(&self) -> Self {
        let header_len = self.group(1).unwrap_or_default().len();
        let whole = self.whole()[header_len..].to_string();
        let mut groups = vec![Some(whole)];
        groups.extend(self.groups.iter().skip(2).cloned());
        Self {
            index: self.index + header_len,
            groups,
        }
    }
}

pub enum Extracted {
    /// Nothing here. The parser may have moved `index` first, to skip ahead.
    None,
    /// Components only; the engine wraps them in a result spanning the match.
    Components(Box<ParsingComponents>),
    /// A result the parser built itself, because it claimed a span or an end
    /// the raw match does not describe.
    Result(Box<ParsingResult>),
}

impl Extracted {
    pub fn components(components: ParsingComponents) -> Self {
        Self::Components(Box::new(components))
    }

    pub fn result(result: ParsingResult) -> Self {
        Self::Result(Box::new(result))
    }
}

pub trait Parser {
    fn pattern(&self, context: &Context) -> &'static Regex;
    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted;
}

/// Run an extraction against a pattern that carries a leading word-boundary
/// group: strip the boundary, extract, then carry back any index the inner
/// extraction moved (its way of saying "resume past this candidate").
///
/// A blanket `impl Parser for T: BoundedParser` would read better, but it
/// would also overlap with every direct `impl Parser`, so the parsers that
/// need a boundary call this from their own `extract` instead.
pub fn extract_bounded(
    context: &Context,
    matched: &mut MatchData,
    inner_extract: impl FnOnce(&Context, &mut MatchData) -> Extracted,
) -> Extracted {
    let mut inner = matched.strip_boundary_group();
    let extracted = inner_extract(context, &mut inner);
    // The reference mutates the match in place, so the caller sees the
    // boundary-stripped span — both when deciding what the result claimed and
    // when resuming after a rejection.
    matched.index = inner.index;
    matched.groups[0] = inner.groups[0].clone();
    extracted
}

/// Build the boundary-wrapped source for a parser pattern. The boundary group
/// becomes group 1, which `strip_boundary_group` then removes.
pub fn with_left_boundary(inner: &str) -> String {
    format!("([^0-9A-Za-z_]|^){inner}")
}

/// Run one parser over the whole text, collecting every non-overlapping match
/// it claims. A rejected match resumes one character later; an accepted one
/// resumes after the text the parser said it consumed, which can be longer
/// than the regex match (a time range absorbs its "to 5pm" tail).
pub fn execute_parser(context: &Context, parser: &dyn Parser) -> Vec<ParsingResult> {
    let mut results = Vec::new();
    let pattern = parser.pattern(context);
    let original = context.text;
    let mut cursor = 0usize;

    while cursor <= original.len() {
        let Ok(Some(captures)) = pattern.captures(&original[cursor..]) else {
            break;
        };
        let mut matched = MatchData::from_captures(&captures, cursor);

        match parser.extract(context, &mut matched) {
            Extracted::None => {
                let Some(next) = advance(original, matched.index + 1) else {
                    break;
                };
                cursor = next;
            }
            Extracted::Components(components) => {
                let result =
                    ParsingResult::new(matched.index, matched.whole().to_string(), *components);
                let Some(next) = resume_after(original, &result) else {
                    results.push(result);
                    break;
                };
                cursor = next;
                results.push(result);
            }
            Extracted::Result(result) => {
                let result = *result;
                let Some(next) = resume_after(original, &result) else {
                    results.push(result);
                    break;
                };
                cursor = next;
                results.push(result);
            }
        }
    }

    results
}

/// Where to resume after accepting a result. `None` when the result claimed
/// nothing, which would otherwise re-match the same span forever.
fn resume_after(text: &str, result: &ParsingResult) -> Option<usize> {
    if result.text.is_empty() {
        return None;
    }
    advance(text, result.index + result.text.len())
}

/// Round a byte offset up to the next character boundary, or `None` when it
/// runs off the end. Guards against slicing a multi-byte character in half
/// when a parser rejects a match mid-way through one.
fn advance(text: &str, offset: usize) -> Option<usize> {
    if offset > text.len() {
        return None;
    }
    let mut boundary = offset;
    while boundary < text.len() && !text.is_char_boundary(boundary) {
        boundary += 1;
    }
    Some(boundary)
}

pub trait Refiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult>;
}

/// A refiner that merges adjacent results, deciding pair by pair. The merged
/// result stays in hand as the left-hand side, so three results can collapse
/// into one in a single pass.
pub trait MergingRefiner {
    fn should_merge(
        &self,
        context: &Context,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool;

    fn merge(
        &self,
        context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult;
}

pub fn refine_by_merging<T: MergingRefiner>(
    refiner: &T,
    context: &Context,
    results: Vec<ParsingResult>,
) -> Vec<ParsingResult> {
    if results.len() < 2 {
        return results;
    }
    let mut merged = Vec::new();
    let mut iterator = results.into_iter();
    let mut current = iterator.next().expect("length checked");

    for next in iterator {
        let between_start = current.index + current.text.len();
        let text_between = context
            .text
            .get(between_start..next.index)
            .unwrap_or_default();
        if refiner.should_merge(context, text_between, &current, &next) {
            let between = text_between.to_string();
            current = refiner.merge(context, &between, current, next);
        } else {
            merged.push(current);
            current = next;
        }
    }
    merged.push(current);
    merged
}

/// A refiner that only drops results.
pub trait Filter {
    fn is_valid(&self, context: &Context, result: &ParsingResult) -> bool;
}

pub fn refine_by_filtering<T: Filter>(
    filter: &T,
    context: &Context,
    results: Vec<ParsingResult>,
) -> Vec<ParsingResult> {
    results
        .into_iter()
        .filter(|result| filter.is_valid(context, result))
        .collect()
}
