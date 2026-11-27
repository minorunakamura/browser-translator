import { describe, expect, test } from "vitest";
import {
  PLAMO_STOP,
  buildParallelContext,
  buildPfml3Prompt,
} from "../src/text.ts";

describe("buildPfml3Prompt", () => {
  test("puts context right after dataset and asks for polite Japanese", () => {
    expect(buildPfml3Prompt("Hello <b1>world</b1>.", "Page: Demo")).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation" +
        "<|plamo:tag|>context<|plamo:msg|>Page: Demo" +
        "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Hello <b1>world</b1>." +
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
