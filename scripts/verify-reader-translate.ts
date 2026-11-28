// Work Item 15: translation inside the reader. Drives a real Chrome with dist/ loaded: translation mode with the reader
// open and closed, the bar's translate button, the original-text bubble inside the reader per background and font,
// and the connection error notice over the reader. Requests are counted on the service worker's Network domain.
// Usage: node scripts/verify-reader-translate.ts <replace|bilingual|unreachable> <evidenceDir> --server=<url> [pageUrl]
//   replace / bilingual: llama-server must be listening on --server; the options page saves it and the display.
//   unreachable: nothing may be listening on --server.
// The first reader open presses the shortcut (Alt+Shift+R, grants activeTab); later toggles call the service
// worker's toggleReaderTab(tabId). The toolbar button is CDP Extensions.triggerAction.
// Run `pnpm run build` first so dist/ is up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bubbleSide } from "../src/bubble.ts";
import {
  type CdpPipe,
  evaluate,
  launchChrome,
  loadExtensionAndAttachWorker,
  sleep,
} from "./cdp.ts";
import {
  applyOptions,
  pfml3Elements,
  recordWorkerRequests,
  type WorkerRequest,
} from "./extension.ts";

const REFERENCE_PAGE =
  "https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga";
const args = process.argv.slice(2);
const serverUrl = args
  .find((a) => a.startsWith("--server="))
  ?.slice("--server=".length);
const [mode, evidenceDir, pageUrl = REFERENCE_PAGE] = args.filter(
  (a) => !a.startsWith("--"),
);
if (
  (mode !== "replace" && mode !== "bilingual" && mode !== "unreachable") ||
  !evidenceDir ||
  !serverUrl
) {
  console.error(
    "usage: node scripts/verify-reader-translate.ts <replace|bilingual|unreachable> <evidenceDir> --server=<url> [pageUrl]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });
const name = `reader-translate-${mode}`;

// A paragraph the helper adds to the page body while the reader is open; its text is sent only after closing.
const ADDED_TEXT =
  "Verification paragraph: the lighthouse keeper counted seventeen quiet zebras at dawn.";

// Runs in the page: shared helpers (same paragraph rule and text as content.ts).
const LIB = `
  const MARK = "data-browser-translator";
  const ins = '[data-browser-translator="inserted"]';
  const ja = /[\\u3040-\\u30ff\\u4e00-\\u9fff]/;
  const textOf = (el) => {
    let t = "";
    for (const c of el.childNodes) {
      if (c.nodeType === 3) t += c.textContent;
      else if (c.nodeType === 1 && c.getAttribute(MARK) !== "inserted") t += textOf(c);
    }
    return t;
  };
  const clean = (el) => textOf(el).replace(/\\s+/g, " ").trim();
  const hosts = () => [...document.documentElement.children].filter((h) => h.matches(ins) && h.shadowRoot);
  const readerHost = () => hosts().find((h) => h.shadowRoot.querySelector(".layer"));
  const bubbleHosts = () => hosts().filter((h) => !h.shadowRoot.querySelector(".layer"));
  const article = () => readerHost()?.shadowRoot.querySelector("article");
  const PARAS = "p, li, h1, h2, h3, h4, h5, h6";
  const failedIn = (el) => [...el.children].some((c) => c.matches(ins) && (c.title || "").startsWith("翻訳できませんでした"));
  const translationIn = (el) => [...el.children].find((c) => c.matches(ins + '[lang="ja"]'));
  // The element that shows the translation of el (replaced paragraph itself or the bilingual span), else null.
  const outOf = (el) => el.getAttribute(MARK) === "translated" ? el : translationIn(el) ?? null;
  const counts = (el) => {
    const copy = el.cloneNode(true);
    for (const m of copy.querySelectorAll(ins)) m.remove();
    // Sorted: a translation may put the inline elements in another order.
    return { code: [...copy.querySelectorAll("code")].map((c) => c.textContent).sort(), strong: copy.querySelectorAll("strong").length, a: [...copy.querySelectorAll("a")].map((a) => a.getAttribute("href")).sort() };
  };
`;

// Runs in the page: paragraphs of the page body (the reader's host is outside body) — translated, failed, sources.
const PAGE_STATE = `(() => {
  ${LIB}
  const els = [...document.body.querySelectorAll(PARAS)];
  const translated = els.filter((el) => outOf(el));
  const srcOf = (el) => el.getAttribute(MARK) === "translated" ? (window.__btVerifySources?.get(el) ?? "") : clean(el);
  const added = document.getElementById("bt-verify-added");
  return {
    translated: translated.length,
    failed: els.filter(failedIn).length,
    markers: document.body.querySelectorAll("[" + MARK + "]").length,
    translatedSources: translated.map(srcOf),
    untranslatedSources: els.filter((el) => !outOf(el)).map(clean),
    added: added && { text: added.textContent, translated: !!outOf(added) && ja.test(outOf(added).textContent), failed: failedIn(added) },
  };
})()`;

// Runs in the page: what the reader's article shows. original is the article as opened with translation off.
const READER_STATE = `(() => {
  ${LIB}
  const host = readerHost();
  const art = article();
  const root = host?.shadowRoot;
  const btn = root?.querySelector('[data-action="translate"]');
  if (!art) return { open: false, hosts: hosts().length, bubbles: bubbleHosts().length };
  const els = [...art.querySelectorAll(PARAS)];
  const orig = window.__btVerifyReaderOriginal;
  const entries = els.map((el, i) => ({ el, i, out: outOf(el) })).filter((e) => e.out);
  // Inline elements kept: the translation has the same code (and text), strong and link targets as the original.
  const inlineLost = entries.filter((e) => {
    const o = orig?.inline[e.i];
    const t = counts(e.out);
    return !o || JSON.stringify(o) !== JSON.stringify(t);
  }).map((e) => ({ i: e.i, source: orig?.sources[e.i], html: e.out.innerHTML.slice(0, 300), original: orig?.inline[e.i], translated: counts(e.out) }));
  return {
    open: true,
    hosts: hosts().length,
    bubbles: bubbleHosts().length,
    paragraphs: els.length,
    translated: entries.length,
    japanese: entries.filter((e) => ja.test(e.out.textContent)).length,
    replaced: art.querySelectorAll('[' + MARK + '="translated"]').length,
    bilingualSpans: art.querySelectorAll(ins + '[lang="ja"]').length,
    failed: els.filter(failedIn).length,
    failedSources: els.filter(failedIn).map((el) => clean(el).slice(0, 120)),
    markers: art.querySelectorAll("[" + MARK + "]").length,
    inlineLost,
    inlineChecked: entries.filter((e) => orig && (orig.inline[e.i].code.length + orig.inline[e.i].strong + orig.inline[e.i].a.length) > 0).length,
    sameAsOriginal: !!orig && art.innerHTML === orig.html && art.textContent === orig.text,
    firstDiff: orig && art.innerHTML !== orig.html ? (() => {
      const a = art.innerHTML; const o = orig.html; let i = 0;
      while (i < a.length && a[i] === o[i]) i++;
      return { at: i, original: o.slice(Math.max(0, i - 120), i + 200), now: a.slice(Math.max(0, i - 120), i + 200) };
    })() : undefined,
    sameParagraphCount: !!orig && orig.sources.length === els.length,
    // The kept copy is of this open and had no marks yet.
    keptAtOpen: !!orig && orig.markers === 0 && window.__btVerifyOpens,
    button: btn && { state: btn.dataset.state, pressed: btn.getAttribute("aria-pressed"), text: btn.textContent, disabled: btn.disabled },
    articleFont: getComputedStyle(art).fontFamily,
  };
})()`;

// Runs in the page: each time the reader's host is attached, keeps its article as drawn (before any translation
// response can arrive) in the main world. Each open is a new copy of the page, which react.dev changes by itself.
const KEEP_READER_ORIGINAL = `(() => {
  ${LIB}
  window.__btVerifyOpens = 0;
  new MutationObserver(() => {
    const art = article();
    if (!art || art === window.__btVerifyArticle) return;
    window.__btVerifyArticle = art;
    window.__btVerifyOpens++;
    window.__btVerifyOpenedAt = Date.now();
    const els = [...art.querySelectorAll(PARAS)];
    window.__btVerifyReaderOriginal = { html: art.innerHTML, text: art.textContent, sources: els.map(clean), inline: els.map(counts),
      markers: art.querySelectorAll("[" + MARK + "]").length };
  }).observe(document.documentElement, { childList: true });
})()`;

// Runs in the page before translation: the page's paragraphs (source text in a WeakMap) and a DOM snapshot.
const PAGE_BEFORE = `(() => {
  ${LIB}
  window.__btVerifySources = new WeakMap();
  for (const el of document.body.querySelectorAll(PARAS)) window.__btVerifySources.set(el, clean(el));
  // Paragraphs only: react.dev replaces its pre placeholders (Sandpack) by itself while the page is open.
  // class attributes left out: react.dev moves the highlight of its "On this page" list as the page scrolls.
  window.__btVerifyPageSnapshot = [...document.body.querySelectorAll(PARAS)].map((el) => el.outerHTML.replace(/ class="[^"]*"/g, ""));
  return window.__btVerifyPageSnapshot.length;
})()`;

const PAGE_RESTORED = `(() => {
  const now = [...document.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6")].filter((el) => el.id !== "bt-verify-added").map((el) => el.outerHTML.replace(/ class="[^"]*"/g, ""));
  const before = window.__btVerifyPageSnapshot;
  const diffs = before.map((b, i) => ({ i, b, a: now[i] })).filter((d) => d.a !== d.b);
  return { before: before.length, now: now.length, diffs: diffs.slice(0, 5).map((d) => ({ i: d.i, before: d.b.slice(0, 300), after: (d.a ?? "").slice(0, 300) })), diffCount: diffs.length,
    markers: document.querySelectorAll("[data-browser-translator]").length };
})()`;

// Runs in the page: the translated reader paragraph (two lines or more) scrolled to block, and the bubble.
const bubbleObservation = (block: string) => `(() => {
  ${LIB}
  const art = article();
  const orig = window.__btVerifyReaderOriginal;
  const els = [...art.querySelectorAll(PARAS)];
  let el = window.__btVerifyHover;
  if (!el || !el.isConnected) {
    // Far enough down the reader that it can also be scrolled to the bottom edge (for the bubble above).
    const layer = readerHost().shadowRoot.querySelector(".layer");
    el = els.find((e) => e.localName === "p" && e.getAttribute(MARK) === "translated" && e.getBoundingClientRect().height > 40 &&
      e.getBoundingClientRect().top + layer.scrollTop > innerHeight);
    window.__btVerifyHover = el;
  }
  if (!el) return null;
  ${block ? `el.scrollIntoView({ block: ${JSON.stringify(block)} });` : ""}
  const r = el.getBoundingClientRect();
  const bs = bubbleHosts();
  const host = bs[0];
  const text = host?.shadowRoot.querySelector("div");
  const b = host?.getBoundingClientRect();
  const s = text && getComputedStyle(text);
  return {
    paragraph: { top: r.top, bottom: r.bottom, left: r.left, width: r.width, x: r.left + 20, y: r.top + 10,
      fontSize: getComputedStyle(el).fontSize, hasTitle: el.hasAttribute("title"), source: orig.sources[els.indexOf(el)] },
    articleFont: getComputedStyle(art).fontFamily,
    viewportHeight: document.documentElement.clientHeight,
    bubbles: bs.length,
    bubble: host && {
      parent: host.parentElement.localName,
      afterReader: readerHost().compareDocumentPosition(host) === Node.DOCUMENT_POSITION_FOLLOWING,
      zIndex: getComputedStyle(host).zIndex,
      shadowMode: host.shadowRoot.mode,
      text: text?.textContent,
      fontSize: s?.fontSize, fontFamily: s?.fontFamily, userSelect: s?.userSelect,
      backgroundColor: s?.backgroundColor, borderColor: s?.borderTopColor, color: s?.color,
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
  articleFont: string;
  viewportHeight: number;
  bubbles: number;
  bubble?: {
    parent: string;
    afterReader: boolean;
    zIndex: string;
    shadowMode: string;
    text: string;
    fontSize: string;
    fontFamily: string;
    userSelect: string;
    backgroundColor: string;
    borderColor: string;
    color: string;
    top: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
    x: number;
    y: number;
  };
}

// Plan「吹き出しの見た目」: background, border, text per reader background.
const BUBBLE_COLORS = {
  black: ["rgb(45, 45, 45)", "rgb(90, 90, 90)", "rgb(230, 230, 230)"],
  sepia: ["rgb(255, 246, 204)", "rgb(184, 146, 26)", "rgb(62, 47, 34)"],
  white: ["rgb(255, 246, 204)", "rgb(184, 146, 26)", "rgb(31, 31, 31)"],
} as const;

// The input paragraph of a completion request as plain text (tags dropped, entities back, whitespace collapsed).
function sourceOf(r: WorkerRequest): string | undefined {
  if (!r.url.endsWith("/v1/completions")) return undefined;
  const input = pfml3Elements(r.body?.prompt ?? "")
    .filter((e) => e.name === "input")
    .at(-1);
  return input?.body
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Waits until the translated + failed count of read() stops changing (6 s), at most 300 s.
async function waitTranslated<T extends { translated: number; failed: number }>(
  read: () => Promise<T>,
) {
  let last = -1;
  let stableFor = 0;
  let state = await read();
  const t0 = Date.now();
  while (stableFor < 6 && Date.now() - t0 < 300000) {
    await sleep(1000);
    state = await read();
    const done = state.translated + state.failed;
    stableFor = done === last && done > 0 ? stableFor + 1 : 0;
    last = done;
  }
  return { state, seconds: Math.round((Date.now() - t0) / 1000) };
}

async function screenshot(
  cdp: CdpPipe,
  page: string,
  file: string,
): Promise<void> {
  const { data }: { data: string } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    page,
  );
  writeFileSync(join(evidenceDir, file), Buffer.from(data, "base64"));
}

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  mode,
  pageUrl,
  serverUrl,
  extensionPath,
  startedAt: new Date().toISOString(),
};
const observed: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};
try {
  const { cdp } = chrome;
  record.chrome = (await cdp.send("Browser.getVersion")).product;
  const { extensionId, sessionId: sw } = await loadExtensionAndAttachWorker(
    cdp,
    extensionPath,
  );
  const display = mode === "bilingual" ? "bilingual" : "replace";
  const options = await applyOptions(cdp, extensionId, sw, {
    url: serverUrl,
    screenshot: join(evidenceDir, `${name}-options.png`),
    display,
  });
  checks.optionsSaved =
    options.stored.url === serverUrl && options.stored.display === display;
  const requests = await recordWorkerRequests(cdp, sw);
  const completions = (from: number, to = requests.length) =>
    requests.slice(from, to).filter((r) => r.url.endsWith("/v1/completions"));

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
  await sleep(2500);
  await cdp.send("Target.activateTarget", { targetId });
  const href: string = await evaluate(cdp, page, "location.href");
  const {
    targetInfos: tabs,
  }: { targetInfos: { targetId: string; url: string }[] } = await cdp.send(
    "Target.getTargets",
    { filter: [{ type: "tab" }] },
  );
  const tabTarget = tabs.find((t) => t.url === href)?.targetId;
  if (!tabTarget) throw new Error("tab target of the page not found");
  const clickToolbarButton = () =>
    cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: tabTarget,
    });

  const key = async (
    k: { key: string; code: string; keyCode: number; macKeyCode: number },
    modifiers = 0,
  ) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type,
          modifiers,
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.keyCode,
          nativeVirtualKeyCode: k.macKeyCode,
        },
        page,
      );
  };
  // Alt (1) + Shift (8) + R: the reader's suggested shortcut.
  const pressShortcut = () =>
    key({ key: "R", code: "KeyR", keyCode: 82, macKeyCode: 15 }, 1 | 8);
  const tabId: number = await evaluate(
    cdp,
    sw,
    "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id)",
  );
  const badge = (): Promise<string> =>
    evaluate(cdp, sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  const readerState = () => evaluate(cdp, page, READER_STATE);
  const pageState = () => evaluate(cdp, page, PAGE_STATE);
  const waitOpen = async (open: boolean) => {
    for (let i = 0; i < 50; i++) {
      if ((await readerState()).open === open) return true;
      await sleep(100);
    }
    return false;
  };
  const toggleReader = async (open: boolean) => {
    await evaluate(cdp, sw, `toggleReaderTab(${tabId})`);
    await waitOpen(open);
    await sleep(300);
  };
  const move = (x: number, y: number) =>
    cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page);
  // Clicks the center of an element of the reader's bar.
  const clickBar = async (action: string) => {
    const point: { x: number; y: number } | null = await evaluate(
      cdp,
      page,
      `(() => {
        ${LIB}
        const el = readerHost()?.shadowRoot.querySelector('[data-action="${action}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
    if (!point) throw new Error(`not in the reader's bar: ${action}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type, x: point.x, y: point.y, button: "left", clickCount: 1 },
        page,
      );
    await sleep(400);
  };
  const waitReaderTranslated = async () =>
    (await waitTranslated(readerState)).seconds;

  await evaluate(cdp, page, PAGE_BEFORE);
  await evaluate(cdp, page, KEEP_READER_ORIGINAL);
  await screenshot(cdp, page, `${name}-0-before.png`);

  // --- Translation off: the reader opens with the original text and nothing is sent.
  const offOpenFrom = requests.length;
  await pressShortcut();
  checks.offOpens = await waitOpen(true);
  await sleep(1500);
  const offOpen = await readerState();
  const readerParagraphs: number = offOpen.paragraphs;
  const offOpenSources: string[] = await evaluate(
    cdp,
    page,
    "window.__btVerifyReaderOriginal.sources",
  );
  observed.offOpen = { ...offOpen, readerParagraphs };
  checks.offOpenOriginal =
    offOpen.keptAtOpen === 1 &&
    offOpen.markers === 0 &&
    offOpen.button?.state === "off" &&
    offOpen.button.pressed === "false" &&
    offOpen.button.disabled === false &&
    completions(offOpenFrom).length === 0 &&
    (await badge()) === "";
  await screenshot(cdp, page, `${name}-1-off-open.png`);
  await toggleReader(false);

  if (mode === "unreachable") {
    // --- Connection error with the reader open: the notice is above the reader.
    await toggleReader(true);
    await clickToolbarButton();
    let notice: {
      text: string;
      parent: string;
      shadow: boolean;
      hitIsNotice: boolean;
    } | null = null;
    for (let i = 0; i < 40 && !notice; i++) {
      await sleep(250);
      notice = await evaluate(
        cdp,
        page,
        `(() => {
          ${LIB}
          const n = [...document.querySelectorAll(ins)].find((e) => !e.shadowRoot && e.textContent.includes("接続できません"));
          if (!n) return null;
          const r = n.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { text: n.textContent, parent: n.parentElement.localName, shadow: !!n.shadowRoot, hitIsNotice: hit === n || n.contains(hit),
            rect: { top: r.top, left: r.left, width: r.width, height: r.height } };
        })()`,
      );
    }
    await sleep(300);
    const r = await readerState();
    const b = await badge();
    await screenshot(cdp, page, `${name}-2-error.png`);
    observed.error = { notice, reader: r.button, badge: b };
    checks.noticeAboveReader =
      r.open &&
      !!notice &&
      notice.text.includes(serverUrl) &&
      notice.parent === "html" &&
      notice.hitIsNotice;
    checks.badgeError = b === "ERR";
    checks.barError =
      r.button?.state === "error" && r.button.pressed === "true";
    // Off and close: nothing of the extension is left.
    await clickToolbarButton();
    await sleep(800);
    const off = await readerState();
    observed.errorOff = { button: off.button, markers: off.markers };
    await toggleReader(false);
    const restored = await evaluate(cdp, page, PAGE_RESTORED);
    observed.restored = restored;
    checks.offClosedClean =
      off.button?.state === "off" &&
      off.sameAsOriginal &&
      restored.markers === 0 &&
      restored.diffCount === 0 &&
      (await badge()) === "";
  } else {
    // --- On in the page, then the reader opens while some paragraphs are translated.
    await clickToolbarButton();
    let before = await pageState();
    for (let i = 0; i < 120 && before.translated < 3; i++) {
      await sleep(500);
      before = await pageState();
    }
    checks.badgeOn = (await badge()) === "ON";
    await toggleReader(true);
    // Requests sent after the reader's host was attached (translation mode pauses the page in the same task).
    const openedAt: number = await evaluate(
      cdp,
      page,
      "window.__btVerifyOpenedAt",
    );
    const openFrom = requests.findIndex(
      (r) => (r.wallTime ?? 0) * 1000 >= openedAt,
    );
    // The page adds a paragraph while the reader is open: it must not be sent until the reader closes.
    await evaluate(
      cdp,
      page,
      `(() => { const p = document.createElement("p"); p.id = "bt-verify-added"; p.textContent = ${JSON.stringify(ADDED_TEXT)}; document.body.append(p); })()`,
    );
    // Baseline after opening: a request sent before the reader opened may still have landed in the page.
    const pageAtOpen = await pageState();
    const translateSeconds = await waitReaderTranslated();
    const inReader = await readerState();
    const pageWhileOpen = await pageState();
    await screenshot(cdp, page, `${name}-2-reader-translated.png`);
    const closeFrom = requests.length;
    const openCompletions = completions(
      openFrom === -1 ? closeFrom : openFrom,
      closeFrom,
    );
    const openSources = openCompletions.map(sourceOf);
    // The retry of a paragraph samples at temperature 0.3 (src/background.ts); first sends are at 0.
    const firstSends = openCompletions
      .filter((r) => r.body?.temperature === 0)
      .map(sourceOf);
    const readerSources: string[] = await evaluate(
      cdp,
      page,
      "window.__btVerifyReaderOriginal.sources",
    );
    const notReader = openSources.filter(
      (s) => s === undefined || !readerSources.includes(s),
    );
    observed.whileOpen = {
      pageTranslatedBeforeOpen: before.translated,
      pageTranslatedAtOpen: pageAtOpen.translated,
      pageTranslatedBeforeClose: pageWhileOpen.translated,
      requests: openSources.length,
      notReaderSources: notReader,
      translateSeconds,
      readerSourcesAtOpen: readerSources,
      offOpenSources,
      firstSends: firstSends.length,
      reader: inReader,
    };
    const ja = /[\u3040-\u30ff\u4e00-\u9fff]/;
    // Opened from a translated page, the reader copies the original text. react.dev changes its own paragraphs
    // between the two opens, so there only the copy's marks and the sent text are compared.
    checks.readerCopiesOriginal =
      inReader.keptAtOpen === 2 &&
      (pageUrl !== REFERENCE_PAGE ||
        JSON.stringify(readerSources) === JSON.stringify(offOpenSources)) &&
      !readerSources.some((s) => ja.test(s)) &&
      !openSources.some((s) => s !== undefined && ja.test(s));
    checks.noDuplicateSendsInReader =
      firstSends.length > 0 && new Set(firstSends).size === firstSends.length;
    checks.readerTranslated =
      inReader.open &&
      inReader.sameParagraphCount &&
      inReader.translated > 0 &&
      inReader.translated + inReader.failed >= readerParagraphs * 0.9 &&
      inReader.japanese === inReader.translated &&
      (mode === "replace"
        ? inReader.bilingualSpans === 0
        : inReader.replaced === 0);
    checks.readerInlineKept =
      inReader.inlineLost.length === 0 && inReader.inlineChecked > 0;
    checks.readerBarOn =
      inReader.button?.state === "on" && inReader.button.pressed === "true";
    checks.noPageRequestsWhileOpen =
      openSources.length > 0 &&
      notReader.length === 0 &&
      !openSources.includes(ADDED_TEXT) &&
      pageWhileOpen.translated === pageAtOpen.translated &&
      pageWhileOpen.added?.translated === false &&
      pageWhileOpen.added?.failed === false;

    // --- The bubble inside the reader (replace display): per background and font.
    if (mode === "replace") {
      const observeBubble = (block = ""): Promise<BubbleObservation | null> =>
        evaluate(cdp, page, bubbleObservation(block));
      // The left margin of the reader, outside every paragraph.
      const away = async () => {
        await move(5, 600);
        await sleep(1000);
      };
      const hover = async (block: string, file: string) => {
        await away();
        const at = await observeBubble(block);
        if (!at) throw new Error("no translated paragraph in the reader");
        await sleep(300);
        const p = (await observeBubble())?.paragraph ?? at.paragraph;
        await move(p.x, p.y);
        await sleep(200);
        const early = await observeBubble();
        await sleep(500);
        const shown = await observeBubble();
        await screenshot(cdp, page, file);
        return { early: early?.bubbles ?? 0, shown };
      };
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
          b.afterReader &&
          b.shadowMode === "open" &&
          !bo.paragraph.hasTitle &&
          b.fontFamily === bo.articleFont
        );
      };
      const colorsOf = (bo: BubbleObservation | null | undefined) =>
        bo?.bubble && [
          bo.bubble.backgroundColor,
          bo.bubble.borderColor,
          bo.bubble.color,
        ];
      const bubbles: Record<string, unknown> = {};
      // Black (the default) with the gothic font: delay, content, size, side, staying and hiding.
      const center = await hover("center", `${name}-3-bubble-black.png`);
      let onBubble: BubbleObservation | null = null;
      if (center.shown?.bubble) {
        await move(center.shown.bubble.x, center.shown.bubble.y);
        await sleep(1000);
        onBubble = await observeBubble();
      }
      await away();
      const left = await observeBubble();
      const end = await hover("end", `${name}-4-bubble-above.png`);
      await away();
      bubbles.black = {
        center: { ...center, side: center.shown && side(center.shown) },
        onBubble: onBubble?.bubbles,
        afterLeaving: left?.bubbles,
        end: { ...end, side: end.shown && side(end.shown) },
      };
      checks.readerBubbleShowsOriginal =
        center.early === 0 &&
        center.shown?.bubbles === 1 &&
        matches(center.shown);
      checks.readerBubblePlacement =
        !!center.shown &&
        side(center.shown) === expectedSide(center.shown) &&
        !!end.shown &&
        matches(end.shown) &&
        side(end.shown) === expectedSide(end.shown) &&
        side(end.shown) === "above";
      checks.readerBubbleStaysOnHover = onBubble?.bubbles === 1;
      checks.readerBubbleHidesOnLeave = left?.bubbles === 0;
      const black = colorsOf(center.shown);
      checks.readerBubbleBlack =
        JSON.stringify(black) === JSON.stringify(BUBBLE_COLORS.black);
      const gothicFont = center.shown?.bubble?.fontFamily;
      checks.readerBubbleGothic =
        !!gothicFont &&
        gothicFont === center.shown?.articleFont &&
        gothicFont.startsWith('"Hiragino Sans"');
      for (const theme of ["sepia", "white"] as const) {
        await clickBar(`theme-${theme}`);
        const t = await hover("center", `${name}-3-bubble-${theme}.png`);
        await away();
        bubbles[theme] = t;
        checks[`readerBubble${theme === "sepia" ? "Sepia" : "White"}`] =
          t.shown?.bubbles === 1 &&
          matches(t.shown) &&
          JSON.stringify(colorsOf(t.shown)) ===
            JSON.stringify(BUBBLE_COLORS[theme]);
      }
      await clickBar("font-mincho");
      const mincho = await hover("center", `${name}-3-bubble-white-mincho.png`);
      await away();
      bubbles.mincho = mincho;
      checks.readerBubbleMincho =
        mincho.shown?.bubbles === 1 &&
        matches(mincho.shown) &&
        !!mincho.shown.bubble?.fontFamily.startsWith('"Hiragino Mincho ProN"');
      await clickBar("theme-black");
      await clickBar("font-gothic");
      observed.bubbles = bubbles;
    }

    // --- Closing: the page's translation resumes without the paragraphs it had translated.
    const closeAt = requests.length;
    await toggleReader(false);
    const closed = await readerState();
    const afterClose = (await waitTranslated(pageState)).state;
    await evaluate(
      cdp,
      page,
      `document.getElementById("bt-verify-added")?.scrollIntoView({ block: "center" })`,
    );
    await sleep(300);
    await screenshot(cdp, page, `${name}-5-closed-page.png`);
    const resumedSources = completions(closeAt).map(sourceOf);
    // A text also held by a paragraph not translated at open is sent for that one.
    const resent = resumedSources.filter(
      (s) =>
        s !== undefined &&
        pageAtOpen.translatedSources.includes(s) &&
        !pageAtOpen.untranslatedSources.includes(s),
    );
    observed.afterClose = {
      hosts: closed.hosts,
      bubbles: closed.bubbles,
      requests: resumedSources.length,
      resentTranslatedBeforeOpen: resent,
      pageTranslated: afterClose.translated,
      pageFailed: afterClose.failed,
      added: afterClose.added,
    };
    checks.closeRemovesReader = !closed.open && closed.hosts === 0;
    checks.pageResumes =
      resumedSources.length > 0 &&
      afterClose.translated > pageAtOpen.translated &&
      resent.length === 0;
    checks.addedTranslatedAfterClose =
      resumedSources.includes(ADDED_TEXT) &&
      (afterClose.added?.translated === true ||
        afterClose.added?.failed === true);

    if (mode === "replace") {
      // --- Page bubble over a web component: a translated page paragraph gets an empty child with an open shadow
      // root (the light DOM text is unchanged, so the paragraph is not sent again); the mouse rests on its inside.
      await move(1, 1);
      await sleep(1000);
      const target: { x: number; y: number; source: string } | null =
        await evaluate(
          cdp,
          page,
          `(() => {
            ${LIB}
            const el = [...document.body.querySelectorAll(PARAS)].find((e) => {
              const r = e.getBoundingClientRect();
              return e.getAttribute(MARK) === "translated" && r.top > 50 && r.bottom < innerHeight - 50 && r.height > 20;
            });
            if (!el) return null;
            const host = document.createElement("span");
            host.id = "bt-verify-shadow-host";
            host.attachShadow({ mode: "open" }).innerHTML = '<b style="display:inline-block;padding:4px">[web component]</b>';
            el.prepend(host);
            window.__btVerifyShadowParagraph = el;
            const r = host.shadowRoot.querySelector("b").getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, source: window.__btVerifySources.get(el) };
          })()`,
        );
      if (!target)
        throw new Error("no visible translated paragraph in the page");
      await sleep(500);
      await move(target.x, target.y);
      await sleep(900);
      const shadowHover: {
        hit: string;
        stillTranslated: boolean;
        bubbles: string[];
      } = await evaluate(
        cdp,
        page,
        `(() => {
          ${LIB}
          const el = window.__btVerifyShadowParagraph;
          const host = document.getElementById("bt-verify-shadow-host");
          return { hit: host.shadowRoot.elementFromPoint(${target.x}, ${target.y})?.localName ?? "",
            stillTranslated: el.getAttribute(MARK) === "translated",
            bubbles: bubbleHosts().map((h) => h.shadowRoot.querySelector("div")?.textContent ?? "") };
        })()`,
      );
      await screenshot(cdp, page, `${name}-5b-page-bubble-shadow.png`);
      observed.pageBubbleInShadow = { source: target.source, ...shadowHover };
      checks.pageBubbleInsideShadowDom =
        shadowHover.hit === "b" &&
        shadowHover.stillTranslated &&
        shadowHover.bubbles.length === 1 &&
        shadowHover.bubbles[0] === target.source;

      // --- A page paragraph hovered right before the reader opens: its bubble must not show over the reader.
      await move(1, 1);
      await sleep(1000);
      const p: { x: number; y: number; source: string } | null = await evaluate(
        cdp,
        page,
        `(() => {
          ${LIB}
          const el = [...document.body.querySelectorAll(PARAS)].find((e) => {
            const r = e.getBoundingClientRect();
            return e !== window.__btVerifyShadowParagraph && e.getAttribute(MARK) === "translated" && r.top > 50 && r.bottom < innerHeight - 50 && r.height > 20;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + 20, y: r.top + r.height / 2, source: window.__btVerifySources.get(el) };
        })()`,
      );
      if (!p)
        throw new Error("no second visible translated paragraph in the page");
      const hoveredAt = Date.now();
      await move(p.x, p.y);
      await pressShortcut();
      const opened = await waitOpen(true);
      const openedAfterMs: number =
        (await evaluate(cdp, page, "window.__btVerifyOpenedAt")) - hoveredAt;
      // The mouse is not moved: a move onto the reader would cancel the page's pending bubble by itself.
      await sleep(1000);
      const overReader: { text: string; background: string }[] = await evaluate(
        cdp,
        page,
        `(() => {
          ${LIB}
          return bubbleHosts().map((h) => {
            const d = h.shadowRoot.querySelector("div");
            return { text: d?.textContent ?? "", background: d ? getComputedStyle(d).backgroundColor : "" };
          });
        })()`,
      );
      await screenshot(cdp, page, `${name}-5c-hover-then-open.png`);
      observed.pageBubbleOverReader = {
        source: p.source,
        opened,
        openedAfterMs,
        bubbles: overReader,
      };
      checks.noPageBubbleOverReader =
        opened && openedAfterMs < 500 && overReader.length === 0;
      await toggleReader(false);
    }

    // --- The bar's translate button: off restores the original, the toolbar turns it on again.
    await toggleReader(true);
    await waitReaderTranslated();
    await clickBar("translate");
    await sleep(800);
    const barOff = await readerState();
    const badgeOff = await badge();
    await screenshot(cdp, page, `${name}-6-bar-off.png`);
    observed.barOff = { ...barOff, inlineLost: undefined, badge: badgeOff };
    checks.barOffOriginal =
      barOff.open &&
      barOff.sameAsOriginal &&
      barOff.markers === 0 &&
      barOff.bubbles === 0 &&
      barOff.button?.state === "off" &&
      barOff.button.pressed === "false" &&
      badgeOff === "";
    const toolbarFrom = requests.length;
    await clickToolbarButton();
    await sleep(1000);
    const badgeOnAgain = await badge();
    const onAgainSeconds = await waitReaderTranslated();
    const onAgain = await readerState();
    await screenshot(cdp, page, `${name}-7-toolbar-on.png`);
    observed.toolbarOn = {
      ...onAgain,
      inlineLost: onAgain.inlineLost.length,
      badge: badgeOnAgain,
      requests: completions(toolbarFrom).length,
      translateSeconds: onAgainSeconds,
    };
    checks.toolbarOnTranslatesReader =
      onAgain.button?.state === "on" &&
      badgeOnAgain === "ON" &&
      onAgain.translated > 0 &&
      onAgain.japanese === onAgain.translated;

    // --- Off and close: nothing of the extension is left and the page is as before translation.
    await clickToolbarButton();
    await sleep(800);
    const off = await readerState();
    await toggleReader(false);
    await sleep(500);
    const restored = await evaluate(cdp, page, PAGE_RESTORED);
    const badgeEnd = await badge();
    observed.end = {
      readerOff: {
        sameAsOriginal: off.sameAsOriginal,
        firstDiff: off.firstDiff,
        markers: off.markers,
        bubbles: off.bubbles,
        button: off.button,
      },
      restored,
      badge: badgeEnd,
    };
    // The helper's own added paragraph is left out of the comparison.
    checks.offClosedClean =
      off.sameAsOriginal &&
      off.markers === 0 &&
      off.bubbles === 0 &&
      restored.markers === 0 &&
      restored.diffCount === 0 &&
      badgeEnd === "";
  }
  // Every completion: when it was sent and finished (worker timestamps, seconds), its source and response start.
  observed.requests = requests
    .filter((r) => r.url.endsWith("/v1/completions"))
    .map((r) => ({
      started: r.started,
      wallTime: r.wallTime,
      finished: r.finished,
      failed: r.failed,
      source: sourceOf(r)?.slice(0, 80),
      response: r.responseText?.slice(0, 40),
    }));
  observed.requestsTotal = requests.filter((r) =>
    r.url.endsWith("/v1/completions"),
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
  record.observed = observed;
  record.ok =
    record.error === undefined &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every(Boolean);
  record.finishedAt = new Date().toISOString();
  await chrome.close();
  writeFileSync(
    join(evidenceDir, `${name}.json`),
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
