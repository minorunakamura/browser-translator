// Verification helpers for the extension's own UI and traffic: the options page and the service worker's requests.
import { writeFileSync } from "node:fs";
import { type CdpPipe, evaluate, sleep } from "./cdp.ts";

// What the options page form is filled with; glossary is the textarea text ("source = target" per line).
export interface OptionsInput {
  url: string;
  // Path of a screenshot of the page after saving.
  screenshot: string;
  model?: string;
  mode?: "parallel" | "serial";
  glossary?: string;
}

export interface OptionsResult {
  modelsStatus: string;
  modelOptions: { value: string; text: string }[];
  saveStatus: string;
  stored: Record<string, unknown>;
}

// The models status after the list was fetched (or failed).
const settled = (t: string) => t !== "" && t !== "取得中…";

// Opens chrome-extension://<id>/options.html in a new tab, fills the form like a user (URL, reload models,
// select, radio, textarea), presses 保存 and returns what the page showed and what was stored.
export async function applyOptions(
  cdp: CdpPipe,
  extensionId: string,
  worker: string,
  input: OptionsInput,
): Promise<OptionsResult> {
  const { targetId }: { targetId: string } = await cdp.send(
    "Target.createTarget",
    { url: `chrome-extension://${extensionId}/options.html` },
  );
  const { sessionId: page }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  const text = (id: string) =>
    evaluate(
      cdp,
      page,
      `document.getElementById(${JSON.stringify(id)})?.textContent ?? ""`,
    );
  const waitText = async (id: string, done: (t: string) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const t: string = await text(id);
      if (done(t)) return t;
      await sleep(250);
    }
    throw new Error(`#${id} did not settle: ${await text(id)}`);
  };
  // The page loads the saved settings and lists the models of the saved URL first.
  await waitText("models-status", settled);
  await evaluate(
    cdp,
    page,
    `(() => {
      document.getElementById("url").value = ${JSON.stringify(input.url)};
      document.getElementById("models-status").textContent = "";
      document.getElementById("reload-models").click();
    })()`,
  );
  const modelsStatus = await waitText("models-status", settled);
  const modelOptions: OptionsResult["modelOptions"] = await evaluate(
    cdp,
    page,
    `[...document.getElementById("model").options].map((o) => ({ value: o.value, text: o.textContent }))`,
  );
  await evaluate(
    cdp,
    page,
    `(() => {
      const input = ${JSON.stringify({ ...input, screenshot: undefined })};
      if (input.model !== undefined) document.getElementById("model").value = input.model;
      if (input.mode !== undefined)
        document.querySelector('input[name="mode"][value="' + input.mode + '"]').click();
      if (input.glossary !== undefined) document.getElementById("glossary").value = input.glossary;
      document.getElementById("save-status").textContent = "";
      document.querySelector('button[type="submit"]').click();
    })()`,
  );
  const saveStatus = await waitText("save-status", (t) => t !== "");
  const { data }: { data: string } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    page,
  );
  writeFileSync(input.screenshot, Buffer.from(data, "base64"));
  const stored = await evaluate(cdp, worker, "chrome.storage.local.get(null)");
  await cdp.send("Target.closeTarget", { targetId });
  return { modelsStatus, modelOptions, saveStatus, stored };
}

export interface WorkerRequest {
  url: string;
  started: number;
  finished?: number;
  failed?: string;
  body?: { model?: string; prompt?: string; temperature?: number };
  responseText?: string;
}

// Records the service worker's network requests (Network domain on the worker session) with their timing,
// JSON body and, for completions, choices[0].text of the response.
export async function recordWorkerRequests(
  cdp: CdpPipe,
  worker: string,
): Promise<WorkerRequest[]> {
  const requests: WorkerRequest[] = [];
  const byId = new Map<string, WorkerRequest>();
  cdp.onEvent((msg) => {
    if (msg.sessionId !== worker) return;
    const p = msg.params;
    if (msg.method === "Network.requestWillBeSent") {
      const r: WorkerRequest = { url: p.request.url, started: p.timestamp };
      if (p.request.postData) r.body = JSON.parse(p.request.postData);
      byId.set(p.requestId, r);
      requests.push(r);
    } else if (msg.method === "Network.loadingFailed") {
      const r = byId.get(p.requestId);
      if (r) {
        r.finished = p.timestamp;
        r.failed = p.errorText;
      }
    } else if (msg.method === "Network.loadingFinished") {
      const r = byId.get(p.requestId);
      if (!r) return;
      cdp
        .send("Network.getResponseBody", { requestId: p.requestId }, worker)
        .then(({ body }: { body: string }) => {
          if (r.url.endsWith("/v1/completions"))
            r.responseText = JSON.parse(body).choices?.[0]?.text?.trim();
        })
        .catch((e: unknown) => {
          r.failed = `response body: ${String(e)}`;
        })
        .finally(() => {
          r.finished = p.timestamp;
        });
    }
  });
  await cdp.send("Network.enable", {}, worker);
  return requests;
}

// Largest number of requests in flight at the same time.
export function maxInFlight(requests: WorkerRequest[]): number {
  const edges = requests.flatMap((r) => [
    { t: r.started, d: 1 },
    { t: r.finished ?? Number.POSITIVE_INFINITY, d: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let now = 0;
  let max = 0;
  for (const e of edges) {
    now += e.d;
    max = Math.max(max, now);
  }
  return max;
}

const T = "<|plamo:tag|>";

export interface Pfml3Element {
  name: string;
  attrs: string;
  body: string;
  terms: { source: string; target: string }[];
}

// Splits a PFML3 prompt into its elements, e.g. { name: "input", attrs: "lang=en", body: "..." };
// glossary items are in terms.
export function pfml3Elements(prompt: string): Pfml3Element[] {
  return prompt
    .split(T)
    .slice(1)
    .map((part) => {
      const [head, ...rest] = part.split("<|plamo:msg|>");
      const [nameAndKeys, ...items] = head.split("<|plamo:index|>");
      const [name, ...kv] = nameAndKeys.split("<|plamo:key|>");
      return {
        name,
        attrs: kv.map((x) => x.replace("<|plamo:val|>", "=")).join(","),
        body: rest.join("<|plamo:msg|>"),
        terms: items.map((item) => {
          const [source, target] = item.split("<|plamo:item|>");
          return { source, target };
        }),
      };
    });
}
