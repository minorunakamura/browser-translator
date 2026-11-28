// Work Items 2 and 4: drive translation mode on a real page through the toolbar action and check the DOM.
// Usage: node scripts/verify-translate.ts <translate|bilingual|unreachable> <evidenceDir> [pageUrl] [--server=<url>]
//   --server: llama-server URL saved on the options page first; without it the default http://127.0.0.1:8080 is used.
//   translate:   replace display (the default); llama-server must be listening on that URL.
//   bilingual:   the options page selects the bilingual display first; llama-server must be listening on that URL.
//   unreachable: nothing may be listening on that URL; expects the connection error display.
// Run `pnpm run build` first so dist/ is up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CdpPipe,
  evaluate,
  launchChrome,
  loadExtensionAndAttachWorker,
  sleep,
} from "./cdp.ts";
import { bubbleSide } from "../src/bubble.ts";
import { applyOptions } from "./extension.ts";

const REFERENCE_PAGE =
  "https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga";
const args = process.argv.slice(2);
const serverUrl = args
  .find((a) => a.startsWith("--server="))
  ?.slice("--server=".length);
const [mode, evidenceDir, pageUrl = REFERENCE_PAGE] = args.filter(
  (a) => !a.startsWith("--server="),
);
if (
  (mode !== "translate" && mode !== "bilingual" && mode !== "unreachable") ||
  !evidenceDir
) {
  console.error(
    "usage: node scripts/verify-translate.ts <translate|bilingual|unreachable> <evidenceDir> [pageUrl] [--server=<url>]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });

// Runs in the page: text/HTML of every candidate paragraph and code block, keyed by document order.
// bare is the outerHTML without the extension's inserted elements (the original DOM under a bilingual translation).
const SNAPSHOT = `(() => {
  const all = [...document.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre")];
  const bare = (el) => {
    const copy = el.cloneNode(true);
    for (const m of copy.querySelectorAll('[data-browser-translator="inserted"]')) m.remove();
    return copy.outerHTML;
  };
  return all.map((el) => ({ tag: el.localName, text: el.textContent, html: el.outerHTML, bare: bare(el) }));
})()`;

// Runs in the page after translation: the acceptance observations of the reference page.
// A paragraph counts as translated when it carries the replace mark or holds a bilingual translation (a
// lang="ja" inserted element); out is the element that holds the translated text, source the original text
// (for a replaced paragraph, the text SOURCES recorded before translation).
const OBSERVE = `(() => {
  const ja = /[\\u3040-\\u30ff\\u4e00-\\u9fff]/;
  const replaced = [...document.querySelectorAll('[data-browser-translator="translated"]')];
  const added = [...document.querySelectorAll('[data-browser-translator="inserted"][lang="ja"]')];
  const bareText = (el) => {
    const copy = el.cloneNode(true);
    for (const m of copy.querySelectorAll('[data-browser-translator="inserted"]')) m.remove();
    return copy.textContent.replace(/\\s+/g, " ").trim();
  };
  const entries = [
    ...replaced.map((el) => ({ el, out: el, source: window.__browserTranslatorVerifySources?.get(el) ?? "" })),
    ...added.map((out) => ({ el: out.parentElement, out, source: bareText(out.parentElement) })),
  ];
  const entryOf = (el) => entries.find((e) => e.el === el);
  const outsideCode = (el) => {
    const copy = el.cloneNode(true);
    for (const c of copy.querySelectorAll("code")) c.remove();
    return copy.textContent;
  };
  const failed = [...document.querySelectorAll('[data-browser-translator="inserted"]')]
    .filter((m) => (m.title || "").startsWith("翻訳できませんでした"))
    .map((m) => ({ marker: m.title, inArticle: !!m.closest(".blog-content"), text: m.parentElement.textContent.slice(0, 120) }));
  const article = [...document.querySelectorAll(".blog-content p, .blog-content li, .blog-content h1, .blog-content h2, .blog-content h3")]
    .filter((el) => !el.closest("pre") && /[A-Za-z]/.test(el.textContent))
    // A list item holding a non-empty nested list is left to its inner items (content.ts shortcut).
    .filter((el) => ![...el.querySelectorAll("p, li, ul, ol, pre, div")].some((b) => /\\S/.test(b.textContent)));
  const bySource = (start) => entries.find((e) => e.source.startsWith(start));
  const inline = (e) => e && {
    html: e.out.innerHTML,
    source: e.source,
    // Bilingual: the translation is the paragraph's last child, a block below the original text.
    below: e.out !== e.el && e.el.lastElementChild === e.out && getComputedStyle(e.out).display === "block" &&
      e.out.getBoundingClientRect().top > e.el.getBoundingClientRect().top,
    codes: [...e.out.querySelectorAll("code")].map((c) => c.textContent),
    strongs: [...e.out.querySelectorAll("strong")].map((s) => s.textContent),
    links: [...e.out.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), rel: a.getAttribute("rel"), text: a.textContent })),
  };
  return {
    replacedCount: replaced.length,
    bilingualCount: added.length,
    translatedCount: entries.length,
    translatedJapanese: entries.filter((e) => ja.test(e.out.textContent)).length,
    translatedNotJapanese: entries.filter((e) => !ja.test(e.out.textContent)).map((e) => ({ source: e.source, text: e.out.textContent })),
    articleCandidates: article.length,
    articleTranslated: article.filter((el) => entryOf(el)).length,
    articleNotJapanese: article.filter((el) => entryOf(el) && !ja.test(entryOf(el).out.textContent)).map((el) => el.textContent.slice(0, 120)),
    articleUntranslated: article.filter((el) => !entryOf(el)).map((el) => el.outerHTML.slice(0, 600)),
    notBelow: added.filter((out) => !(out.parentElement.lastElementChild === out && getComputedStyle(out).display === "block")).length,
    failed,
    preJapanese: [...document.querySelectorAll("pre")].filter((el) => ja.test(el.textContent)).length,
    preTranslatedMark: document.querySelectorAll("pre [data-browser-translator], pre[data-browser-translator]").length,
    knowledgeEngine: inline(bySource("The knowledge engine.")),
    guardrails: inline(bySource("Keep guardrails cheap.")),
    cuga: inline(bySource("CUGA (ConfigUrable")),
    // A sent tag (<a>, <code id="2">, </strong>) left as text outside code; inside code "<h1>" is the source text.
    leftoverTags: entries.filter((e) => /<\\/?[a-z][a-z0-9-]*( id="\\d+")?>/.test(outsideCode(e.out))).map((e) => e.out.textContent.slice(0, 120)),
    notice: [...document.querySelectorAll('body > [data-browser-translator="inserted"]')].map((n) => n.textContent),
  };
})()`;

// Runs in the page before translation: each paragraph's text (whitespace collapsed, as content.ts reads it), kept
// in the page's main world and not in the DOM.
const SOURCES = `(() => {
  window.__browserTranslatorVerifySources = new WeakMap();
  for (const el of document.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6"))
    window.__browserTranslatorVerifySources.set(el, el.textContent.replace(/\\s+/g, " ").trim());
})()`;

// Runs in the page: the replaced paragraph whose source starts with start, scrolled to block, and the bubble.
const bubbleObservation = (start: string, block: string) => `(() => {
  const el = [...document.querySelectorAll('[data-browser-translator="translated"]')]
    .find((e) => (window.__browserTranslatorVerifySources.get(e) ?? "").startsWith(${JSON.stringify(start)}));
  if (!el) return null;
  ${block ? `el.scrollIntoView({ block: ${JSON.stringify(block)} });` : ""}
  const r = el.getBoundingClientRect();
  const hosts = [...document.querySelectorAll('[data-browser-translator="inserted"]')].filter((h) => h.shadowRoot);
  const host = hosts[0];
  const text = host?.shadowRoot.querySelector("div");
  const b = host?.getBoundingClientRect();
  return {
    paragraph: { top: r.top, bottom: r.bottom, left: r.left, width: r.width, x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 10),
      fontSize: getComputedStyle(el).fontSize, hasTitle: el.hasAttribute("title"),
      source: window.__browserTranslatorVerifySources.get(el) },
    viewportHeight: document.documentElement.clientHeight,
    bubbles: hosts.length,
    bubble: host && {
      parent: host.parentElement.localName,
      shadowMode: host.shadowRoot.mode,
      text: text?.textContent,
      fontSize: text && getComputedStyle(text).fontSize,
      userSelect: text && getComputedStyle(text).userSelect,
      top: b.top, bottom: b.bottom, left: b.left, width: b.width, height: b.height,
      x: b.left + b.width / 2, y: b.top + b.height / 2,
    },
  };
})()`;

interface BubbleObservation {
  paragraph: {
    top: number;
    bottom: number;
    left: number;
    width: number;
    x: number;
    y: number;
    fontSize: string;
    hasTitle: boolean;
    source: string;
  };
  viewportHeight: number;
  bubbles: number;
  bubble?: {
    parent: string;
    shadowMode: string;
    text: string;
    fontSize: string;
    userSelect: string;
    top: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
    x: number;
    y: number;
  };
}

interface Snapshot {
  tag: string;
  text: string;
  html: string;
  bare: string;
}

async function screenshot(
  cdp: CdpPipe,
  sessionId: string,
  name: string,
): Promise<string> {
  const { data }: { data: string } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  writeFileSync(join(evidenceDir, name), Buffer.from(data, "base64"));
  return name;
}

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  mode,
  pageUrl,
  serverUrl: serverUrl ?? "default",
  extensionPath,
  startedAt: new Date().toISOString(),
};
const checks: Record<string, boolean> = {};
try {
  const { cdp } = chrome;
  record.chrome = (await cdp.send("Browser.getVersion")).product;
  const { extensionId, sessionId: sw } = await loadExtensionAndAttachWorker(
    cdp,
    extensionPath,
  );
  record.extensionId = extensionId;
  if (serverUrl) {
    const options = await applyOptions(cdp, extensionId, sw, {
      url: serverUrl,
      screenshot: join(evidenceDir, `${mode}-options.png`),
      display: mode === "bilingual" ? "bilingual" : undefined,
    });
    record.options = options;
    checks.optionsSaved =
      options.stored.url === serverUrl &&
      options.stored.display ===
        (mode === "bilingual" ? "bilingual" : "replace");
  } else if (mode === "bilingual") {
    const options = await applyOptions(cdp, extensionId, sw, {
      url: "http://127.0.0.1:8080",
      screenshot: join(evidenceDir, "bilingual-options.png"),
      display: "bilingual",
    });
    record.options = options;
    checks.optionsSaved = options.stored.display === "bilingual";
  }

  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await cdp.send("Page.enable", {}, page);
  const loaded = cdp.waitFor(
    "Page.loadEventFired",
    (_p, msg) => msg.sessionId === page,
    60000,
  );
  await cdp.send("Page.navigate", { url: pageUrl }, page);
  await loaded;
  await sleep(2000);
  await cdp.send("Target.activateTarget", { targetId });
  // Same entry as a real toolbar click: chrome.action.onClicked fires in the service worker.
  // triggerAction needs the "tab" target that owns the page target.
  const {
    targetInfos: tabs,
  }: { targetInfos: { targetId: string; url: string }[] } = await cdp.send(
    "Target.getTargets",
    { filter: [{ type: "tab" }] },
  );
  const tabTarget = tabs.find((t) => t.url === pageUrl)?.targetId;
  if (!tabTarget) throw new Error("tab target of the page not found");
  const clickToolbarButton = () =>
    cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: tabTarget,
    });

  const before: Snapshot[] = await evaluate(cdp, page, SNAPSHOT);
  await evaluate(cdp, page, SOURCES);
  await screenshot(cdp, page, `${mode}-0-before.png`);
  await clickToolbarButton();
  // Without the tabs permission the URL becomes visible only after the click grants activeTab.
  const tabId: number = await evaluate(
    cdp,
    sw,
    `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(pageUrl)}).id)`,
  );
  const badge = () =>
    evaluate(cdp, sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);

  if (mode === "unreachable") {
    let notice: string[] = [];
    for (let i = 0; i < 30 && notice.length === 0; i++) {
      await sleep(500);
      notice = (await evaluate(cdp, page, OBSERVE)).notice;
    }
    record.notice = notice;
    record.badge = await badge();
    await screenshot(cdp, page, "unreachable-1-on.png");
    checks.noticeShown = notice.some(
      (t) =>
        t.includes("接続できません") &&
        t.includes(serverUrl ?? "http://127.0.0.1:8080"),
    );
    checks.badgeError = record.badge === "ERR";
  } else {
    await sleep(1000);
    record.badgeOn = await badge();
    // Translation is done when the number of translated + failed paragraphs stops changing.
    let last = -1;
    let stableFor = 0;
    const t0 = Date.now();
    while (stableFor < 6 && Date.now() - t0 < 300000) {
      await sleep(1000);
      const o = await evaluate(cdp, page, OBSERVE);
      const done = o.translatedCount + o.failed.length;
      stableFor = done === last && done > 0 ? stableFor + 1 : 0;
      last = done;
    }
    record.translateSeconds = Math.round((Date.now() - t0) / 1000);
    const o = await evaluate(cdp, page, OBSERVE);
    record.observed = o;
    await screenshot(cdp, page, `${mode}-1-top.png`);
    for (const [key, start] of [
      ["cuga", "Where CUGA fits"],
      ["knowledge", "The knowledge engine."],
      ["guardrails", "Keep guardrails cheap."],
    ]) {
      await evaluate(
        cdp,
        page,
        `[...document.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6")].find((el) => (el.textContent || "").trim().startsWith(${JSON.stringify(start)}))?.scrollIntoView({ block: "center" })`,
      );
      await sleep(300);
      await screenshot(cdp, page, `${mode}-2-${key}.png`);
    }
    const during: Snapshot[] = await evaluate(cdp, page, SNAPSHOT);

    checks.badgeOn = record.badgeOn === "ON";
    checks.articleJapanese =
      o.articleCandidates > 0 &&
      o.articleTranslated +
        o.failed.filter((f: { inArticle: boolean }) => f.inArticle).length >=
        o.articleCandidates &&
      o.articleNotJapanese.length === 0;
    checks.preUnchanged =
      o.preJapanese === 0 &&
      o.preTranslatedMark === 0 &&
      JSON.stringify(before.filter((s) => s.tag === "pre")) ===
        JSON.stringify(
          (await evaluate(cdp, page, SNAPSHOT)).filter(
            (s: Snapshot) => s.tag === "pre",
          ),
        );
    checks.knowledgeEngine =
      o.knowledgeEngine?.codes.join() === "agent.knowledge.search()" &&
      o.knowledgeEngine.strongs.length === 1;
    checks.guardrails =
      o.guardrails?.codes.join() === "OFF_TOPIC" &&
      o.guardrails.strongs.length === 1;
    checks.cugaLink = o.cuga?.links.some(
      (l: { href: string; text: string }) =>
        l.href === "https://cuga.dev" && l.text === "CUGA",
    );
    checks.noLeftoverTags = o.leftoverTags.length === 0;
    if (mode === "translate") {
      // Hover: the original-text bubble (a shadow root under <html>) after the mouse rests on a paragraph.
      const move = (x: number, y: number) =>
        cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x, y },
          page,
        );
      const observeBubble = (block = ""): Promise<BubbleObservation | null> =>
        evaluate(cdp, page, bubbleObservation("Keep guardrails cheap.", block));
      // A point in the left margin, outside every paragraph.
      const away = async () => {
        await move(5, 500);
        await sleep(1000);
      };
      const hover = async (block: string, name: string) => {
        await away();
        const at = await observeBubble(block);
        if (!at)
          throw new Error(
            "replaced paragraph Keep guardrails cheap. not found",
          );
        await sleep(300);
        const p = (await observeBubble())?.paragraph ?? at.paragraph;
        await move(p.x, p.y);
        await sleep(200);
        const early = await observeBubble();
        await sleep(500);
        const shown = await observeBubble();
        await screenshot(cdp, page, name);
        return { early: early?.bubbles ?? 0, shown };
      };
      const matches = (bo: BubbleObservation | null | undefined) => {
        const b = bo?.bubble;
        if (!bo || !b) return false;
        return (
          b.text === bo.paragraph.source &&
          b.fontSize === bo.paragraph.fontSize &&
          Math.abs(b.width - bo.paragraph.width) <= 1 &&
          Math.abs(b.left - bo.paragraph.left) <= 1 &&
          b.userSelect !== "none" &&
          b.parent === "html" &&
          b.shadowMode === "open" &&
          !bo.paragraph.hasTitle
        );
      };
      // The side content.ts must pick: below when it fits under the paragraph, else above when that fits.
      const side = (bo: BubbleObservation) => {
        const b = bo.bubble;
        if (!b) return "none";
        if (b.top >= bo.paragraph.bottom) return "below";
        if (b.bottom <= bo.paragraph.top) return "above";
        return "overlap";
      };
      const expectedSide = (bo: BubbleObservation) =>
        bubbleSide(
          bo.paragraph.top,
          bo.paragraph.bottom,
          bo.bubble?.height ?? 0,
          bo.viewportHeight,
        );

      const center = await hover("center", "translate-4-bubble.png");
      const centerShown = center.shown;
      let onBubble: BubbleObservation | null = null;
      if (centerShown?.bubble) {
        await move(centerShown.bubble.x, centerShown.bubble.y);
        await sleep(1000);
        onBubble = await observeBubble();
      }
      await away();
      const left = await observeBubble();
      const end = await hover("end", "translate-5-bubble-above.png");
      await away();
      record.bubble = {
        center: { ...center, side: centerShown && side(centerShown) },
        onBubble: onBubble && { bubbles: onBubble.bubbles },
        afterLeaving: left && { bubbles: left.bubbles },
        end: { ...end, side: end.shown && side(end.shown) },
      };
      checks.bubbleShowsOriginal =
        center.early === 0 &&
        centerShown?.bubbles === 1 &&
        matches(centerShown) &&
        centerShown.paragraph.source.startsWith("Keep guardrails cheap.");
      checks.bubblePlacement =
        !!centerShown &&
        side(centerShown) === expectedSide(centerShown) &&
        side(centerShown) === "below" &&
        !!end.shown &&
        matches(end.shown) &&
        side(end.shown) === expectedSide(end.shown) &&
        side(end.shown) === "above";
      checks.bubbleStaysOnHover = onBubble?.bubbles === 1;
      checks.bubbleHidesOnLeave = left?.bubbles === 0;
    } else {
      // Bilingual: every translation is a block at the end of its paragraph, and the page's own DOM is untouched.
      const changed = before
        .map((b, i) => ({ i, b, d: during[i] }))
        .filter(({ b, d }) => !d || d.bare !== b.html);
      record.bilingualOriginalDiffs = changed.slice(0, 5);
      checks.bilingualBelow =
        o.replacedCount === 0 &&
        o.bilingualCount > 0 &&
        o.notBelow === 0 &&
        [o.knowledgeEngine, o.guardrails, o.cuga].every(
          (e: { below: boolean } | undefined) => e?.below === true,
        );
      checks.bilingualOriginalKept =
        before.length === during.length && changed.length === 0;
    }

    await clickToolbarButton();
    await sleep(1000);
    const after: Snapshot[] = await evaluate(cdp, page, SNAPSHOT);
    const diffs = before
      .map((b, i) => ({ i, b, a: after[i] }))
      .filter(({ a, b }) => !a || a.text !== b.text || a.html !== b.html);
    record.offDiffs = diffs.slice(0, 5);
    record.offBadge = await badge();
    record.offMarkers = await evaluate(
      cdp,
      page,
      "document.querySelectorAll('[data-browser-translator]').length",
    );
    await evaluate(cdp, page, "window.scrollTo(0, 0)");
    await screenshot(cdp, page, `${mode}-3-off.png`);
    checks.offRestoresDom =
      before.length === after.length &&
      diffs.length === 0 &&
      record.offMarkers === 0;
    checks.offBadgeCleared = record.offBadge === "";
  }
} catch (e) {
  record.error = String(e instanceof Error ? e.stack || e : e);
} finally {
  record.checks = checks;
  record.ok =
    record.error === undefined &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every(Boolean);
  record.finishedAt = new Date().toISOString();
  await chrome.close();
  writeFileSync(
    join(evidenceDir, `${mode}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}
console.log(JSON.stringify(record, null, 2));
process.exit(record.ok ? 0 : 1);
