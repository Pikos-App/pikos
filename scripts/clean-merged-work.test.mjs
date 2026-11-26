import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorktrees, plan } from "./clean-merged-work.mjs";

const PORCELAIN = `worktree /code/pkos
HEAD aaa
branch refs/heads/feat/1.0.0-beta.1

worktree /code/pkos-051
HEAD bbb
branch refs/heads/feat/0.5.1

worktree /code/pkos-probe
HEAD ccc
detached

worktree /code/pkos-held
HEAD ddd
branch refs/heads/fix/held
locked
`;

const worktrees = parseWorktrees(PORCELAIN);

test("reads each worktree's path, branch and lock", () => {
  assert.deepEqual(worktrees, [
    { branch: "feat/1.0.0-beta.1", locked: false, path: "/code/pkos" },
    { branch: "feat/0.5.1", locked: false, path: "/code/pkos-051" },
    { branch: null, locked: false, path: "/code/pkos-probe" },
    { branch: "fix/held", locked: true, path: "/code/pkos-held" },
  ]);
});

const base = {
  branches: ["main", "feat/1.0.0-beta.1", "feat/0.5.1", "fix/held", "ci/old"],
  dirty: new Set(),
  here: "/code/pkos",
  merged: new Set(["feat/0.5.1", "fix/held", "ci/old", "feat/1.0.0-beta.1"]),
  worktrees,
};

test("removes a merged, clean worktree and deletes its branch with the other merged ones", () => {
  const { deleteBranches, removeWorktrees } = plan(base);
  assert.deepEqual(removeWorktrees, ["/code/pkos-051"]);
  assert.deepEqual(deleteBranches, ["feat/0.5.1", "ci/old"]);
});

test("keeps the main checkout, a detached or locked worktree, and their branches", () => {
  const { deleteBranches, kept } = plan(base);
  assert.deepEqual(
    kept.map((k) => k.path),
    ["/code/pkos-probe", "/code/pkos-held"]
  );
  assert.ok(!deleteBranches.includes("feat/1.0.0-beta.1"));
  assert.ok(!deleteBranches.includes("fix/held"));
});

test("keeps a worktree with uncommitted changes, and the worktree it runs in", () => {
  assert.deepEqual(plan({ ...base, dirty: new Set(["/code/pkos-051"]) }).removeWorktrees, []);
  assert.deepEqual(plan({ ...base, here: "/code/pkos-051" }).removeWorktrees, []);
});

test("keeps a worktree whose branch isn't merged", () => {
  const { deleteBranches, kept, removeWorktrees } = plan({
    ...base,
    merged: new Set(["ci/old"]),
  });
  assert.deepEqual(removeWorktrees, []);
  assert.deepEqual(deleteBranches, ["ci/old"]);
  assert.match(kept[0].why, /feat\/0\.5\.1 isn't merged/);
});
