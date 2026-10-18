//! Which of the page actions both apps' menus share a page offers, and why one is withheld.
//!
//! The desktop asks `pageActions` in `@pikos/core` the same question; both are graded against
//! `packages/core/src/pages/pageActions.cases.json`, so the two menus can't drift apart unnoticed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageAction {
    Rename,
    MoveToFolder,
    ClearDate,
    Delete,
}

impl PageAction {
    pub const ALL: [PageAction; 4] = [
        PageAction::Rename,
        PageAction::MoveToFolder,
        PageAction::ClearDate,
        PageAction::Delete,
    ];

    /// The name the desktop's table uses.
    pub fn key(self) -> &'static str {
        match self {
            PageAction::Rename => "rename",
            PageAction::MoveToFolder => "move-to-folder",
            PageAction::ClearDate => "clear-date",
            PageAction::Delete => "delete",
        }
    }
}

/// What a menu needs to know about the pages it acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageFacts {
    pub is_recurring: bool,
    pub schedule_locked: bool,
    pub has_date: bool,
    /// How many pages the action would act on.
    pub acts_on: u32,
}

/// `"offered"`, or the reason it isn't, in the desktop's words.
pub fn answer(action: PageAction, page: PageFacts) -> &'static str {
    if page.schedule_locked && action != PageAction::Delete {
        return "calendar-owned";
    }

    match action {
        PageAction::Rename if page.acts_on > 1 => "several-pages",
        PageAction::ClearDate if page.is_recurring => "repeats",
        PageAction::ClearDate if !page.has_date => "no-date",
        _ => "offered",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        is_recurring: bool,
        schedule_locked: bool,
        has_date: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        page: Page,
        acts_on: u32,
        expect: BTreeMap<String, String>,
    }

    #[test]
    fn answers_as_the_desktops_menu_does() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../packages/core/src/pages/pageActions.cases.json"
        ))
        .unwrap();
        assert!(!cases.is_empty());

        for case in cases {
            let facts = PageFacts {
                is_recurring: case.page.is_recurring,
                schedule_locked: case.page.schedule_locked,
                has_date: case.page.has_date,
                acts_on: case.acts_on,
            };
            let answers: BTreeMap<String, String> = PageAction::ALL
                .iter()
                .map(|action| (action.key().to_owned(), answer(*action, facts).to_owned()))
                .collect();
            assert_eq!(answers, case.expect, "{}", case.name);
        }
    }
}
