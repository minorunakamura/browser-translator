import { describe, expect, test } from "vitest";
import {
  type InlineElement,
  type InlineNode,
  restoreTags,
  toTagged,
} from "../src/text.ts";

const el = (kind: string, ...children: InlineNode[]): InlineElement => ({
  kind,
  children,
});

const guardrails = toTagged([
  el("strong", "Keep guardrails cheap."),
  " starts with ",
  el("code", "OFF_TOPIC"),
  " and ",
  el("code", "x"),
]);

describe("toTagged", () => {
  test("replaces a, code, strong/b, em/i with numbered short tags", () => {
    const nodes = [
      el("strong", "The knowledge engine."),
      " Search with ",
      el("code", "agent.knowledge.search()"),
      ", see ",
      el("a", "docs"),
      " and ",
      el("em", "this"),
      el("b", "!"),
      el("i", "?"),
    ];
    expect(toTagged(nodes).text).toBe(
      "<b1>The knowledge engine.</b1> Search with <c1>agent.knowledge.search()</c1>, see <a1>docs</a1> and <i1>this</i1><b2>!</b2><i2>?</i2>",
    );
  });

  test("tags nested elements, wraps unknown kinds as x and keeps empty elements", () => {
    const nodes = [
      el("a", "see ", el("code", "run()"), " now"),
      el("span", "Note"),
      " text",
      el("br"),
      el("sup", el("a", "1")),
    ];
    expect(toTagged(nodes).text).toBe(
      "<a1>see <c1>run()</c1> now</a1><x1>Note</x1> text<x2></x2><x3><a2>1</a2></x3>",
    );
  });
});

describe("restoreTags", () => {
  test("restores each tag to its source element even when the translation reorders tags", () => {
    const link = el("a", "CUGA");
    const strong = el("strong", "one setting");
    const { elements } = toTagged([link, " is used with ", strong, "."]);
    expect(
      restoreTags("<b1>1 つの設定</b1>で<a1>CUGA</a1>を使います。", elements),
    ).toEqual({
      ok: true,
      nodes: [
        { source: strong, children: ["1 つの設定"] },
        "で",
        { source: link, children: ["CUGA"] },
        "を使います。",
      ],
    });
  });

  test("restores nested tags inside each other", () => {
    const code = el("code", "run()");
    const link = el("a", "see ", code);
    const { elements } = toTagged([link]);
    const restored = restoreTags("<a1><c1>run()</c1> を参照</a1>", elements);
    expect(restored).toEqual({
      ok: true,
      nodes: [
        {
          source: link,
          children: [{ source: code, children: ["run()"] }, " を参照"],
        },
      ],
    });
  });

  test("keeps code contents from the source even if the model changed them", () => {
    const code = el("code", "agent.knowledge.search()");
    const { elements } = toTagged(["search with ", code]);
    expect(
      restoreTags("<c1>agent.knowledge.検索()</c1> で検索します", elements),
    ).toEqual({
      ok: true,
      nodes: [
        { source: code, children: ["agent.knowledge.search()"] },
        " で検索します",
      ],
    });
  });

  test.each([
    [
      "missing tag",
      "<b1>安く</b1>は<c1>OFF_TOPIC</c1>で始まる",
      ["missing c2"],
    ],
    [
      "duplicated tag",
      "<b1>安く</b1><c1>OFF_TOPIC</c1><c1>OFF_TOPIC</c1><c2>x</c2>",
      ["duplicated c1"],
    ],
    [
      "unknown number",
      "<b1>安く</b1><c1>OFF_TOPIC</c1><c2>x</c2><c3>y</c3>",
      ["unknown c3"],
    ],
    [
      "wrong kind for the number",
      "<b1>安く</b1><c1>OFF_TOPIC</c1><a2>x</a2>",
      ["unknown a2", "missing c2"],
    ],
    ["unclosed tag", "<b1>安く<c1>OFF_TOPIC</c1><c2>x</c2>", ["unbalanced b1"]],
    [
      "crossed tags",
      "<b1>安く<c1>OFF_TOPIC</b1></c1><c2>x</c2>",
      ["unbalanced b1"],
    ],
  ])("rejects a translation with a %s", (_case, translated, problems) => {
    expect(restoreTags(translated, guardrails.elements)).toEqual({
      ok: false,
      problems,
    });
  });
});
