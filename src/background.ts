// Service worker: toggles translation mode per tab and talks to the local llama-server only.
import { PLAMO_STOP, buildPfml3Prompt } from "./text.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

interface ModelsResponse {
  data: { id: string }[];
}

interface CompletionsResponse {
  choices: { text: string; finish_reason: string }[];
}

export type TranslateRequest = {
  type: "translate";
  source: string;
  context: string;
  retry: boolean;
};
export type StatusMessage = { type: "status"; state: "on" | "off" | "error" };
export type TranslateResponse =
  | { ok: true; text: string }
  | { ok: false; unreachable: boolean; truncated: boolean; message: string };

// The output hit max_tokens, so the translation is cut off.
class TruncatedError extends Error {}

// Returns the model ids reported by llama-server's /v1/models.
async function listModels(
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/v1/models`);
  if (!res.ok) throw new Error(`/v1/models failed: HTTP ${res.status}`);
  const body: ModelsResponse = await res.json();
  return body.data.map((m) => m.id);
}

// Sends a raw prompt to /v1/completions and returns choices[0].text trimmed.
async function complete(
  baseUrl: string,
  model: string,
  prompt: string,
  temperature = 0,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model,
      max_tokens: 600,
      temperature,
      stop: PLAMO_STOP,
    }),
  });
  if (!res.ok) throw new Error(`/v1/completions failed: HTTP ${res.status}`);
  const body: CompletionsResponse = await res.json();
  if (body.choices[0].finish_reason === "length")
    throw new TruncatedError("output reached max_tokens");
  return body.choices[0].text.trim();
}

// No settings screen yet: the first model of /v1/models is used, looked up once per service worker lifetime.
let firstModel: Promise<string> | undefined;

async function translate(req: TranslateRequest): Promise<TranslateResponse> {
  try {
    firstModel ??= listModels().then((ids) => {
      if (ids.length === 0) throw new Error("/v1/models returned no models");
      return ids[0];
    });
    const model = await firstModel.catch((e: unknown) => {
      firstModel = undefined;
      throw e;
    });
    const prompt = buildPfml3Prompt(req.source, req.context);
    // A retry at temperature 0 would return the same text, so the retry samples a little.
    const text = await complete(
      DEFAULT_BASE_URL,
      model,
      prompt,
      req.retry ? 0.3 : 0,
    );
    return { ok: true, text };
  } catch (e) {
    // fetch rejects with TypeError when the server cannot be reached at all.
    return {
      ok: false,
      unreachable: e instanceof TypeError,
      truncated: e instanceof TruncatedError,
      message: `${DEFAULT_BASE_URL}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Injecting content.js toggles translation mode in that tab; the content script keeps the on/off state.
async function toggleTab(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

const BADGE: Record<StatusMessage["state"], { text: string; color: string }> = {
  on: { text: "ON", color: "#1a73e8" },
  off: { text: "", color: "#1a73e8" },
  error: { text: "ERR", color: "#d93025" },
};

async function setBadge(
  tabId: number,
  state: StatusMessage["state"],
): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: BADGE[state].color,
  });
  await chrome.action.setBadgeText({ tabId, text: BADGE[state].text });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) toggleTab(tab.id).catch(console.error);
});

// Reloads and normal navigation drop the content script, so the mode ends and the badge must follow.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") setBadge(tabId, "off").catch(console.error);
});

chrome.runtime.onMessage.addListener(
  (msg: TranslateRequest | StatusMessage, sender, sendResponse) => {
    if (msg.type === "status") {
      if (sender.tab?.id !== undefined)
        setBadge(sender.tab.id, msg.state).catch(console.error);
      return false;
    }
    translate(msg).then(sendResponse, console.error);
    return true; // keeps sendResponse alive for the async reply
  },
);

// The iife bundle keeps these functions local; expose them so verification can call them over CDP.
Object.assign(globalThis, {
  listModels,
  complete,
  buildPfml3Prompt,
});
