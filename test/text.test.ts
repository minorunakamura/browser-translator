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

describe("toTagged", () => {
  test("sends each element by its own name without attributes when the name appears once", () => {
    const nodes = [
      el("strong", "The knowledge engine."),
      " Search with ",
      el("code", "agent.knowledge.search()"),
      ", see ",
      el("a", "docs"),
      " and ",
      el("em", "this"),
    ];
    expect(toTagged(nodes).text).toBe(
      "<strong>The knowledge engine.</strong> Search with <code>agent.knowledge.search()</code>, see <a>docs</a> and <em>this</em>",
    );
  });

  test("gives every element of a repeated name an id: its number among all elements in document order, nested ones included", () => {
    const nodes = [
      el("strong", "Keep guardrails cheap."),
      " See ",
      el("a", "the ", el("code", "OFF_TOPIC"), " rule"),
      " and ",
      el("code", "x"),
      ".",
    ];
    expect(toTagged(nodes).text).toBe(
      '<strong>Keep guardrails cheap.</strong> See <a>the <code id="3">OFF_TOPIC</code> rule</a> and <code id="4">x</code>.',
    );
  });

  test("sends other elements, custom ones included, by their real names and empty elements as an open and close pair", () => {
    const nodes = [
      el("span", "Note"),
      " text",
      el("br"),
      el("sup", el("a", "1")),
      el("my-badge", "new"),
    ];
    expect(toTagged(nodes).text).toBe(
      "<span>Note</span> text<br></br><sup><a>1</a></sup><my-badge>new</my-badge>",
    );
  });

  test("escapes & < > in the text", () => {
    const nodes = ["Use ", el("code", "<MyButton />"), " & a <h1> tag > 0"];
    expect(toTagged(nodes).text).toBe(
      "Use <code>&lt;MyButton /&gt;</code> &amp; a &lt;h1&gt; tag &gt; 0",
    );
  });
});

describe("restoreTags", () => {
  test("restores each tag to its source element even when the translation reorders tags", () => {
    const link = el("a", "CUGA");
    const first = el("strong", "one");
    const second = el("strong", "setting");
    const { elements } = toTagged([link, " uses ", first, " ", second, "."]);
    expect(
      restoreTags(
        '<strong id="3">設定</strong>を<strong id="2">1 つ</strong><a>CUGA</a>が使います。',
        elements,
      ),
    ).toEqual({
      ok: true,
      nodes: [
        { source: second, children: ["設定"] },
        "を",
        { source: first, children: ["1 つ"] },
        { source: link, children: ["CUGA"] },
        "が使います。",
      ],
    });
  });

  test("restores nested tags inside each other", () => {
    const code = el("code", "run()");
    const link = el("a", "see ", code);
    const { elements } = toTagged([link]);
    expect(restoreTags("<a><code>run()</code> を参照</a>", elements)).toEqual({
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
    const code = el("code", "<MyButton />");
    const { elements } = toTagged(["render ", code]);
    expect(
      restoreTags("<code>&lt;私のボタン /&gt;</code> を描画します", elements),
    ).toEqual({
      ok: true,
      nodes: [{ source: code, children: ["<MyButton />"] }, " を描画します"],
    });
  });

  test("turns &amp; &lt; &gt; in the text back into characters and leaves other entities", () => {
    const strong = el("strong", "a < b");
    const { elements } = toTagged([strong, " & more"]);
    expect(
      restoreTags(
        "<strong>a &lt; b &gt; c</strong> &amp; &quot;その他&quot;",
        elements,
      ),
    ).toEqual({
      ok: true,
      nodes: [
        { source: strong, children: ["a < b > c"] },
        " & &quot;その他&quot;",
      ],
    });
  });

  const guardrails = toTagged([
    el("strong", "Keep guardrails cheap."),
    " starts with ",
    el("code", "OFF_TOPIC"),
    " and ",
    el("code", "x"),
  ]);

  test.each([
    [
      "missing tag",
      '<strong>安く</strong>は<code id="2">OFF_TOPIC</code>で始まる',
      ['missing <code id="3">'],
    ],
    [
      "duplicated tag",
      '<strong>安く</strong><code id="2">OFF_TOPIC</code><code id="2">OFF_TOPIC</code><code id="3">x</code>',
      ['duplicated <code id="2">'],
    ],
    [
      "unknown name",
      '<strong>安く</strong><code id="2">OFF_TOPIC</code><code id="3">x</code><h1>見出し</h1>',
      ["unknown <h1>"],
    ],
    [
      "wrong id",
      '<strong>安く</strong><code id="2">OFF_TOPIC</code><code id="4">x</code>',
      ['unknown <code id="4">', 'missing <code id="3">'],
    ],
    [
      "added attribute",
      '<strong class="x">安く</strong><code id="2">OFF_TOPIC</code><code id="3">x</code>',
      ['unknown <strong class="x">', "missing <strong>"],
    ],
    [
      "unclosed tag",
      '<strong>安く<code id="2">OFF_TOPIC</code><code id="3">x</code>',
      ["unclosed <strong>"],
    ],
    [
      "crossed tags",
      '<strong>安く<code id="2">OFF_TOPIC</strong></code><code id="3">x</code>',
      ["unbalanced </strong>"],
    ],
  ])("rejects a translation with a %s", (_case, translated, problems) => {
    expect(restoreTags(translated, guardrails.elements)).toEqual({
      ok: false,
      problems,
    });
  });
});
