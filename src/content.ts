// Content script, injected by the toolbar button: the first injection turns translation mode on,
// the next one in the same document turns it off and restores the original DOM.
import type {
  StatusMessage,
  TranslateRequest,
  TranslateResponse,
} from "./background.ts";
import { startBubble } from "./bubble.ts";
import { loadSettings } from "./settings.ts";
import {
  type HistoryPair,
  type InlineElement,
  type InlineNode,
  type RestoredNode,
  buildParallelContext,
  restoreTags,
  toTagged,
} from "./text.ts";

const MARK = "data-browser-translator";
const PARALLEL_REQUESTS = 4;
const PARAGRAPHS = "p, li, h1, h2, h3, h4, h5, h6";
// shortcut: a paragraph that contains another block is skipped (its inner blocks are translated);
// text directly inside such an li stays English. Upgrade if real pages need it.
const NESTED_BLOCKS = `${PARAGRAPHS}, pre, ul, ol, div, table, blockquote`;

// A paragraph seen during translation mode, kept in memory until the mode ends.
interface Paragraph {
  el: HTMLElement;
  // Text of the paragraph without the extension's inserted elements, as last seen.
  source: string;
  // Reported by the IntersectionObserver; visible paragraphs are translated first.
  visible: boolean;
  // Replace display, after the translation was written: its text and the page's own children.
  shown?: string;
  original?: Node[];
  // The bilingual translation or the failure marker inside the paragraph.
  added?: Element;
}

// Survives between injections into the same document; set while translation mode is on.
declare global {
  var browserTranslatorOff: (() => void) | undefined;
}

function status(s: StatusMessage["state"]): void {
  const msg: StatusMessage = { type: "status", state: s };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const INSERTED = `[${MARK}="inserted"]`;

const isInserted = (node: Node) =>
  node instanceof Element && node.getAttribute(MARK) === "inserted";

// Text of el without the elements the extension inserted, whitespace collapsed.
function textOf(el: Element): string {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    else if (child instanceof Element && !isInserted(child))
      text += textOf(child);
  }
  return text.replace(/\s+/g, " ").trim();
}

// A paragraph with English text and no non-empty block inside, outside code and outside the extension's marks
// (a translated paragraph carries the mark itself, so only marked ancestors exclude).
function isParagraph(el: HTMLElement): boolean {
  return (
    !el.parentElement?.closest(`pre, code, [${MARK}]`) &&
    ![...el.querySelectorAll(NESTED_BLOCKS)].some(
      (b) => !b.closest(INSERTED) && /\S/.test(b.textContent ?? ""),
    ) &&
    /[A-Za-z]/.test(textOf(el))
  );
}

// DOM -> the structure src/text.ts works on. Elements without text (img, svg, br) are leaves and are cloned whole.
// The extension's inserted elements are left out.
function toInline(
  parent: Node,
  domOf: Map<InlineElement, Element>,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) nodes.push(child.textContent ?? "");
    else if (child instanceof Element && !isInserted(child)) {
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

// Paragraphs (or their ancestors) that a batch of page mutations touched. Changes inside the extension's
// inserted elements are not looked at.
function touchedParagraphs(records: MutationRecord[]): Set<HTMLElement> {
  const found = new Set<HTMLElement>();
  const add = (el: Element | null) => {
    if (el instanceof HTMLElement) found.add(el);
  };
  for (const r of records) {
    const target =
      r.target instanceof Element ? r.target : r.target.parentElement;
    if (!target?.isConnected || target.closest(INSERTED)) continue;
    add(target.closest(PARAGRAPHS));
    for (const node of r.addedNodes) {
      if (!(node instanceof Element) || isInserted(node)) continue;
      for (const el of node.querySelectorAll(PARAGRAPHS)) add(el);
      add(node.closest(PARAGRAPHS));
    }
  }
  return found;
}

// A document kept in the back/forward cache comes back with translation mode's state, but Chrome clears the
// badge: a normal navigation ends the mode.
function onPageHide(e: PageTransitionEvent): void {
  if (e.persisted) globalThis.browserTranslatorOff?.();
}

function start(serial: boolean, bilingual: boolean): void {
  let active = true;
  // Serial mode: the last paragraph that was translated, sent as translation history with the next one.
  let history: HistoryPair | undefined;
  const inserted: Element[] = [];
  // Every paragraph seen in this mode; paragraphs are the ones in the document, in document order.
  const byElement = new Map<Element, Paragraph>();
  let paragraphs: Paragraph[] = [];
  const pending = new Set<Paragraph>();
  let workers = 0;

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

  function markFailed(p: Paragraph, reason: string): void {
    const marker = document.createElement("span");
    marker.textContent = " ⚠";
    marker.title = `翻訳できませんでした（${reason}）`;
    marker.style.cssText = "color:#d93025;font-size:0.8em;cursor:help";
    p.added?.remove();
    insertMarked(marker, p.el);
    p.added = marker;
  }

  function show(p: Paragraph, nodes: Node[]): void {
    p.added?.remove();
    p.added = undefined;
    if (bilingual) {
      const translation = document.createElement("span");
      translation.lang = "ja";
      translation.style.cssText = "display:block;margin-top:0.25em";
      translation.append(...nodes);
      insertMarked(translation, p.el);
      p.added = translation;
      return;
    }
    p.original = [...p.el.childNodes];
    p.el.replaceChildren(...nodes);
    p.el.setAttribute(MARK, "translated");
    p.shown = textOf(p.el);
  }

  async function translateParagraph(p: Paragraph): Promise<void> {
    const source = p.source;
    const connected = paragraphs.filter((x) => x.el.isConnected);
    const i = connected.indexOf(p);
    // Read when sent: an SPA changes the title and description without reloading.
    const description =
      document
        .querySelector<HTMLMetaElement>('meta[name="description"]')
        ?.content.trim() ?? "";
    // Serial mode passes the previous translation as history instead of the neighbouring source paragraphs.
    const context = buildParallelContext({
      title: document.title,
      description,
      previous: serial ? "" : (connected[i - 1]?.source ?? ""),
      next: serial ? "" : (connected[i + 1]?.source ?? ""),
    });
    const domOf = new Map<InlineElement, Element>();
    const { text, elements } = toTagged(toInline(p.el, domOf));
    const tagged = text.replace(/\s+/g, " ").trim();
    let reason = "";
    for (const retry of [false, true]) {
      const req: TranslateRequest = {
        type: "translate",
        source: tagged,
        context,
        retry,
        history,
      };
      const res: TranslateResponse = await chrome.runtime.sendMessage(req);
      if (!active) return;
      // The page changed the paragraph while it was being translated; the change queued it again.
      if (p.source !== source || !p.el.isConnected) return;
      if (!res.ok) {
        if (res.unreachable) showConnectionError(res.message);
        else if (res.truncated) {
          reason = "長すぎて途中で切れました";
          continue; // treated like a tag mismatch: retry once, then keep the original
        } else markFailed(p, res.message);
        return;
      }
      const restored = restoreTags(res.text, elements);
      if (restored.ok) {
        show(p, toDom(restored.nodes, domOf));
        if (serial) history = { source: tagged, translation: res.text };
        return;
      }
      reason = `タグが合いません: ${restored.problems.join(", ")}`;
    }
    markFailed(p, reason);
  }

  function next(): Paragraph | undefined {
    if (!active) return undefined;
    let p: Paragraph | undefined;
    for (const q of pending)
      if (q.visible) {
        p = q;
        break;
      }
    p ??= pending.values().next().value;
    if (p) pending.delete(p);
    return p;
  }

  async function worker(): Promise<void> {
    try {
      for (let p = next(); p; p = next())
        if (p.el.isConnected) await translateParagraph(p);
    } finally {
      workers--; // in the same task as the last next(), so startWorkers never counts a worker that has stopped
    }
  }

  function startWorkers(): void {
    if (!active) return;
    const idle = Math.min(
      (serial ? 1 : PARALLEL_REQUESTS) - workers,
      pending.size,
    );
    for (let n = 0; n < idle; n++) {
      workers++;
      worker().catch((e: unknown) =>
        showConnectionError(e instanceof Error ? e.message : String(e)),
      );
    }
  }

  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const p = byElement.get(entry.target);
      if (p) p.visible = entry.isIntersecting;
    }
    // Every observe() reports once first, so the visible paragraphs are known before the workers start.
    startWorkers();
  });

  function addParagraphs(els: HTMLElement[]): void {
    for (const el of els) {
      const p: Paragraph = { el, source: textOf(el), visible: false };
      byElement.set(el, p);
      pending.add(p);
      intersection.observe(el);
    }
    paragraphs = [...byElement.values()]
      .filter((p) => p.el.isConnected)
      .toSorted((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      );
  }

  // The page changed a paragraph that was seen before; false when the change is the extension's own writing.
  function changedByPage(p: Paragraph): boolean {
    if (p.shown !== undefined) {
      if (textOf(p.el) === p.shown) return false;
      // The page replaced the translation: its new children are the original from now on.
      p.shown = undefined;
      p.original = undefined;
      p.el.removeAttribute(MARK);
    } else if (
      textOf(p.el) === p.source &&
      // The page redrew the paragraph with the same text and dropped the translation or failure marker.
      (p.added === undefined || p.added.isConnected)
    )
      return false;
    p.source = textOf(p.el);
    // The translation or failure marker belongs to the old text.
    p.added?.remove();
    p.added = undefined;
    return true;
  }

  // Paragraphs added or changed by the page (an SPA keeps the same document, so its new pages arrive here too).
  const mutations = new MutationObserver((records) => {
    if (!active) return;
    const added: HTMLElement[] = [];
    for (const el of touchedParagraphs(records)) {
      const p = byElement.get(el);
      if (p) {
        if (changedByPage(p) && isParagraph(el)) pending.add(p);
      } else if (!el.hasAttribute(MARK) && isParagraph(el)) added.push(el);
    }
    // Not left to the IntersectionObserver: it reports only when the page renders (not in a hidden tab).
    if (added.length > 0) addParagraphs(added);
    startWorkers();
  });

  addParagraphs(
    [...document.body.querySelectorAll<HTMLElement>(PARAGRAPHS)].filter(
      isParagraph,
    ),
  );
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  addEventListener("pagehide", onPageHide);

  // Hovering a replaced paragraph shows its original text; the bilingual display shows it already.
  const stopBubble = bilingual
    ? () => {}
    : startBubble((target) => {
        const el = target.closest(`[${MARK}="translated"]`);
        const p = el ? byElement.get(el) : undefined;
        // A paragraph whose translation the page replaced has no original to show.
        return p?.shown === undefined ? undefined : p;
      });

  globalThis.browserTranslatorOff = () => {
    active = false;
    stopBubble();
    removeEventListener("pagehide", onPageHide);
    mutations.disconnect();
    intersection.disconnect();
    for (const p of byElement.values()) {
      p.added?.remove();
      // A translation the page has already replaced is left as the page made it.
      if (p.shown === undefined || textOf(p.el) !== p.shown) continue;
      p.el.replaceChildren(...(p.original ?? []));
      p.el.removeAttribute(MARK);
      p.shown = undefined;
    }
    for (const el of inserted) el.remove();
    globalThis.browserTranslatorOff = undefined;
    status("off");
  };
  status("on");
}

if (globalThis.browserTranslatorOff) globalThis.browserTranslatorOff();
else {
  // A second injection while settings load cancels the pending start; no "off" status since the badge is not on yet.
  let cancelled = false;
  globalThis.browserTranslatorOff = () => {
    cancelled = true;
    globalThis.browserTranslatorOff = undefined;
  };
  loadSettings().then((settings) => {
    if (!cancelled)
      start(settings.mode === "serial", settings.display === "bilingual");
  }, console.error);
}
