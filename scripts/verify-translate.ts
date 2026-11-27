// Work Item 2: drive translation mode on a real page through the toolbar action and check the DOM.
// Usage: node scripts/verify-translate.ts <translate|unreachable> <evidenceDir> [pageUrl]
//   translate:   llama-server must be listening on http://127.0.0.1:8080 (the extension default).
//   unreachable: nothing may be listening on 127.0.0.1:8080; expects the connection error display.
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

const REFERENCE_PAGE =
  "https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga";
const [mode, evidenceDir, pageUrl = REFERENCE_PAGE] = process.argv.slice(2);
if ((mode !== "translate" && mode !== "unreachable") || !evidenceDir) {
  console.error(
    "usage: node scripts/verify-translate.ts <translate|unreachable> <evidenceDir> [pageUrl]",
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
const SNAPSHOT = `(() => {
  const all = [...document.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre")];
  return all.map((el) => ({ tag: el.localName, text: el.textContent, html: el.outerHTML }));
})()`;

// Runs in the page after translation: the acceptance observations of the reference page.
const OBSERVE = `(() => {
  const ja = /[\\u3040-\\u30ff\\u4e00-\\u9fff]/;
  const translated = [...document.querySelectorAll('[data-browser-translator="translated"]')];
  const failed = [...document.querySelectorAll('[data-browser-translator="inserted"]')]
    .filter((m) => m.parentElement && m.parentElement.closest("p, li, h1, h2, h3, h4, h5, h6"))
    .map((m) => ({ marker: m.title, inArticle: !!m.closest(".blog-content"), text: m.parentElement.textContent.slice(0, 120) }));
  const article = [...document.querySelectorAll(".blog-content p, .blog-content li, .blog-content h1, .blog-content h2, .blog-content h3")]
    .filter((el) => !el.closest("pre") && /[A-Za-z]/.test(el.textContent))
    // A list item holding a non-empty nested list is left to its inner items (content.ts shortcut).
    .filter((el) => ![...el.querySelectorAll("p, li, ul, ol, pre, div")].some((b) => /\\S/.test(b.textContent)));
  const byTitle = (start) => translated.find((el) => (el.title || "").startsWith(start));
  const inline = (el) => el && {
    html: el.innerHTML,
    title: el.title,
    codes: [...el.querySelectorAll("code")].map((c) => c.textContent),
    strongs: [...el.querySelectorAll("strong")].map((s) => s.textContent),
    links: [...el.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), rel: a.getAttribute("rel"), text: a.textContent })),
  };
  return {
    translatedCount: translated.length,
    translatedJapanese: translated.filter((el) => ja.test(el.textContent)).length,
    translatedNotJapanese: translated.filter((el) => !ja.test(el.textContent)).map((el) => ({ source: el.title, text: el.textContent })),
    articleCandidates: article.length,
    articleTranslated: article.filter((el) => el.getAttribute("data-browser-translator") === "translated").length,
    articleNotJapanese: article.filter((el) => el.getAttribute("data-browser-translator") === "translated" && !ja.test(el.textContent)).map((el) => el.textContent.slice(0, 120)),
    articleUntranslated: article.filter((el) => el.getAttribute("data-browser-translator") !== "translated").map((el) => el.outerHTML.slice(0, 600)),
    failed,
    preJapanese: [...document.querySelectorAll("pre")].filter((el) => ja.test(el.textContent)).length,
    preTranslatedMark: document.querySelectorAll("pre [data-browser-translator], pre[data-browser-translator]").length,
    knowledgeEngine: inline(byTitle("The knowledge engine.")),
    guardrails: inline(byTitle("Keep guardrails cheap.")),
    cuga: inline(byTitle("CUGA (ConfigUrable")),
    leftoverTags: translated.filter((el) => /<\\/?[a-z]\\d+>/.test(el.textContent)).map((el) => el.textContent.slice(0, 120)),
    notice: [...document.querySelectorAll('body > [data-browser-translator="inserted"]')].map((n) => n.textContent),
  };
})()`;

interface Snapshot {
  tag: string;
  text: string;
  html: string;
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
    checks.noticeShown = notice.some((t) => t.includes("接続できません"));
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
    await screenshot(cdp, page, "translate-1-top.png");
    for (const [key, start] of [
      ["cuga", "Where CUGA fits"],
      ["knowledge", "The knowledge engine."],
      ["guardrails", "Keep guardrails cheap."],
    ]) {
      await evaluate(
        cdp,
        page,
        `[...document.querySelectorAll("[data-browser-translator]")].find((el) => (el.title || "").startsWith(${JSON.stringify(start)}))?.scrollIntoView({ block: "center" })`,
      );
      await sleep(300);
      await screenshot(cdp, page, `translate-2-${key}.png`);
    }
    // Hover: the original text is the element's title, shown as a tooltip by the browser.
    const hoverTitle: string = await evaluate(
      cdp,
      page,
      `(() => { const el = [...document.querySelectorAll('[data-browser-translator="translated"]')].find((e) => (e.title || "").startsWith("Keep guardrails cheap.")); return el ? el.title : null; })()`,
    );
    record.hoverTitle = hoverTitle;

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
    checks.hoverShowsOriginal =
      typeof hoverTitle === "string" &&
      hoverTitle.startsWith("Keep guardrails cheap.");

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
    await screenshot(cdp, page, "translate-3-off.png");
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
