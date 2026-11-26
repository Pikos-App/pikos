// The same table `fts_tokens` runs. Neither side is the authority (FTS5's `unicode61` is), so
// they share one expectation. Rust owns the why, at `fts_tokens`.

import { describe, expect, it } from "vitest";

import { readFixture } from "../adapters/conformanceTable";
import { ftsTokens } from "./search";

interface Case {
  name: string;
  query: string;
  tokens: string[];
}

const KEYS = ["name", "query", "tokens"];

const { cases } = readFixture<{ cases: Case[] }>("search-tokenization.json");

describe("search tokenization conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$name", (testCase) => {
    expect(Object.keys(testCase).sort()).toEqual([...KEYS].sort());
    expect(ftsTokens(testCase.query)).toEqual(testCase.tokens);
  });
});
