// Work Item 3: change the settings on the options page and check what the service worker sends to llama-server.
// Usage: node scripts/verify-settings.ts <evidenceDir> <serverUrl> [pageUrl]
//   serverUrl: a llama-server (router mode) you started on a port other than the default 8080,
//   e.g. http://127.0.0.1:18080. It must list at least two models in /v1/models.
// Phases (one Chrome, one extension): parallel with the second model and a glossary, serial, parallel again.
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
import {
  type OptionsResult,
  type WorkerRequest,
  applyOptions,
  maxInFlight,
  pfml3Elements,
  recordWorkerRequests,
} from "./extension.ts";
import { restoreTags } from "../src/text.ts";

const REFERENCE_PAGE =
  "https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga";
// "pi" is not a word on the reference page but is inside "APIs"; "harness" is a word in several paragraphs.
const GLOSSARY = "pi = パイ\nharness = 実行基盤\n";
const GLOSSARY_TARGET = "実行基盤";

const [evidenceDir, serverUrl, pageUrl = REFERENCE_PAGE] =
  process.argv.slice(2);
if (!evidenceDir || !serverUrl) {
  console.error(
    "usage: node scripts/verify-settings.ts <evidenceDir> <serverUrl> [pageUrl]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
mkdirSync(evidenceDir, { recursive: true });

const modelsRes = await fetch(`${serverUrl}/v1/models`);
const serverModels: string[] = (await modelsRes.json()).data.map(
  (m: { id: string }) => m.id,
);
if (serverModels.length < 2) {
  console.error(`${serverUrl}/v1/models lists fewer than two models`);
  process.exit(2);
}
const chosenModel = serverModels[1];

// Runs in the page: translated/failed paragraph counts and the translated paragraphs (source title and text).
const OBSERVE = `(() => {
  const translated = [...document.querySelectorAll('[data-browser-translator="translated"]')];
  const failed = [...document.querySelectorAll('[data-browser-translator="inserted"]')]
    .filter((m) => m.parentElement && m.parentElement.closest("p, li, h1, h2, h3, h4, h5, h6"));
  return {
    translated: translated.map((el) => ({ source: el.title, text: el.textContent })),
    failed: failed.length,
  };
})()`;

interface PageObservation {
  translated: { source: string; text: string }[];
  failed: number;
}

// One completion request as sent: model, context, the history pair, glossary terms and the current input.
interface SentPrompt {
  started: number;
  model: string | undefined;
  context: string;
  history: { source: string; translation: string }[];
  glossary: { source: string; target: string }[];
  input: string;
  response: string | undefined;
  // Whether content.ts would use the response: complete (not cut at max_tokens) and its tags restore.
  accepted: boolean;
}

// The sent opening tags as restoreTags' map; whether a response is accepted depends only on these tags.
const sentTags = (input: string) =>
  Object.fromEntries(
    [...input.matchAll(/<([a-z][a-z0-9-]*)(?: id="\d+")?>/g)].map(
      ([tag, kind]) => [tag, { kind, children: [] }],
    ),
  );

function toSentPrompt(r: WorkerRequest): SentPrompt {
  const els = pfml3Elements(r.body?.prompt ?? "");
  const inputs = els.filter((e) => e.name === "input");
  const outputs = els.filter((e) => e.name === "output");
  return {
    started: r.started,
    model: r.body?.model,
    context: els.find((e) => e.name === "context")?.body ?? "",
    history: inputs
      .slice(0, -1)
      .map((e, i) => ({ source: e.body, translation: outputs[i].body })),
    glossary: els.find((e) => e.name === "glossary")?.terms ?? [],
    input: inputs.at(-1)?.body ?? "",
    response: r.responseText,
    accepted:
      r.responseText !== undefined &&
      !r.failed &&
      r.finishReason !== "length" &&
      restoreTags(r.responseText, sentTags(inputs.at(-1)?.body ?? "")).ok,
  };
}

// The sent paragraph without its inline tags (<a>, <code id="2">, </strong>) and with &amp; &lt; &gt; as characters.
const plainText = (s: string) =>
  s
    .replace(/<\/?[a-z][a-z0-9-]*(?: id="\d+")?>/g, "")
    .replace(
      /&(?:amp|lt|gt);/g,
      (e) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[e] ?? e,
    );

const chrome = launchChrome({ extraArgs: ["--window-size=1280,1000"] });
const record: Record<string, unknown> = {
  serverUrl,
  serverModels,
  chosenModel,
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
  const requests = await recordWorkerRequests(cdp, sw);

  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await cdp.send("Page.enable", {}, page);

  async function screenshot(name: string): Promise<void> {
    const { data }: { data: string } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      page,
    );
    writeFileSync(join(evidenceDir, name), Buffer.from(data, "base64"));
  }

  // Loads the page (ending any translation mode), presses the toolbar button and waits until translation settles.
  async function translatePage(name: string): Promise<{
    page: PageObservation;
    sent: WorkerRequest[];
    seconds: number;
  }> {
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
      targetInfos,
    }: { targetInfos: { targetId: string; url: string }[] } = await cdp.send(
      "Target.getTargets",
      { filter: [{ type: "tab" }] },
    );
    const tab = targetInfos.find((t) => t.url === pageUrl)?.targetId;
    if (!tab) throw new Error("tab target of the page not found");
    const from = requests.length;
    const t0 = Date.now();
    await cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: tab,
    });
    // Done when the translated + failed count stops changing and no request is in flight.
    let last = -1;
    let stableFor = 0;
    let o: PageObservation = { translated: [], failed: 0 };
    while (stableFor < 6 && Date.now() - t0 < 600000) {
      await sleep(1000);
      o = await evaluate(cdp, page, OBSERVE);
      const done = o.translated.length + o.failed;
      const idle = requests.slice(from).every((r) => r.finished !== undefined);
      stableFor = done === last && done > 0 && idle ? stableFor + 1 : 0;
      last = done;
    }
    await evaluate(cdp, page, "window.scrollTo(0, 0)");
    await screenshot(`settings-${name}.png`);
    return {
      page: o,
      sent: requests.slice(from),
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  }

  const completions = (sent: WorkerRequest[]) =>
    sent.filter((r) => r.url.endsWith("/v1/completions")).map(toSentPrompt);
  const allToServer = (sent: WorkerRequest[]) =>
    sent.length > 0 && sent.every((r) => r.url.startsWith(`${serverUrl}/`));
  const hasNeighbours = (p: SentPrompt) =>
    /^(Previous|Next) paragraph: /m.test(p.context);
  const summary = (
    run: Awaited<ReturnType<typeof translatePage>>,
    prompts: SentPrompt[],
  ) => ({
    seconds: run.seconds,
    translated: run.page.translated.length,
    failed: run.page.failed,
    requests: run.sent.length,
    urls: [...new Set(run.sent.map((r) => r.url))],
    models: [...new Set(prompts.map((p) => p.model))],
    maxInFlight: maxInFlight(run.sent),
    withNeighbours: prompts.filter(hasNeighbours).length,
    withHistory: prompts.filter((p) => p.history.length > 0).length,
    withGlossary: prompts.filter((p) => p.glossary.length > 0).length,
    failedRequests: run.sent.filter((r) => r.failed).map((r) => r.failed),
  });

  // Phase 1: URL with a trailing "/", the second model, parallel, glossary.
  const options1: OptionsResult = await applyOptions(cdp, extensionId, sw, {
    url: `${serverUrl}/`,
    screenshot: join(evidenceDir, "settings-options-1.png"),
    model: chosenModel,
    mode: "parallel",
    glossary: GLOSSARY,
  });
  record.options1 = options1;
  checks.optionsListModels = serverModels.every((id) =>
    options1.modelOptions.some((o) => o.value === id),
  );
  const stored1 = options1.stored;
  checks.optionsSaved =
    options1.saveStatus === "保存しました" &&
    stored1.url === serverUrl && // the trailing "/" is dropped
    stored1.model === chosenModel &&
    stored1.mode === "parallel" &&
    JSON.stringify(stored1.glossary) ===
      JSON.stringify([
        { source: "pi", target: "パイ" },
        { source: "harness", target: "実行基盤" },
      ]);

  const run1 = await translatePage("1-parallel-model-glossary");
  const prompts1 = completions(run1.sent);
  const withTerm = (p: SentPrompt, term: string) =>
    p.glossary.some((g) => g.source === term);
  const harnessPrompts = prompts1.filter((p) =>
    /(?<![\p{L}\p{N}_])harness(?![\p{L}\p{N}_])/iu.test(plainText(p.input)),
  );
  const apiPrompts = prompts1.filter((p) => /api/i.test(plainText(p.input)));
  const harnessTranslations = run1.page.translated.filter((t) =>
    /\bharness\b/i.test(t.source),
  );
  record.phase1 = {
    ...summary(run1, prompts1),
    glossaryPrompts: prompts1
      .filter((p) => p.glossary.length > 0)
      .map((p) => ({ input: p.input, glossary: p.glossary })),
    apiPrompts: apiPrompts.map((p) => ({
      input: p.input,
      glossary: p.glossary,
    })),
    harnessTranslations,
  };
  checks.urlUsed = allToServer(run1.sent);
  checks.modelUsed =
    prompts1.length > 0 && prompts1.every((p) => p.model === chosenModel);
  checks.parallelTranslated =
    run1.page.translated.length > 0 && maxInFlight(run1.sent) > 1;
  checks.glossaryOnlyWhereMatched =
    harnessPrompts.length > 0 &&
    prompts1.every(
      (p) =>
        withTerm(p, "harness") === harnessPrompts.includes(p) &&
        !withTerm(p, "pi"),
    );
  checks.piNotInApi =
    apiPrompts.length > 0 && apiPrompts.every((p) => !withTerm(p, "pi"));
  checks.glossaryApplied =
    harnessTranslations.length > 0 &&
    harnessTranslations.every((t) => t.text.includes(GLOSSARY_TARGET));

  // Phase 2: serial, first model again ("" = the first of /v1/models).
  record.options2 = await applyOptions(cdp, extensionId, sw, {
    url: serverUrl,
    screenshot: join(evidenceDir, "settings-options-2.png"),
    model: "",
    mode: "serial",
  });
  const run2 = await translatePage("2-serial");
  const prompts2 = completions(run2.sent).toSorted(
    (a, b) => a.started - b.started,
  );
  // Every history pair must be an earlier request's input and the response the model returned for it, and it
  // must be the latest earlier request whose response content.ts accepted (it sets the history only then).
  const historyChecks = prompts2.map((p, i) => {
    const h = p.history[0];
    const earlier = prompts2.slice(0, i);
    const fromIndex = h
      ? earlier.findLastIndex(
          (e) => e.input === h.source && e.response === h.translation,
        )
      : -1;
    return {
      i,
      hasHistory: !!h,
      fromIndex,
      previous: !!h && fromIndex === earlier.findLastIndex((e) => e.accepted),
    };
  });
  const firstWithHistory = historyChecks.findIndex((c) => c.hasHistory);
  record.phase2 = {
    ...summary(run2, prompts2),
    firstWithHistory,
    historyFromPrevious: historyChecks.filter((c) => c.previous).length,
    historyUnmatched: historyChecks.filter(
      (c) => c.hasHistory && c.fromIndex === -1,
    ),
    rejected: prompts2.filter((p) => !p.accepted).length,
    samplePrompts: prompts2.slice(0, 3),
  };
  checks.serialOneAtATime =
    run2.page.translated.length > 0 && maxInFlight(run2.sent) === 1;
  checks.serialFirstModel = prompts2.every((p) => p.model === serverModels[0]);
  // History starts once the first paragraph was translated and then always points at the latest accepted
  // request; a rejected response (retried or marked) never appears as history.
  checks.serialHistory =
    firstWithHistory >= 1 &&
    historyChecks.slice(firstWithHistory).every((c) => c.previous) &&
    prompts2.every((p) => p.history.length <= 1) &&
    prompts2.every(
      (p) =>
        p.accepted ||
        !prompts2.some(
          (q) =>
            q.history[0]?.source === p.input &&
            q.history[0]?.translation === p.response,
        ),
    );
  checks.serialNoNeighbours = prompts2.every((p) => !hasNeighbours(p));

  // Phase 3: back to parallel.
  record.options3 = await applyOptions(cdp, extensionId, sw, {
    url: serverUrl,
    screenshot: join(evidenceDir, "settings-options-3.png"),
    mode: "parallel",
  });
  const run3 = await translatePage("3-parallel-again");
  const prompts3 = completions(run3.sent);
  record.phase3 = summary(run3, prompts3);
  checks.parallelAgain =
    run3.page.translated.length > 0 &&
    maxInFlight(run3.sent) > 1 &&
    prompts3.some(hasNeighbours) &&
    prompts3.every((p) => p.history.length === 0);
  // Every request of the run. The only one not to serverUrl is the options page listing the models of the
  // saved default URL when it first opens (nothing listens there, so it fails).
  const counts = new Map<string, number>();
  for (const r of requests) {
    const key = `${r.url} ${r.failed ?? "ok"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  record.allRequests = [...counts].map(([key, n]) => `${n}x ${key}`);
  checks.allRequestsToServerOrDefaultModels = requests.every(
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
    join(evidenceDir, "settings.json"),
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
