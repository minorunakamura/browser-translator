import { describe, expect, test } from "vitest";
import {
  PLAMO_STOP,
  buildParallelContext,
  buildPfml3Prompt,
} from "../src/text.ts";

describe("buildPfml3Prompt", () => {
  test("puts context right after dataset and asks for polite Japanese", () => {
    expect(
      buildPfml3Prompt("Hello <strong>world</strong>.", "Page: Demo"),
    ).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation" +
        "<|plamo:tag|>context<|plamo:msg|>Page: Demo" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Hello <strong>world</strong>." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>",
    );
  });

  test("omits the context element when there is no context", () => {
    expect(buildPfml3Prompt("Hi.", "")).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Hi." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>",
    );
  });

  test("serial mode lists the previous input/output pair after context, with form only on the current output", () => {
    expect(
      buildPfml3Prompt("Second <code>run()</code>.", "Page: Demo", {
        history: [
          {
            source: "First <strong>one</strong>.",
            translation: "最初の<strong>もの</strong>です。",
          },
        ],
      }),
    ).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation" +
        "<|plamo:tag|>context<|plamo:msg|>Page: Demo" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>First <strong>one</strong>." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>最初の<strong>もの</strong>です。" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Second <code>run()</code>." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>",
    );
  });

  test("puts the glossary right before the current input, after the history", () => {
    expect(
      buildPfml3Prompt("Use the agent harness.", "", {
        history: [{ source: "Hi.", translation: "こんにちは。" }],
        glossary: [
          { source: "agent harness", target: "エージェント基盤" },
          { source: "pi", target: "パイ" },
        ],
      }),
    ).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Hi." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>こんにちは。" +
        "<|plamo:tag|>glossary<|plamo:index|>agent harness<|plamo:item|>エージェント基盤<|plamo:index|>pi<|plamo:item|>パイ" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Use the agent harness." +
        "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>",
    );
  });

  test("leaves out the glossary element when no term matched and adds nothing for empty options", () => {
    expect(
      buildPfml3Prompt("Hi.", "Page: Demo", { history: [], glossary: [] }),
    ).toBe(buildPfml3Prompt("Hi.", "Page: Demo"));
  });

  test("stops at the next PFML3 tag or a new sequence", () => {
    expect(PLAMO_STOP).toEqual(["<|plamo:tag|>", "<|plamo:bos|>"]);
  });
});

describe("buildParallelContext", () => {
  test("combines the page description with the previous and next source paragraphs", () => {
    expect(
      buildParallelContext({
        title: "An Indic Voice Agent with CUGA",
        description: "Build a voice agent.",
        previous: "Where CUGA fits",
        next: "One agent, any model.",
      }),
    ).toBe(
      "Page: An Indic Voice Agent with CUGA - Build a voice agent.\n" +
        "Previous paragraph: Where CUGA fits\n" +
        "Next paragraph: One agent, any model.",
    );
  });

  test("leaves out parts that are empty, e.g. at the start of the page", () => {
    expect(
      buildParallelContext({
        title: "Title",
        description: "",
        previous: "",
        next: "Second.",
      }),
    ).toBe("Page: Title\nNext paragraph: Second.");
  });
});
