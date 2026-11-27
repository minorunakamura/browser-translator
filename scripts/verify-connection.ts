// Work Item 1: verify the extension service worker loaded from dist/ can reach llama-server (/v1/models, /v1/completions).
// Usage: node scripts/verify-connection.ts <llamaBaseUrl> <evidenceDir> [modelId]
// Run `pnpm run build` first so dist/ is up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, launchChrome, loadExtensionAndAttachWorker } from "./cdp.ts";

const [baseUrl, evidenceDir, modelArg] = process.argv.slice(2);
if (!baseUrl || !evidenceDir) {
  console.error(
    "usage: node scripts/verify-connection.ts <llamaBaseUrl> <evidenceDir> [modelId]",
  );
  process.exit(2);
}
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
const SOURCE = "Parse a PDF, chunk it, embed it, and search it locally.";
mkdirSync(evidenceDir, { recursive: true });

interface ConsoleEntry {
  type: string;
  args?: unknown[];
  text?: string;
  url?: string;
}

interface VerifyResult {
  baseUrl: string;
  extensionPath: string;
  startedAt: string;
  finishedAt?: string;
  chrome?: { product: string; protocolVersion: string };
  extensionId?: string;
  workerUrl?: string;
  workerLocation?: string;
  models?: string[];
  completion?: {
    model: string;
    source: string;
    prompt: string;
    output: string;
    elapsedMs: number;
    containsJapanese: boolean;
  };
  ok?: boolean;
  error?: string;
  swConsole?: ConsoleEntry[];
}

const chrome = launchChrome();
const swConsole: ConsoleEntry[] = [];
const result: VerifyResult = {
  baseUrl,
  extensionPath,
  startedAt: new Date().toISOString(),
};
try {
  const version = await chrome.cdp.send("Browser.getVersion");
  result.chrome = {
    product: version.product,
    protocolVersion: version.protocolVersion,
  };
  const { extensionId, sessionId, workerUrl } =
    await loadExtensionAndAttachWorker(chrome.cdp, extensionPath);
  Object.assign(result, { extensionId, workerUrl });
  chrome.cdp.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.consoleAPICalled")
      swConsole.push({
        type: msg.params.type,
        args: msg.params.args.map(
          (a: { value?: unknown; description?: string }) =>
            a.value ?? a.description,
        ),
      });
    if (msg.method === "Runtime.exceptionThrown")
      swConsole.push({
        type: "exception",
        text: msg.params.exceptionDetails.exception?.description,
      });
    if (msg.method === "Log.entryAdded")
      swConsole.push({
        type: `log:${msg.params.entry.level}`,
        text: msg.params.entry.text,
        url: msg.params.entry.url,
      });
  });
  await chrome.cdp.send("Runtime.enable", {}, sessionId);
  await chrome.cdp.send("Log.enable", {}, sessionId).catch(() => {});

  result.workerLocation = await evaluate(
    chrome.cdp,
    sessionId,
    "self.location.href",
  );
  const models: string[] = await evaluate(
    chrome.cdp,
    sessionId,
    `listModels(${JSON.stringify(baseUrl)})`,
  );
  result.models = models;
  const model = modelArg || models[0];
  const prompt: string = await evaluate(
    chrome.cdp,
    sessionId,
    `buildMinimalPfml3Prompt(${JSON.stringify(SOURCE)})`,
  );
  const t0 = Date.now();
  const output: string = await evaluate(
    chrome.cdp,
    sessionId,
    `complete(${JSON.stringify(baseUrl)}, ${JSON.stringify(model)}, ${JSON.stringify(prompt)})`,
  );
  result.completion = {
    model,
    source: SOURCE,
    prompt,
    output,
    elapsedMs: Date.now() - t0,
    containsJapanese: /[\u3040-\u30ff\u4e00-\u9fff]/.test(output),
  };
  result.ok =
    Array.isArray(models) &&
    models.length > 0 &&
    result.completion.containsJapanese &&
    !swConsole.some((e) => e.type === "exception" || e.type === "log:error");
} catch (e) {
  result.ok = false;
  result.error = String(e instanceof Error ? e.stack || e : e);
} finally {
  result.swConsole = swConsole;
  result.finishedAt = new Date().toISOString();
  await chrome.close();
  writeFileSync(
    join(evidenceDir, "verify-connection.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(join(evidenceDir, "chrome-stderr.log"), chrome.stderr.join(""));
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
