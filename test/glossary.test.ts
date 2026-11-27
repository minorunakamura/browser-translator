import { describe, expect, test } from "vitest";
import { type GlossaryEntry, matchGlossary } from "../src/text.ts";

const pi: GlossaryEntry = { source: "pi", target: "パイ" };
const node: GlossaryEntry = {
  source: "Node.js",
  target: "Node.js（実行環境）",
};
const harness: GlossaryEntry = {
  source: "agent harness",
  target: "エージェント基盤",
};

describe("matchGlossary", () => {
  test.each([
    "Call the api.",
    "The API is ready.",
    "pip install",
    "pi_value",
    "pi2",
  ])("pi does not match inside a word: %s", (source) => {
    expect(matchGlossary(source, [pi])).toEqual([]);
  });

  test.each([
    "Pi is a number.",
    "Run it on a PI.",
    "the value of pi",
    "(pi)",
    "π or pi.",
  ])("pi matches a whole word ignoring case: %s", (source) => {
    expect(matchGlossary(source, [pi])).toEqual([pi]);
  });

  test("terms with regular expression symbols match literally", () => {
    expect(matchGlossary("Install node.js first.", [node])).toEqual([node]);
    expect(matchGlossary("Install NodeXjs first.", [node])).toEqual([]);
  });

  test("tags are removed before matching, so a tag neither matches nor splits a word", () => {
    expect(matchGlossary("<a1>pi</a1> is used.", [pi])).toEqual([pi]);
    expect(matchGlossary("Read <c1>api</c1> docs.", [pi])).toEqual([]);
    expect(matchGlossary("Use the <b1>agent</b1> harness.", [harness])).toEqual(
      [harness],
    );
    expect(matchGlossary("a<b1>pi</b1>", [pi])).toEqual([]);
  });

  test("returns only the matched entries, and none for an empty glossary", () => {
    expect(matchGlossary("Use the agent harness.", [pi, harness])).toEqual([
      harness,
    ]);
    expect(matchGlossary("Nothing here.", [pi, harness])).toEqual([]);
    expect(matchGlossary("pi", [])).toEqual([]);
  });
});
