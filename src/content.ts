// Content script, injected by the toolbar button: the first injection turns translation mode on,
// the next one in the same document turns it off and restores the original DOM.
import type {
  StatusMessage,
  TranslateRequest,
  TranslateResponse,
} from "./background.ts";
import {
  type InlineElement,
  type InlineNode,
  type RestoredNode,
  buildParallelContext,
  restoreTags,
  toTagged,
} from "./text.ts";

const MARK = "data-browser-translator";
const MAX_CONCURRENT_REQUESTS = 4;
const PARAGRAPHS = "p, li, h1, h2, h3, h4, h5, h6";
// shortcut: a paragraph that contains another block is skipped (its inner blocks are translated);
// text directly inside such an li stays English. Upgrade if real pages need it.
const NESTED_BLOCKS = `${PARAGRAPHS}, pre, ul, ol, div, table, blockquote`;

interface Paragraph {
  el: HTMLElement;
  source: string;
}

interface Translated {
  el: HTMLElement;
  original: Node[];
  title: string | null;
}

// Survives between injections into the same document; set while translation mode is on.
declare global {
  var browserTranslatorOff: (() => void) | undefined;
}

function status(s: StatusMessage["state"]): void {
  const msg: StatusMessage = { type: "status", state: s };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const plain = (el: Element) =>
  (el.textContent ?? "").replace(/\s+/g, " ").trim();

function findParagraphs(): Paragraph[] {
  return [...document.body.querySelectorAll<HTMLElement>(PARAGRAPHS)]
    .filter(
      (el) =>
        !el.closest(`pre, code, [${MARK}]`) &&
        ![...el.querySelectorAll(NESTED_BLOCKS)].some((b) =>
          /\S/.test(b.textContent ?? ""),
        ) &&
        /[A-Za-z]/.test(el.textContent ?? ""),
    )
    .map((el) => ({ el, source: plain(el) }));
}

// DOM -> the structure src/text.ts works on. Elements without text (img, svg, br) are leaves and are cloned whole.
function toInline(
  parent: Node,
  domOf: Map<InlineElement, Element>,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) nodes.push(child.textContent ?? "");
    else if (child instanceof Element) {
      const hasText = (child.textContent ?? "").trim() !== "";
      const inline: InlineElement = {
        kind: child.localName,
        children: hasText ? toInline(child, domOf) : [],
      };
      domOf.set(inline, child);
      nodes.push(inline);
    }
  }
  return nodes;
}

function toDom(
  nodes: RestoredNode[],
  domOf: Map<InlineElement, Element>,
): Node[] {
  return nodes.map((node) => {
    if (typeof node === "string") return document.createTextNode(node);
    const source = domOf.get(node.source);
    if (!source) throw new Error("restored tag without a source element");
    if ((source.textContent ?? "").trim() === "") return source.cloneNode(true);
    const copy = source.cloneNode(false);
    for (const child of toDom(node.children, domOf)) copy.appendChild(child);
    return copy;
  });
}

function start(): void {
  let active = true;
  const translated: Translated[] = [];
  const inserted: Element[] = [];
  const paragraphs = findParagraphs();
  const pending = new Set(paragraphs);
  const visible: Paragraph[] = [];
  const byElement = new Map<Element, Paragraph>(
    paragraphs.map((p) => [p.el, p]),
  );

  const title = document.title;
  const description =
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.content.trim() ?? "";

  function insertMarked(el: HTMLElement, parent: Element): void {
    el.setAttribute(MARK, "inserted");
    parent.append(el);
    inserted.push(el);
  }

  function showConnectionError(message: string): void {
    if (!active) return;
    active = false; // stop sending; the next button press turns the mode off and removes the notice
    status("error");
    const notice = document.createElement("div");
    notice.textContent = `Browser Translator: llama-server に接続できません（${message}）`;
    notice.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;max-width:420px;padding:10px 14px;" +
      "background:#d93025;color:#fff;font:14px/1.5 sans-serif;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    insertMarked(notice, document.body);
  }

  function markFailed(el: HTMLElement, reason: string): void {
    const marker = document.createElement("span");
    marker.textContent = " ⚠";
    marker.title = `翻訳できませんでした（${reason}）`;
    marker.style.cssText = "color:#d93025;font-size:0.8em;cursor:help";
    insertMarked(marker, el);
  }

  async function translateParagraph(p: Paragraph): Promise<void> {
    const i = paragraphs.indexOf(p);
    const context = buildParallelContext({
      title,
      description,
      previous: paragraphs[i - 1]?.source ?? "",
      next: paragraphs[i + 1]?.source ?? "",
    });
    const domOf = new Map<InlineElement, Element>();
    const { text, elements } = toTagged(toInline(p.el, domOf));
    const source = text.replace(/\s+/g, " ").trim();
    let reason = "";
    for (const retry of [false, true]) {
      const req: TranslateRequest = {
        type: "translate",
        source,
        context,
        retry,
      };
      const res: TranslateResponse = await chrome.runtime.sendMessage(req);
      if (!active) return;
      if (!res.ok) {
        if (res.unreachable) showConnectionError(res.message);
        else if (res.truncated) {
          reason = "長すぎて途中で切れました";
          continue; // treated like a tag mismatch: retry once, then keep the original
        } else markFailed(p.el, res.message);
        return;
      }
      const restored = restoreTags(res.text, elements);
      if (restored.ok) {
        const nodes = toDom(restored.nodes, domOf);
        translated.push({
          el: p.el,
          original: [...p.el.childNodes],
          title: p.el.getAttribute("title"),
        });
        p.el.replaceChildren(...nodes);
        p.el.setAttribute(MARK, "translated");
        p.el.title = p.source; // hovering shows the original text
        return;
      }
      reason = `タグが合いません: ${restored.problems.join(", ")}`;
    }
    markFailed(p.el, reason);
  }

  function next(): Paragraph | undefined {
    if (!active) return undefined;
    // A paragraph can be queued in visible again after it was taken; skip the ones already taken.
    let p = visible.shift();
    while (p && !pending.has(p)) p = visible.shift();
    p ??= pending.values().next().value;
    if (p) pending.delete(p);
    return p;
  }

  async function worker(): Promise<void> {
    for (let p = next(); p; p = next()) await translateParagraph(p);
  }

  let started = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const p = byElement.get(entry.target);
      if (entry.isIntersecting && p && pending.has(p)) visible.push(p);
    }
    if (started) return;
    started = true; // the first callback reports every observed paragraph, so visible ones go first
    for (let n = 0; n < MAX_CONCURRENT_REQUESTS; n++)
      worker().catch((e: unknown) =>
        showConnectionError(e instanceof Error ? e.message : String(e)),
      );
  });
  for (const p of paragraphs) observer.observe(p.el);

  globalThis.browserTranslatorOff = () => {
    active = false;
    observer.disconnect();
    for (const t of translated) {
      t.el.replaceChildren(...t.original);
      t.el.removeAttribute(MARK);
      if (t.title === null) t.el.removeAttribute("title");
      else t.el.title = t.title;
    }
    for (const el of inserted) el.remove();
    globalThis.browserTranslatorOff = undefined;
    status("off");
  };
  status("on");
}

if (globalThis.browserTranslatorOff) globalThis.browserTranslatorOff();
else start();
