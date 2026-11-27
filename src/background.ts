// Service worker: talks to the configured local llama-server only.

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const PLAMO_TAG = "<|plamo:tag|>";
const PLAMO_STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];

interface ModelsResponse {
  data: { id: string }[];
}

interface CompletionsResponse {
  choices: { text: string }[];
}

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
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model,
      max_tokens: 600,
      temperature: 0,
      stop: PLAMO_STOP,
    }),
  });
  if (!res.ok) throw new Error(`/v1/completions failed: HTTP ${res.status}`);
  const body: CompletionsResponse = await res.json();
  return body.choices[0].text.trim();
}

// Minimal en->ja polite PFML3 prompt; full assembly (context, glossary, history) belongs to src/text.ts.
function buildMinimalPfml3Prompt(src: string): string {
  const T = PLAMO_TAG;
  return (
    `${T}dataset<|plamo:msg|>translation${T}input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${src}` +
    `${T}output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>`
  );
}

// The iife bundle keeps these functions local; expose them so verification can call them over CDP.
Object.assign(globalThis, { listModels, complete, buildMinimalPfml3Prompt });
