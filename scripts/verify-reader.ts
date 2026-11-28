// Work Item 14: the reader (translation inside it: scripts/verify-reader-translate.ts). Drives a real Chrome with
// dist/ loaded and checks the overlay.
// The first open on each page presses the reader shortcut (Alt+Shift+R) with CDP key events, which fires
// chrome.commands.onCommand and grants activeTab like a user's shortcut does; later toggles call the service
// worker's toggleReaderTab (the function the context menu item and the shortcut use).
// Usage: node scripts/verify-reader.ts <evidenceDir> [--empty=<url>]
//   --empty: a page the reader cannot show (default: an image, whose document has no text).
// Run `pnpm run build` first so dist/ is up to date. No llama-server is needed.
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
const REACT_PAGE = "https://react.dev/learn";
const TABLE_PAGE =
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table";
const EMPTY_PAGE =
  "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
const args = process.argv.slice(2);
const emptyPage =
  args.find((a) => a.startsWith("--empty="))?.slice("--empty=".length) ??
  EMPTY_PAGE;
const [evidenceDir] = args.filter((a) => !a.startsWith("--"));
if (!evidenceDir) {
  console.error(
    "usage: node scripts/verify-reader.ts <evidenceDir> [--empty=<url>]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });

// Runs in the page: the code block's lines as the page shows them. Editors with one element per line (react.dev's
// .cm-line) are read line by line; other blocks from innerText.
const LINES_OF = `(pre) => {
  const lineEls = pre.querySelectorAll(".cm-line");
  const lines = lineEls.length > 0 ? [...lineEls].map((l) => l.textContent) : pre.innerText.replace(/\\n$/, "").split("\\n");
  return lines.map((l) => ({ indent: l.match(/^[ \\t]*/)[0].length, text: l.trim() }));
}`;

// Runs in the page: counts in the page's own article (the element scope selects) and its code blocks.
const ORIGINAL = (scopeSelector: string) => `(() => {
  const linesOf = ${LINES_OF};
  const scope = document.querySelector(${JSON.stringify(scopeSelector)}) ?? document.body;
  return {
    scope: scope.localName,
    headings: scope.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    headingAnchors: scope.querySelectorAll("h1 a, h2 a, h3 a, h4 a, h5 a, h6 a").length,
    headingIds: scope.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]").length,
    tables: scope.querySelectorAll("table").length,
    images: scope.querySelectorAll("img").length,
    documentPre: document.querySelectorAll("pre").length,
    pre: [...document.querySelectorAll("pre")].map(linesOf),
    scrollY,
  };
})()`;

// Runs in the page: the extension's elements with a shadow root (the reader's host; the bubble is not used here).
const READER_HOSTS = `[...document.querySelectorAll('[data-browser-translator="inserted"]')].filter((h) => h.shadowRoot)`;

// Runs in the page: the reader's host and what its shadow root shows.
const READER = `(() => {
  const hosts = ${READER_HOSTS};
  const host = hosts[0];
  const root = host?.shadowRoot;
  const art = root?.querySelector("article");
  const layer = root?.querySelector(".layer");
  if (!art) return { hosts: hosts.length, open: false, scrollY };
  const linesOf = (pre) => pre.textContent.split("\\n").map((l) => ({ indent: l.match(/^[ \\t]*/)[0].length, text: l.trim() }));
  const cs = getComputedStyle(art);
  const p = art.querySelector("p");
  const pre = art.querySelector("pre");
  return {
    hosts: hosts.length,
    open: true,
    parent: host.parentElement.localName,
    hostPosition: getComputedStyle(host).position,
    hostRect: (({ top, left, width, height }) => ({ top, left, width, height }))(host.getBoundingClientRect()),
    viewport: { width: innerWidth, height: innerHeight },
    shadowMode: root.mode,
    headings: art.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    paragraphs: art.querySelectorAll("p").length,
    headingAnchors: art.querySelectorAll("h1 a, h2 a, h3 a, h4 a, h5 a, h6 a").length,
    headingIds: art.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]").length,
    tables: art.querySelectorAll("table").length,
    images: art.querySelectorAll("img").length,
    preCount: art.querySelectorAll("pre").length,
    pInPre: art.querySelectorAll("pre p").length,
    divInPre: art.querySelectorAll("pre div").length,
    pre: [...art.querySelectorAll("pre")].map(linesOf),
    style: {
      layerBackground: getComputedStyle(layer).backgroundColor,
      layerColor: getComputedStyle(layer).color,
      layerOverscroll: getComputedStyle(layer).overscrollBehaviorY,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      maxWidth: cs.maxWidth,
      paragraphFontSize: p && getComputedStyle(p).fontSize,
      preFontFamily: pre && getComputedStyle(pre).fontFamily,
      preBackground: pre && getComputedStyle(pre).backgroundColor,
      preLineHeight: pre && getComputedStyle(pre).lineHeight,
      preWhiteSpace: pre && getComputedStyle(pre).whiteSpace,
    },
    translateButton: (({ disabled, dataset, textContent, ariaPressed }) => ({ disabled, state: dataset.state, pressed: ariaPressed, text: textContent }))(root.querySelector('[data-action="translate"]')),
    layerScrollTop: layer.scrollTop,
    activeIsReader: document.activeElement === host,
    scrollY,
  };
})()`;

const HOSTS = `${READER_HOSTS}.length`;

interface Lines {
  indent: number;
  text: string;
}
interface ReaderObservation {
  hosts: number;
  open: boolean;
  scrollY: number;
  headings: number;
  paragraphs: number;
  headingAnchors: number;
  headingIds: number;
  tables: number;
  images: number;
  preCount: number;
  pInPre: number;
  divInPre: number;
  pre: Lines[][];
  style: Record<string, string>;
  translateButton: {
    disabled: boolean;
    state: string;
    pressed: string;
    text: string;
  };
  layerScrollTop: number;
}
interface OriginalObservation {
  scope: string;
  headings: number;
  headingAnchors: number;
  headingIds: number;
  tables: number;
  images: number;
  documentPre: number;
  pre: Lines[][];
  scrollY: number;
}

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  extensionPath,
  emptyPage,
  startedAt: new Date().toISOString(),
};
const observed: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};

async function screenshot(
  cdp: CdpPipe,
  page: string,
  name: string,
): Promise<void> {
  const { data }: { data: string } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    page,
  );
  writeFileSync(join(evidenceDir, name), Buffer.from(data, "base64"));
}

// The same lines and indentation, compared by the reader's code blocks in order.
function samePre(original: Lines[][], reader: Lines[][]): string[] {
  const problems: string[] = [];
  if (original.length !== reader.length)
    problems.push(`count ${original.length} != ${reader.length}`);
  reader.forEach((lines, i) => {
    const o = original[i];
    if (!o) return;
    if (o.length !== lines.length)
      problems.push(`pre ${i}: lines ${o.length} != ${lines.length}`);
    else
      lines.forEach((l, j) => {
        if (l.indent !== o[j].indent || l.text !== o[j].text)
          problems.push(
            `pre ${i} line ${j}: ${JSON.stringify(o[j])} != ${JSON.stringify(l)}`,
          );
      });
  });
  return problems;
}

try {
  const { cdp } = chrome;
  record.chrome = (await cdp.send("Browser.getVersion")).product;
  const { extensionId, sessionId: sw } = await loadExtensionAndAttachWorker(
    cdp,
    extensionPath,
  );
  record.extensionId = extensionId;
  await sleep(1000);
  const commands: { name: string; shortcut: string; description: string }[] =
    await evaluate(cdp, sw, "chrome.commands.getAll()");
  observed.commands = commands;
  checks.commandAssigned = commands.some(
    (c) => c.name === "toggle-reader" && c.shortcut !== "",
  );
  const storedBefore = await evaluate(
    cdp,
    sw,
    `chrome.storage.local.get("reader")`,
  );
  observed.storedBefore = storedBefore;

  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await cdp.send("Page.enable", {}, page);
  await cdp.send("DOM.enable", {}, page);
  await cdp.send("CSS.enable", {}, page);
  await cdp.send("Target.activateTarget", { targetId });

  const navigate = async (url: string) => {
    const loaded = cdp.waitFor(
      "Page.loadEventFired",
      (_p, msg) => msg.sessionId === page,
      60000,
    );
    await cdp.send("Page.navigate", { url }, page);
    await loaded;
    await sleep(2500);
  };
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
  const pressEscape = () =>
    key({ key: "Escape", code: "Escape", keyCode: 27, macKeyCode: 53 });
  const tabId = () =>
    evaluate(
      cdp,
      sw,
      "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id)",
    );
  const toggle = async () => {
    await evaluate(cdp, sw, `toggleReaderTab(${await tabId()})`);
    await sleep(800);
  };
  const reader = (): Promise<ReaderObservation> => evaluate(cdp, page, READER);
  const waitHosts = async (n: number) => {
    for (let i = 0; i < 40; i++) {
      if ((await evaluate(cdp, page, HOSTS)) === n) return true;
      await sleep(100);
    }
    return false;
  };
  // Clicks the center of an element of the reader's shadow root, scrolled into view inside the reader.
  const clickInReader = async (selector: string) => {
    const point: { x: number; y: number } | null = await evaluate(
      cdp,
      page,
      `(() => {
        const host = ${READER_HOSTS}[0];
        const el = host?.shadowRoot.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        // The first line box, so a link that wraps is hit on its text.
        const r = el.getClientRects()[0];
        return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 };
      })()`,
    );
    if (!point) throw new Error(`not in the reader: ${selector}`);
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type, x: point.x, y: point.y, button: "left", clickCount: 1 },
        page,
      );
    await sleep(400);
  };
  const stored = () => evaluate(cdp, sw, `chrome.storage.local.get("reader")`);
  // The fonts Chrome actually used for the text of the reader's first paragraph.
  const platformFonts = async () => {
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page);
    const { result } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `${READER_HOSTS}[0].shadowRoot.querySelector("article p")`,
      },
      page,
    );
    const { nodeId } = await cdp.send(
      "DOM.requestNode",
      { objectId: result.objectId },
      page,
    );
    const { fonts } = await cdp.send(
      "CSS.getPlatformFontsForNode",
      { nodeId },
      page,
    );
    return fonts;
  };

  // --- react.dev/learn: first open in a fresh profile, code blocks, the bar, closing, scroll, links.
  await navigate(REACT_PAGE);
  await evaluate(cdp, page, "window.scrollTo(0, 400)");
  await sleep(300);
  const reactOriginal: OriginalObservation = await evaluate(
    cdp,
    page,
    ORIGINAL("article"),
  );
  await pressShortcut();
  await waitHosts(1);
  await sleep(500);
  const reactOpen = await reader();
  await screenshot(cdp, page, "reader-react-1-open.png");
  observed.react = {
    original: { ...reactOriginal, pre: undefined },
    reader: { ...reactOpen, pre: undefined },
  };
  checks.shortcutOpens = reactOpen.open && reactOpen.hosts === 1;
  checks.reactRendered =
    reactOpen.headings > 0 &&
    reactOpen.paragraphs > 0 &&
    reactOpen.preCount > 0;
  checks.firstOpenBlack =
    storedBefore.reader === undefined &&
    reactOpen.style.layerBackground === "rgb(30, 30, 30)" &&
    reactOpen.style.layerColor === "rgb(212, 212, 212)";
  checks.defaultLook =
    reactOpen.style.fontSize === "18px" &&
    reactOpen.style.maxWidth === "720px" &&
    reactOpen.style.fontFamily.startsWith('"Hiragino Sans"');
  // Opened with translation mode off: the bar's translate button can be pressed and shows off.
  checks.translateButtonOff =
    !reactOpen.translateButton.disabled &&
    reactOpen.translateButton.state === "off" &&
    reactOpen.translateButton.pressed === "false";
  const preProblems = samePre(reactOriginal.pre, reactOpen.pre);
  observed.reactPre = {
    original: reactOriginal.pre.length,
    reader: reactOpen.preCount,
    problems: preProblems,
    lineCounts: reactOpen.pre.map((l) => l.length),
  };
  checks.reactPreSame =
    reactOpen.preCount === reactOriginal.documentPre &&
    reactOpen.pInPre === 0 &&
    reactOpen.divInPre === 0 &&
    preProblems.length === 0;
  // The first code block with more than one line, for the screenshot.
  await evaluate(
    cdp,
    page,
    `${READER_HOSTS}[0]
      .shadowRoot.querySelectorAll("pre").values().find((p) => p.textContent.includes("\\n"))?.scrollIntoView({ block: "center" })`,
  );
  await sleep(300);
  await screenshot(cdp, page, "reader-react-2-code.png");
  observed.preStyle = reactOpen.style;

  // Scrolling the reader does not scroll the page.
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: 640, y: 500, deltaX: 0, deltaY: 2000 },
    page,
  );
  await sleep(600);
  const scrolled = await reader();
  observed.wheel = {
    layerScrollTop: scrolled.layerScrollTop,
    pageScrollY: scrolled.scrollY,
  };
  checks.onlyReaderScrolls =
    scrolled.scrollY === reactOriginal.scrollY && scrolled.layerScrollTop > 0;

  // Fonts of the default (gothic).
  const gothicFonts = await platformFonts();

  // The bar: background, font, size and width, then closing with ✕ and opening again.
  const look = async () => (await reader()).style;
  await clickInReader('[data-action="theme-sepia"]');
  const sepia = await look();
  await clickInReader('[data-action="theme-white"]');
  const white = await look();
  await clickInReader('[data-action="font-mincho"]');
  const mincho = await look();
  const minchoFonts = await platformFonts();
  await clickInReader('[data-action="size-up"]');
  const sizeUp = await look();
  await clickInReader('[data-action="width-up"]');
  const widthUp = await look();
  await screenshot(cdp, page, "reader-react-3-white-mincho.png");
  const storedAfter = await stored();
  observed.bar = { sepia, white, mincho, sizeUp, widthUp, storedAfter };
  observed.fonts = { gothic: gothicFonts, mincho: minchoFonts };
  checks.barTheme =
    sepia.layerBackground === "rgb(244, 236, 216)" &&
    sepia.layerColor === "rgb(91, 70, 54)" &&
    white.layerBackground === "rgb(255, 255, 255)" &&
    white.layerColor === "rgb(31, 31, 31)";
  checks.barFont =
    mincho.fontFamily.startsWith('"Hiragino Mincho ProN"') &&
    mincho.preFontFamily.startsWith("ui-monospace");
  checks.barSize = sizeUp.fontSize === "20px";
  // 45em at 20px.
  checks.barWidth = widthUp.maxWidth === "900px";
  checks.lookStored =
    storedAfter.reader?.theme === "white" &&
    storedAfter.reader.font === "mincho" &&
    storedAfter.reader.sizePx === 20 &&
    storedAfter.reader.widthEm === 45;
  await clickInReader('[data-action="close"]');
  const afterClose = await evaluate(
    cdp,
    page,
    `({ hosts: ${HOSTS}, scrollY })`,
  );
  observed.closeButton = afterClose;
  checks.closeButtonCloses = afterClose.hosts === 0;
  checks.closeKeepsScroll = afterClose.scrollY === reactOriginal.scrollY;
  await toggle();
  const reopened = await look();
  observed.reopened = reopened;
  checks.reopenSameLook =
    reopened.layerBackground === "rgb(255, 255, 255)" &&
    reopened.fontFamily.startsWith('"Hiragino Mincho ProN"') &&
    reopened.fontSize === "20px" &&
    reopened.maxWidth === "900px";
  // Back to the defaults for the other pages.
  await clickInReader('[data-action="theme-black"]');
  await clickInReader('[data-action="font-gothic"]');
  await clickInReader('[data-action="size-down"]');
  await clickInReader('[data-action="width-down"]');
  observed.storedReset = await stored();

  // The same toggle closes it.
  await toggle();
  checks.toggleCloses = (await evaluate(cdp, page, HOSTS)) === 0;

  // Esc with a selection in the reader: it closes and the page's keydown and keyup listeners do not see it.
  await evaluate(
    cdp,
    page,
    `(() => {
      window.__readerVerifyKeys = [];
      document.addEventListener("keydown", (e) => window.__readerVerifyKeys.push("document-capture:" + e.key), true);
      document.addEventListener("keydown", (e) => window.__readerVerifyKeys.push("document:" + e.key));
      window.addEventListener("keydown", (e) => window.__readerVerifyKeys.push("window:" + e.key));
      document.addEventListener("keyup", (e) => window.__readerVerifyKeys.push("keyup-document-capture:" + e.key), true);
      window.addEventListener("keyup", (e) => window.__readerVerifyKeys.push("keyup-window:" + e.key));
    })()`,
  );
  await toggle();
  await evaluate(
    cdp,
    page,
    `(() => {
      const host = ${READER_HOSTS}[0];
      getSelection().selectAllChildren(host.shadowRoot.querySelector("article p"));
    })()`,
  );
  const selection = await evaluate(cdp, page, "getSelection().toString()");
  await pressEscape();
  await sleep(400);
  const afterEsc = await evaluate(
    cdp,
    page,
    `({ hosts: ${HOSTS}, keys: window.__readerVerifyKeys, scrollY })`,
  );
  observed.escape = { selection: selection.slice(0, 80), ...afterEsc };
  checks.escCloses = selection !== "" && afterEsc.hosts === 0;
  checks.escNotPassed = !afterEsc.keys.some(
    (k: string) => !k.startsWith("keyup-") && k.endsWith(":Escape"),
  );
  checks.escKeyupNotPassed = !afterEsc.keys.some(
    (k: string) => k.startsWith("keyup-") && k.endsWith(":Escape"),
  );
  checks.escKeepsScroll = afterEsc.scrollY === reactOriginal.scrollY;
  // Esc after closing reaches the page again.
  await pressEscape();
  await sleep(200);
  observed.escapeAfterClose = await evaluate(
    cdp,
    page,
    "window.__readerVerifyKeys",
  );

  // Shift+Tab moves the focus out of the reader to the page behind, which scrolls the page; closing (Esc, then ✕)
  // puts the page back where it was before opening.
  const pressShiftTab = () =>
    key({ key: "Tab", code: "Tab", keyCode: 9, macKeyCode: 48 }, 8);
  const focusOut: Record<string, unknown> = {};
  for (const how of ["escape", "closeButton"] as const) {
    const beforeOpen: number = await evaluate(cdp, page, "scrollY");
    await toggle();
    for (let i = 0; i < 3; i++) await pressShiftTab();
    await sleep(400);
    const whileOpen = await evaluate(
      cdp,
      page,
      `({ scrollY, active: document.activeElement?.localName, activeIsReader: document.activeElement === ${READER_HOSTS}[0] })`,
    );
    if (how === "escape") await pressEscape();
    else await clickInReader('[data-action="close"]');
    await sleep(400);
    const after = await evaluate(cdp, page, `({ hosts: ${HOSTS}, scrollY })`);
    focusOut[how] = { beforeOpen, whileOpen, after };
    checks[`shiftTab${how === "escape" ? "Esc" : "CloseButton"}KeepsScroll`] =
      !whileOpen.activeIsReader &&
      after.hosts === 0 &&
      after.scrollY === beforeOpen;
  }
  observed.shiftTab = focusOut;

  // A #… link: the reader closes and the page moves to the anchor.
  await toggle();
  const hashHref: string | null = await evaluate(
    cdp,
    page,
    `${READER_HOSTS}[0]
      .shadowRoot.querySelector('article a[href^="#"]')?.getAttribute("href") ?? null`,
  );
  if (hashHref) {
    await clickInReader(`article a[href="${hashHref}"]`);
    const afterHash = await evaluate(
      cdp,
      page,
      `({ hosts: ${HOSTS}, hash: location.hash, href: location.href, scrollY })`,
    );
    observed.hashLink = { hashHref, ...afterHash };
    checks.hashLinkClosesAndMoves =
      afterHash.hosts === 0 && afterHash.hash === hashHref;
  } else {
    observed.hashLink = "no #… link in the reader";
    await toggle();
  }

  // A link to another page: the reader closes and the tab goes there.
  await toggle();
  const linkHref: string = await evaluate(
    cdp,
    page,
    `${READER_HOSTS}[0]
      .shadowRoot.querySelector('article p a[href^="https://react.dev/learn/"]').href`,
  );
  const moved = cdp.waitFor(
    "Page.frameNavigated",
    (p, msg) => msg.sessionId === page && !p.frame.parentId,
    30000,
  );
  await clickInReader(`article p a[href="${linkHref}"]`);
  const nav = await moved.catch(() => undefined);
  await sleep(1500);
  const afterLink = await evaluate(
    cdp,
    page,
    `({ hosts: ${HOSTS}, href: location.href })`,
  );
  observed.link = { linkHref, navigated: nav?.params.frame.url, ...afterLink };
  checks.linkClosesAndMoves =
    afterLink.hosts === 0 && afterLink.href === linkHref;
  await screenshot(cdp, page, "reader-react-4-link.png");

  // --- bfcache: open the reader, leave, come back.
  await navigate(REACT_PAGE);
  await evaluate(cdp, page, "window.__readerVerifyMarker = true");
  await toggle();
  const openBeforeLeave = (await evaluate(cdp, page, HOSTS)) === 1;
  await navigate("https://react.dev/blog");
  const { currentIndex, entries } = await cdp.send(
    "Page.getNavigationHistory",
    {},
    page,
  );
  const loadedBack = cdp.waitFor(
    "Page.frameNavigated",
    (p, msg) => msg.sessionId === page && !p.frame.parentId,
    30000,
  );
  await cdp.send(
    "Page.navigateToHistoryEntry",
    { entryId: entries[currentIndex - 1].id },
    page,
  );
  await loadedBack.catch(() => undefined);
  await sleep(1500);
  const back = await evaluate(
    cdp,
    page,
    `({ hosts: ${HOSTS}, restoredFromCache: window.__readerVerifyMarker === true })`,
  );
  observed.bfcache = { openBeforeLeave, ...back };
  checks.bfcacheCloses = openBeforeLeave && back.hosts === 0;

  // --- The reference page and the table page: rendered content and counts.
  for (const [name, url, scope] of [
    ["hf", REFERENCE_PAGE, ".blog-content"],
    ["mdn", TABLE_PAGE, "main article"],
  ] as const) {
    await navigate(url);
    const before: OriginalObservation = await evaluate(
      cdp,
      page,
      ORIGINAL(scope),
    );
    await pressShortcut();
    await waitHosts(1);
    await sleep(500);
    const open = await reader();
    await screenshot(cdp, page, `reader-${name}-1-open.png`);
    if (name === "mdn")
      await evaluate(
        cdp,
        page,
        `${READER_HOSTS}[0]
          .shadowRoot.querySelector("article table")?.scrollIntoView({ block: "start" })`,
      );
    else
      await evaluate(
        cdp,
        page,
        `${READER_HOSTS}[0]
          .shadowRoot.querySelector("article pre")?.scrollIntoView({ block: "center" })`,
      );
    await sleep(300);
    await screenshot(
      cdp,
      page,
      `reader-${name}-2-${name === "mdn" ? "table" : "code"}.png`,
    );
    observed[name] = {
      original: { ...before, pre: undefined },
      reader: { ...open, pre: undefined },
      preProblems: samePre(before.pre, open.pre),
    };
    checks[`${name}Rendered`] =
      open.open &&
      open.headings > 0 &&
      open.paragraphs > 0 &&
      (name === "mdn" ? open.tables > 0 : open.preCount > 0);
    await toggle();
    checks[`${name}Closed`] = (await evaluate(cdp, page, HOSTS)) === 0;
  }

  // --- A page without text: the reader does not open and the notice shows, then goes away.
  await navigate(emptyPage);
  await pressShortcut();
  await sleep(600);
  const empty = await evaluate(
    cdp,
    page,
    `({ hosts: ${HOSTS}, notice: [...document.querySelectorAll('[data-browser-translator="inserted"]')].filter((n) => !n.shadowRoot).map((n) => ({ text: n.textContent, style: n.style.cssText })) })`,
  );
  await screenshot(cdp, page, "reader-empty-notice.png");
  await sleep(4500);
  const emptyLater = await evaluate(
    cdp,
    page,
    `document.querySelectorAll('[data-browser-translator]').length`,
  );
  observed.empty = { url: emptyPage, ...empty, markersAfter5s: emptyLater };
  checks.emptyNotOpened =
    empty.hosts === 0 &&
    empty.notice.some((n: { text: string }) =>
      n.text.includes("このページはリーダー表示にできません"),
    );
  checks.emptyNoticeGoes = emptyLater === 0;
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
    join(evidenceDir, "reader.json"),
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
