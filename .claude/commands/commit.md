Commit the current changes to git. Follow these steps:

1. Run `git status` to see changed files and `git diff --stat` to understand what changed.
2. Review the changes with `git diff` (staged and unstaged) to understand the nature of the work.
3. Stage only the relevant files — never stage `.env`, credentials, or unrelated changes. Prefer staging specific files over `git add -A`.
4. Write a commit message in the format `type: brief description` where type is one of: feature, update, chore, bug, refactor, test, docs. Keep it to one line, no body unless truly needed.
5. Create the commit. Do not push unless the user explicitly asks.
6. Show the resulting `git log --oneline -1` so the user can see what was committed.
