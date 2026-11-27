// Work Item 4: translation mode on a React page (react.dev by default) with the replace or bilingual display.
// Observes whether React puts the original text back or breaks the page, paragraphs the page adds later,
// an in-page link (SPA URL change without a reload) and a reload.
// Usage: node scripts/verify-react.ts <replace|bilingual> <evidenceDir> --server=<url> [pageUrl] [--link=<path>]
//   --server: llama-server URL saved on the options page first (a port you own, e.g. http://127.0.0.1:18080).
//   --link:   href of the in-page link that is clicked for the SPA move (default /learn/describing-the-ui).
// Run `pnpm run build` first so dist/ is up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CdpMessage,
  evaluate,
  launchChrome,
  loadExtensionAndAttachWorker,
  sleep,
} from "./cdp.ts";
import { applyOptions, recordWorkerRequests } from "./extension.ts";

const REACT_PAGE = "https://react.dev/learn";
const args = process.argv.slice(2);
const option = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const serverUrl = option("server");
const linkPath = option("link") ?? "/learn/describing-the-ui";
const [display, evidenceDir, pageUrl = REACT_PAGE] = args.filter(
  (a) => !a.startsWith("--"),
);
if (
  (display !== "replace" && display !== "bilingual") ||
  !evidenceDir ||
  !serverUrl
) {
  console.error(
    "usage: node scripts/verify-react.ts <replace|bilingual> <evidenceDir> --server=<url> [pageUrl] [--link=<path>]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });

// Runs in the page: the article's paragraphs (same rule as content.ts: p/li/headings with English text and no
// non-empty block inside, not in code) and how many of them show a translation now. A replaced paragraph
// carries data-browser-translator="translated" and Japanese text; a bilingual one holds a lang="ja" inserted
// element with Japanese text.
const OBSERVE = `(() => {
  const ja = /[\\u3040-\\u30ff\\u4e00-\\u9fff]/;
  const ins = '[data-browser-translator="inserted"]';
  const bare = (el) => {
    const copy = el.cloneNode(true);
    for (const m of copy.querySelectorAll(ins)) m.remove();
    return copy.textContent.replace(/\\s+/g, " ").trim();
  };
  // A replaced paragraph's original text is its title.
  const source = (el) => el.getAttribute("data-browser-translator") === "translated" ? el.title : bare(el);
  const article = [...document.querySelectorAll("article p, article li, article h1, article h2, article h3, article h4")]
    .filter((el) => !el.closest("pre, code") && !el.closest(ins) && /[A-Za-z]/.test(source(el)))
    .filter((el) => ![...el.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, ul, ol, div, table, blockquote")]
      .some((b) => !b.closest(ins) && /\\S/.test(b.textContent)));
  const shows = (el) =>
    el.getAttribute("data-browser-translator") === "translated"
      ? ja.test(el.textContent)
      : [...el.children].some((c) => c.matches(ins + '[lang="ja"]') && ja.test(c.textContent));
  const failed = (el) => [...el.children].some((c) => c.matches(ins) && (c.title || "").startsWith("翻訳できませんでした"));
  const replaced = [...document.querySelectorAll('[data-browser-translator="translated"]')];
  const added = [...document.querySelectorAll(ins + '[lang="ja"]')];
  return {
    url: location.href,
    title: document.title,
    marker: window.__browserTranslatorVerifyMarker === true,
    articleCandidates: article.length,
    articleTranslated: article.filter(shows).length,
    articleFailed: article.filter(failed).length,
    articleUntranslated: article.filter((el) => !shows(el) && !failed(el)).map((el) => bare(el).slice(0, 100)),
    notJapanese: replaced.filter((el) => !ja.test(el.textContent)).map((el) => el.textContent.slice(0, 100)),
    replacedCount: replaced.length,
    bilingualCount: added.length,
    nestedInserted: document.querySelectorAll(ins + " " + ins).length,
    bilingualNotBlockAtEnd: added.filter((out) => !(out.parentElement.lastElementChild === out && getComputedStyle(out).display === "block")).length,
    markers: document.querySelectorAll("[data-browser-translator]").length,
    scrollHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

interface Observation {
  url: string;
  title: string;
  marker: boolean;
  articleCandidates: number;
  articleTranslated: number;
  articleFailed: number;
  articleUntranslated: string[];
  replacedCount: number;
  bilingualCount: number;
  notJapanese: string[];
  nestedInserted: number;
  bilingualNotBlockAtEnd: number;
  markers: number;
  scrollHeight: number;
  horizontalOverflow: boolean;
}

const ADDED_TEXT =
  "This paragraph was added by the page after translation mode was turned on.";

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  display,
  pageUrl,
  linkPath,
  serverUrl,
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
  const requests = await recordWorkerRequests(cdp, sw);
  const options = await applyOptions(cdp, extensionId, sw, {
    url: serverUrl,
    screenshot: join(evidenceDir, `react-${display}-options.png`),
    display,
  });
  record.options = { saveStatus: options.saveStatus, stored: options.stored };
  checks.optionsSaved =
    options.stored.url === serverUrl && options.stored.display === display;

  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  // Page errors (React hydration errors and others) and main-frame navigations, recorded for the whole run.
  const pageErrors: { at: string; text: string }[] = [];
  const navigations: { at: string; kind: string; url: string }[] = [];
  const bfcacheNotUsed: string[] = [];
  let phase = "load";
  cdp.onEvent((msg: CdpMessage) => {
    if (msg.sessionId !== page) return;
    const p = msg.params;
    if (msg.method === "Runtime.exceptionThrown")
      pageErrors.push({
        at: phase,
        text: String(
          p.exceptionDetails.exception?.description ?? p.exceptionDetails.text,
        ).slice(0, 400),
      });
    else if (msg.method === "Runtime.consoleAPICalled" && p.type === "error")
      pageErrors.push({
        at: phase,
        text: p.args
          .map(
            (a: { value?: string | number | boolean; description?: string }) =>
              a.value === undefined ? (a.description ?? "") : String(a.value),
          )
          .join(" ")
          .slice(0, 400),
      });
    else if (msg.method === "Page.frameNavigated" && !p.frame.parentId)
      navigations.push({ at: phase, kind: "document", url: p.frame.url });
    else if (msg.method === "Page.backForwardCacheNotUsed")
      bfcacheNotUsed.push(
        ...p.notRestoredExplanations.map(
          (e: { reason: string }) => `${phase}: ${e.reason}`,
        ),
      );
    else if (msg.method === "Page.navigatedWithinDocument")
      navigations.push({ at: phase, kind: "same-document", url: p.url });
  });
  await cdp.send("Page.enable", {}, page);
  await cdp.send("Runtime.enable", {}, page);

  const screenshot = async (name: string) => {
    const { data }: { data: string } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      page,
    );
    writeFileSync(
      join(evidenceDir, `react-${display}-${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const observe = (): Promise<Observation> => evaluate(cdp, page, OBSERVE);
  const completions = (from = 0) =>
    requests.slice(from).filter((r) => r.url.endsWith("/v1/completions"));
  // Done when the article's translated + failed count stops changing and no request is in flight.
  async function settle(from: number): Promise<number> {
    const t0 = Date.now();
    let last = -1;
    let stableFor = 0;
    while (stableFor < 6 && Date.now() - t0 < 600000) {
      await sleep(1000);
      const o = await observe();
      const done = o.articleTranslated + o.articleFailed;
      const idle = requests.slice(from).every((r) => r.finished !== undefined);
      stableFor = done === last && done > 0 && idle ? stableFor + 1 : 0;
      last = done;
    }
    return Math.round((Date.now() - t0) / 1000);
  }
  const translatedEnough = (o: Observation) =>
    o.articleCandidates > 0 &&
    o.articleTranslated + o.articleFailed >= o.articleCandidates;

  const loaded = cdp.waitFor(
    "Page.loadEventFired",
    (_p, msg) => msg.sessionId === page,
    60000,
  );
  await cdp.send("Page.navigate", { url: pageUrl }, page);
  await loaded;
  await sleep(3000); // React hydrates after the load event
  await cdp.send("Target.activateTarget", { targetId });
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
  // Survives same-document navigation only; a reload or normal navigation starts a new window.
  await evaluate(cdp, page, "window.__browserTranslatorVerifyMarker = true");
  const before = await observe();
  record.before = { ...before, articleUntranslated: undefined };
  await screenshot("0-before");

  // 1. Translate the page.
  phase = "translate";
  await clickToolbarButton();
  const tabId: number = await evaluate(
    cdp,
    sw,
    `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(pageUrl)}).id)`,
  );
  const badge = (): Promise<string> =>
    evaluate(cdp, sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  await sleep(1000);
  record.badgeOn = await badge();
  record.translateSeconds = await settle(0);
  const translated = await observe();
  record.translated = translated;
  await evaluate(cdp, page, "window.scrollTo(0, 0)");
  await screenshot("1-translated");
  checks.badgeOn = record.badgeOn === "ON";
  checks.translated = translatedEnough(translated);
  checks.noNestedInserted = translated.nestedInserted === 0;
  if (display === "bilingual")
    checks.bilingualBelow =
      translated.replacedCount === 0 &&
      translated.bilingualCount > 0 &&
      translated.bilingualNotBlockAtEnd === 0;

  // 2. Leave the page alone, scroll through it and hover a link: does React put the original back?
  phase = "idle";
  const idleFrom = requests.length;
  await sleep(5000);
  const height = translated.scrollHeight;
  for (let y = 0; y <= height; y += 800) {
    await evaluate(cdp, page, `window.scrollTo(0, ${y})`);
    await sleep(150);
  }
  await evaluate(cdp, page, "window.scrollTo(0, 0)");
  const hover: { x: number; y: number } | null = await evaluate(
    cdp,
    page,
    `(() => { const a = document.querySelector("article a[href^='/learn/']"); if (!a) return null; a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (hover)
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: hover.x, y: hover.y },
      page,
    );
  await sleep(5000);
  const afterIdle = await observe();
  record.afterIdle = afterIdle;
  record.idleRequests = completions(idleFrom).length;
  await evaluate(cdp, page, "window.scrollTo(0, 0)");
  await screenshot("2-after-idle");
  // Recorded, not required: React restoring the original is what the bilingual display is the way out of.
  // content.ts unmarks a paragraph the page puts back at once and translates it again, so a revert shows as
  // idleRequests > 0 and, if the page keeps it original, as fewer translations shown than before.
  record.shownBeforeIdle = translated.replacedCount + translated.bilingualCount;
  record.shownAfterIdle = afterIdle.replacedCount + afterIdle.bilingualCount;
  checks.stillTranslatedAfterIdle = translatedEnough(afterIdle);

  // 3. The page adds a paragraph to the article; it gets translated, and nothing loops.
  phase = "added";
  const addFrom = requests.length;
  await evaluate(
    cdp,
    page,
    `(() => { const p = document.createElement("p"); p.id = "browser-translator-verify-added"; p.textContent = ${JSON.stringify(ADDED_TEXT)}; const first = document.querySelector("article p"); first.after(p); p.scrollIntoView({ block: "center" }); })()`,
  );
  let added: { shown: boolean; text: string } = { shown: false, text: "" };
  for (let i = 0; i < 60 && !added.shown; i++) {
    await sleep(500);
    added = await evaluate(
      cdp,
      page,
      `(() => { const p = document.getElementById("browser-translator-verify-added"); return { shown: /[\\u3040-\\u30ff\\u4e00-\\u9fff]/.test(p.textContent), text: p.textContent }; })()`,
    );
  }
  await sleep(3000);
  record.added = added;
  record.addedRequests = completions(addFrom).map(
    (r) => r.body?.prompt?.length,
  );
  await screenshot("3-added");
  checks.addedTranslated = added.shown;
  // One request for the added paragraph (a retry after a tag mismatch is a second one).
  checks.addedNoLoop =
    completions(addFrom).length >= 1 && completions(addFrom).length <= 2;

  // 3b. The page redraws that paragraph with its own children (clones, without the extension's inserted
  // elements), as a framework re-render would. Bilingual: the dropped translation comes back with 1-2 requests.
  // Replace: the children are the translation, so the text is unchanged and nothing is sent.
  phase = "redrawn";
  const redrawFrom = requests.length;
  const shownNow = `/[\\u3040-\\u30ff\\u4e00-\\u9fff]/.test(document.getElementById("browser-translator-verify-added").textContent)`;
  await evaluate(
    cdp,
    page,
    `(() => { const p = document.getElementById("browser-translator-verify-added"); p.replaceChildren(...[...p.childNodes].filter((n) => !(n instanceof Element && n.hasAttribute("data-browser-translator"))).map((n) => n.cloneNode(true))); return ${shownNow}; })()`,
  );
  let redrawn = false;
  for (let i = 0; i < 60 && !redrawn; i++) {
    await sleep(500);
    redrawn = await evaluate(cdp, page, shownNow);
  }
  await sleep(3000);
  record.redrawRequests = completions(redrawFrom).length;
  checks.redrawnTranslated = redrawn;
  checks.redrawnNoLoop =
    display === "bilingual"
      ? completions(redrawFrom).length >= 1 &&
        completions(redrawFrom).length <= 2
      : completions(redrawFrom).length === 0;

  // 4. Click an in-page link: the SPA changes the URL without a reload and translation mode goes on.
  phase = "spa";
  const spaFrom = requests.length;
  const link: { x: number; y: number } | null = await evaluate(
    cdp,
    page,
    `(() => { const a = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === ${JSON.stringify(linkPath)} && a.closest("article")) ?? [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === ${JSON.stringify(linkPath)}); if (!a) return null; a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 20), y: r.y + r.height / 2 }; })()`,
  );
  if (!link) throw new Error(`link ${linkPath} not found`);
  await sleep(300);
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type, x: link.x, y: link.y, button: "left", clickCount: 1 },
      page,
    );
  let spaUrl = "";
  for (let i = 0; i < 40 && !spaUrl.endsWith(linkPath); i++) {
    await sleep(250);
    spaUrl = await evaluate(cdp, page, "location.pathname");
  }
  await sleep(1500);
  const spaBadgeSoon = await badge();
  record.spaSeconds = await settle(spaFrom);
  const spa = await observe();
  record.spa = spa;
  record.spaBadgeSoon = spaBadgeSoon;
  record.spaBadge = await badge();
  record.spaRequests = completions(spaFrom).length;
  await evaluate(cdp, page, "window.scrollTo(0, 0)");
  await screenshot("4-spa");
  checks.spaSameDocument =
    spaUrl.endsWith(linkPath) &&
    spa.marker &&
    !navigations.some((n) => n.at === "spa" && n.kind === "document");
  checks.spaBadgeOn = spaBadgeSoon === "ON" && record.spaBadge === "ON";
  checks.spaTranslated =
    translatedEnough(spa) && completions(spaFrom).length > 0;

  // 5. No loop: with nothing changing, no more requests go out.
  phase = "quiet";
  const quietFrom = requests.length;
  await sleep(8000);
  record.quietRequests = completions(quietFrom).length;
  checks.quietNoRequests = completions(quietFrom).length === 0;

  // 6. Off: the extension's marks and inserted elements are gone.
  phase = "off";
  await clickToolbarButton();
  await sleep(1000);
  const off = await observe();
  const offBadge = await badge();
  record.off = { markers: off.markers, badge: offBadge };
  await screenshot("5-off");
  checks.offNoMarkers = off.markers === 0;
  checks.offBadgeCleared = offBadge === "";

  // 7. On again, then reload: the mode ends (no marks, empty badge, a new window).
  phase = "reload";
  await clickToolbarButton();
  await sleep(3000);
  const onAgain = await badge();
  const reloaded = cdp.waitFor(
    "Page.loadEventFired",
    (_p, msg) => msg.sessionId === page,
    60000,
  );
  await cdp.send("Page.reload", {}, page);
  await reloaded;
  await sleep(4000);
  const reload = await observe();
  const reloadBadge = await badge();
  record.reload = {
    onAgain,
    markers: reload.markers,
    marker: reload.marker,
    badge: reloadBadge,
  };
  await screenshot("6-reload");
  checks.reloadEndsMode =
    onAgain === "ON" &&
    reload.markers === 0 &&
    !reload.marker &&
    reloadBadge === "";

  // 8. On again, a normal navigation to another document, then back in history. Chrome may restore the
  // translated document from the back/forward cache (the window marker survives); the mode must still be over:
  // no marks, empty badge, and the button turns it on (badge ON) rather than off.
  phase = "back";
  await evaluate(cdp, page, "window.__browserTranslatorVerifyMarker = true");
  await clickToolbarButton();
  for (let i = 0; i < 30 && (await observe()).markers === 0; i++)
    await sleep(500);
  const beforeLeave = await observe();
  const awayLoaded = cdp.waitFor(
    "Page.loadEventFired",
    (_p, msg) => msg.sessionId === page,
    60000,
  );
  await cdp.send(
    "Page.navigate",
    { url: new URL("/blog", pageUrl).href },
    page,
  );
  await awayLoaded;
  await sleep(2000);
  const history: { currentIndex: number; entries: { id: number }[] } =
    await cdp.send("Page.getNavigationHistory", {}, page);
  await cdp.send(
    "Page.navigateToHistoryEntry",
    { entryId: history.entries[history.currentIndex - 1].id },
    page,
  );
  await sleep(4000);
  const back = await observe();
  const backBadge = await badge();
  await screenshot("7-back");
  await clickToolbarButton();
  await sleep(2000);
  const backPressBadge = await badge();
  record.back = {
    markersBeforeLeave: beforeLeave.markers,
    url: back.url,
    restoredFromCache: back.marker,
    bfcacheNotUsed,
    markers: back.markers,
    badge: backBadge,
    badgeAfterPress: backPressBadge,
  };
  checks.backEndsMode =
    beforeLeave.markers > 0 &&
    back.markers === 0 &&
    backBadge === "" &&
    backPressBadge === "ON";

  record.pageErrors = pageErrors;
  record.navigations = navigations;
  record.totalCompletions = completions().length;
  // Recorded, not required (React may log its own errors on a page the extension changed).
  record.errorsAfterTranslation = pageErrors.filter(
    (e) => e.at !== "load",
  ).length;
  checks.allRequestsToServer = requests.every(
    (r) =>
      r.url.startsWith(`${serverUrl}/`) ||
      r.url === "http://127.0.0.1:8080/v1/models",
  );
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
    join(evidenceDir, `react-${display}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}
console.log(
  JSON.stringify(
    { checks: record.checks, ok: record.ok, error: record.error },
    null,
    2,
  ),
);
process.exit(record.ok ? 0 : 1);
