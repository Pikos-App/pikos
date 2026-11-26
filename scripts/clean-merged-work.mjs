#!/usr/bin/env node
// Remove the local leftovers of work whose pull request has merged: extra worktrees, with
// their build output, and branches. It runs after every pull that merges (the `post-merge`
// hook) and at the end of a release, and by hand as `pnpm cleanup:merged`.
//
//   node scripts/clean-merged-work.mjs [--dry-run] [--quiet]
//
// A branch counts as merged when a pull request from it was merged and the branch it went
// into holds its every commit. The second half alone isn't enough: a branch just made from
// main, with no work on it yet, is already inside main. A worktree with uncommitted changes
// stays (`worktree remove` refuses one anyway), and so do the main checkout and the
// worktree this runs in.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A hook runs with GIT_DIR set to its own worktree, which would point every `git status` here
// at that one tree, whatever directory it was asked about.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

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

/** The branches a merged pull request came from whose every commit is in the branch it went
 *  into. `contains(branch, base)` asks git whether `base` holds `branch`. */
export function mergedBranches(branches, prs, contains) {
  const base = new Map(prs.map((pr) => [pr.headRefName, pr.baseRefName]));
  return new Set(branches.filter((b) => base.has(b) && contains(b, base.get(b))));
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
              ? `${wt.branch} has no merged pull request`
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
  const quiet = process.argv.includes("--quiet");
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
  const prs = JSON.parse(
    execFileSync(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "500", "--json", "headRefName,baseRefName"],
      { encoding: "utf8" }
    )
  );
  const merged = mergedBranches(branches, prs, (branch, base) => {
    try {
      git(["merge-base", "--is-ancestor", branch, `origin/${base}`]);
      return true;
    } catch {
      return false;
    }
  });
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
  // `-D`, since `-d` judges against whatever is checked out here, and the check above has
  // already found every commit in the branch the pull request went into.
  for (const branch of deleteBranches) {
    log(`${dryRun ? "would delete" : "delete"} branch ${branch}`);
    if (!dryRun) git(["branch", "-D", branch]);
  }
  if (quiet) return;
  for (const { path, why } of kept) log(`keep ${path}: ${why}`);
  if (removeWorktrees.length + deleteBranches.length === 0) log("nothing merged to clean up");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    // Offline, or gh not signed in: a pull or a release that already worked shouldn't fail on
    // tidying up, so this says why it stopped and leaves everything where it was.
    const why = String(e instanceof Error ? e.message : e).split("\n")[0];
    console.error(`[clean-merged-work] skipped: ${why}`);
  }
}
