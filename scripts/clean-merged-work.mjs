#!/usr/bin/env node
// Remove the local leftovers of work that has landed on main: extra worktrees, with their
// build output, and branches. A release runs it last, since by then everything it shipped
// is merged; it can also be run by hand.
//
//   node scripts/clean-merged-work.mjs [--dry-run]
//
// A branch counts as merged when a pull request from it was merged and main holds its every
// commit. Main alone isn't enough: a branch just made from main, with no work on it yet, is
// already inside main. Only merged work with nothing uncommitted goes, and only through
// git's own safe commands (`worktree remove` refuses a dirty tree, `branch -d` an unmerged
// branch), so a held runner branch or a half-done worktree stays. The main checkout and the
// worktree this runs in are never removed.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Each worktree from `git worktree list --porcelain`: its path and branch, null when detached. */
export function parseWorktrees(porcelain) {
  return porcelain
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
      return {
        branch: ref ? ref.replace(/^refs\/heads\//, "") : null,
        locked: lines.some((l) => l.startsWith("locked")),
        path,
      };
    });
}

/**
 * What to remove, and what stays with why. `worktrees` lists the main checkout first, as git
 * does. `merged` and `dirty` are sets of branch names and worktree paths; `here` is the
 * worktree this runs in.
 */
export function plan({ worktrees, branches, merged, dirty, here }) {
  const [primary, ...others] = worktrees;
  const removeWorktrees = [];
  const kept = [];
  const stillCheckedOut = new Set([primary.branch]);

  for (const wt of others) {
    const why =
      wt.path === here
        ? "it's where this is running; remove it with git worktree remove once you've left it"
        : wt.locked
          ? "it's locked"
          : !wt.branch
            ? "its HEAD is detached, so there's no branch to check"
            : !merged.has(wt.branch)
              ? `${wt.branch} isn't merged into main`
              : dirty.has(wt.path)
                ? "it has uncommitted changes"
                : null;
    if (why) {
      kept.push({ path: wt.path, why });
      if (wt.branch) stillCheckedOut.add(wt.branch);
    } else {
      removeWorktrees.push(wt.path);
    }
  }

  const deleteBranches = branches.filter(
    (b) => b !== "main" && merged.has(b) && !stillCheckedOut.has(b)
  );
  return { deleteBranches, kept, removeWorktrees };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const here = realpathSync(git(["rev-parse", "--show-toplevel"]));
  const log = (line) => console.log(`[clean-merged-work] ${line}`);

  git(["fetch", "--prune", "--quiet", "origin"]);
  const worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"])).map((wt) => ({
    ...wt,
    path: realpathSync(wt.path),
  }));
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .filter(Boolean);
  const mergedPrs = new Set(
    JSON.parse(
      execFileSync(
        "gh",
        ["pr", "list", "--state", "merged", "--limit", "500", "--json", "headRefName"],
        { encoding: "utf8" }
      )
    ).map((pr) => pr.headRefName)
  );
  const merged = new Set(
    branches.filter((b) => {
      if (!mergedPrs.has(b)) return false;
      try {
        git(["merge-base", "--is-ancestor", b, "origin/main"]);
        return true;
      } catch {
        return false;
      }
    })
  );
  const dirty = new Set(
    worktrees.filter((wt) => git(["status", "--porcelain"], wt.path) !== "").map((wt) => wt.path)
  );

  const { deleteBranches, kept, removeWorktrees } = plan({
    branches,
    dirty,
    here,
    merged,
    worktrees,
  });

  for (const path of removeWorktrees) {
    log(`${dryRun ? "would remove" : "remove"} worktree ${path}`);
    if (!dryRun) git(["worktree", "remove", path]);
  }
  for (const branch of deleteBranches) {
    log(`${dryRun ? "would delete" : "delete"} branch ${branch}`);
    if (!dryRun) git(["branch", "-d", branch]);
  }
  for (const { path, why } of kept) log(`keep ${path}: ${why}`);
  if (removeWorktrees.length + deleteBranches.length === 0) log("nothing merged to clean up");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
