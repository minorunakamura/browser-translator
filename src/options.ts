// Options page: edits the settings in chrome.storage.local. Models are listed through the service worker.
import type { ModelsListResponse, ModelsRequest } from "./background.ts";
import { type Settings, loadSettings, saveSettings } from "./settings.ts";
import type { GlossaryEntry } from "./text.ts";

function byId<T extends HTMLElement>(
  id: string,
  type: { new (): T; prototype: T },
): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} not found`);
  return el;
}

const form = byId("settings", HTMLFormElement);
const urlInput = byId("url", HTMLInputElement);
const modelSelect = byId("model", HTMLSelectElement);
const modelsStatus = byId("models-status", HTMLSpanElement);
const glossaryInput = byId("glossary", HTMLTextAreaElement);
const saveStatus = byId("save-status", HTMLSpanElement);

// One "source = target" per line, split at the first "="; blank lines and lines with an empty side are ignored.
function parseGlossary(text: string): GlossaryEntry[] {
  return text.split("\n").flatMap((line) => {
    const i = line.indexOf("=");
    if (i === -1) return [];
    const source = line.slice(0, i).trim();
    const target = line.slice(i + 1).trim();
    return source && target ? [{ source, target }] : [];
  });
}

const formatGlossary = (glossary: GlossaryEntry[]) =>
  glossary.map((g) => `${g.source} = ${g.target}`).join("\n");

// Parses the URL and drops the trailing "/"; undefined when it cannot be parsed.
function normalizeUrl(text: string): string | undefined {
  const url = text.trim();
  if (!URL.canParse(url)) return undefined;
  return url.replace(/\/+$/, "");
}

function setModelOptions(models: string[], selected: string): void {
  const first = new Option("先頭のモデルを使う", "");
  const options = models.map((id) => new Option(id, id));
  // Keep a saved model visible even when the server does not list it now.
  if (selected && !models.includes(selected))
    options.push(new Option(`${selected}（一覧にない）`, selected));
  modelSelect.replaceChildren(first, ...options);
  modelSelect.value = selected;
}

async function reloadModels(selected: string): Promise<void> {
  const url = normalizeUrl(urlInput.value);
  if (!url) {
    modelsStatus.textContent = "URL を解析できません";
    setModelOptions([], selected);
    return;
  }
  modelsStatus.textContent = "取得中…";
  const req: ModelsRequest = { type: "models", url };
  const res: ModelsListResponse = await chrome.runtime.sendMessage(req);
  if (res.ok) {
    modelsStatus.textContent = `${res.models.length} 個のモデル`;
    setModelOptions(res.models, selected);
  } else {
    modelsStatus.textContent = `モデルの一覧を取得できません（${res.message}）`;
    setModelOptions([], selected);
  }
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  urlInput.value = settings.url;
  for (const radio of form.querySelectorAll<HTMLInputElement>(
    'input[name="mode"]',
  ))
    radio.checked = radio.value === settings.mode;
  glossaryInput.value = formatGlossary(settings.glossary);
  await reloadModels(settings.model);
}

byId("reload-models", HTMLButtonElement).addEventListener("click", () => {
  reloadModels(modelSelect.value).catch(console.error);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = normalizeUrl(urlInput.value);
  if (!url) {
    saveStatus.textContent = "URL を解析できません。保存していません";
    return;
  }
  const mode =
    new FormData(form).get("mode") === "serial" ? "serial" : "parallel";
  const settings: Settings = {
    url,
    model: modelSelect.value,
    mode,
    glossary: parseGlossary(glossaryInput.value),
  };
  saveStatus.textContent = "";
  saveSettings(settings).then(
    () => {
      urlInput.value = url;
      glossaryInput.value = formatGlossary(settings.glossary);
      saveStatus.textContent = "保存しました";
    },
    (e: unknown) => {
      saveStatus.textContent = `保存できません（${String(e)}）`;
    },
  );
});

init().catch(console.error);
