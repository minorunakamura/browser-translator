// Extension settings, stored in chrome.storage.local and read by the service worker, content script and options page.
import type { GlossaryEntry } from "./text.ts";

export interface Settings {
  // llama-server base URL without a trailing "/".
  url: string;
  // "" means the first model of /v1/models.
  model: string;
  mode: "parallel" | "serial";
  // replace: the translation takes the paragraph's place. bilingual: it is added below the original.
  display: "replace" | "bilingual";
  glossary: GlossaryEntry[];
}

const DEFAULT_SETTINGS: Settings = {
  url: "http://127.0.0.1:8080",
  model: "",
  mode: "parallel",
  display: "replace",
  glossary: [],
};

// Keys that were never saved come back with their default value.
export function loadSettings(): Promise<Settings> {
  return chrome.storage.local.get<Settings>(DEFAULT_SETTINGS);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set(settings);
}
