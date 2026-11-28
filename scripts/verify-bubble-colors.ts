// Work Item 16: the original-text bubble on a white and a dark page (react.dev/learn with prefers-color-scheme
// light / dark through CDP Emulation.setEmulatedMedia), replace display. Saves a screenshot of each bubble and
// the bubble's computed colors with the page's body background, for checking by eye that it stands out.
// Usage: node scripts/verify-bubble-colors.ts <evidenceDir> --server=<url> [pageUrl]
// Run `pnpm run build` first so dist/ is up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  launchChrome,
  loadExtensionAndAttachWorker,
  sleep,
} from "./cdp.ts";
import { applyOptions } from "./extension.ts";

const REACT_PAGE = "https://react.dev/learn";
const args = process.argv.slice(2);
const serverUrl = args
  .find((a) => a.startsWith("--server="))
  ?.slice("--server=".length);
const [evidenceDir, pageUrl = REACT_PAGE] = args.filter(
  (a) => !a.startsWith("--"),
);
if (!evidenceDir || !serverUrl) {
  console.error(
    "usage: node scripts/verify-bubble-colors.ts <evidenceDir> --server=<url> [pageUrl]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });

// Runs in the page: the first translated article paragraph of two or more lines, scrolled to the center.
const PARAGRAPH = `(() => {
  const el = [...document.querySelectorAll('article p[data-browser-translator="translated"]')]
    .find((e) => e.getBoundingClientRect().height > 40);
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + 20, y: r.top + 10 };
})()`;

// Runs in the page: the bubble's computed colors and the body background.
const COLORS = `(() => {
  const hosts = [...document.querySelectorAll('[data-browser-translator="inserted"]')].filter((h) => h.shadowRoot);
  const text = hosts[0]?.shadowRoot.querySelector("div");
  const s = text && getComputedStyle(text);
  return {
    bubbles: hosts.length,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bubble: s && { backgroundColor: s.backgroundColor, borderColor: s.borderTopColor, color: s.color },
  };
})()`;

interface Colors {
  bubbles: number;
  bodyBackground: string;
  bubble?: { backgroundColor: string; borderColor: string; color: string };
}

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  pageUrl,
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
  const options = await applyOptions(cdp, extensionId, sw, {
    url: serverUrl,
    screenshot: join(evidenceDir, "bubble-colors-options.png"),
    display: "replace",
  });
  checks.optionsSaved =
    options.stored.url === serverUrl && options.stored.display === "replace";

  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await cdp.send("Page.enable", {}, page);
  for (const scheme of ["light", "dark"]) {
    await cdp.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: scheme }] },
      page,
    );
    // A new document each time, so the previous scheme's translation mode ends.
    const loaded = cdp.waitFor(
      "Page.loadEventFired",
      (_p, msg) => msg.sessionId === page,
      60000,
    );
    await cdp.send("Page.navigate", { url: pageUrl }, page);
    await loaded;
    await sleep(2000);
    await cdp.send("Target.activateTarget", { targetId });
    const {
      targetInfos: tabs,
    }: { targetInfos: { targetId: string; url: string }[] } = await cdp.send(
      "Target.getTargets",
      { filter: [{ type: "tab" }] },
    );
    const tabTarget = tabs.find((t) => t.url === pageUrl)?.targetId;
    if (!tabTarget) throw new Error("tab target of the page not found");
    await cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: tabTarget,
    });
    // Wait for a translated paragraph to hover.
    let at: { x: number; y: number } | null = null;
    for (let i = 0; i < 180 && !at; i++) {
      await sleep(1000);
      at = await evaluate(cdp, page, PARAGRAPH);
    }
    if (!at) throw new Error(`${scheme}: no translated paragraph to hover`);
    await sleep(500);
    const point: { x: number; y: number } =
      (await evaluate(cdp, page, PARAGRAPH)) ?? at;
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 5, y: 500 },
      page,
    );
    await sleep(1000);
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: point.x, y: point.y },
      page,
    );
    await sleep(900);
    const colors: Colors = await evaluate(cdp, page, COLORS);
    const { data }: { data: string } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      page,
    );
    const screenshot = `bubble-colors-${scheme}.png`;
    writeFileSync(join(evidenceDir, screenshot), Buffer.from(data, "base64"));
    record[scheme] = { ...colors, screenshot };
    checks[`${scheme}BubbleColors`] =
      colors.bubbles === 1 &&
      colors.bubble?.backgroundColor === "rgb(255, 246, 204)" &&
      colors.bubble.borderColor === "rgb(184, 146, 26)" &&
      colors.bubble.color === "rgb(31, 31, 31)";
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
    join(evidenceDir, "bubble-colors.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}
console.log(JSON.stringify(record, null, 2));
process.exit(record.ok ? 0 : 1);
