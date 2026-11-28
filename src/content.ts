// Content script, injected by the toolbar button: the first injection turns translation mode on,
// the next one in the same document turns it off and restores the original DOM.
// The reader's context menu item and shortcut inject it after setting browserTranslatorCommand to "reader",
// which opens or closes the reader instead.
import type {
  StatusMessage,
  TranslateRequest,
  TranslateResponse,
} from "./background.ts";
import { type BubbleLook, startBubble } from "./bubble.ts";
import { noticeElement } from "./notice.ts";
import { type OpenReader, toggleReader } from "./reader.ts";
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

// Survives between injections into the same document.
declare global {
  // Set while translation mode is on (or its settings load).
  var browserTranslatorOff: (() => void) | undefined;
  // Set while translation mode is on; the reader tells it when it opens and closes.
  var browserTranslatorMode:
    | {
        readerOpened: (reader: OpenReader) => void;
        readerClosed: () => void;
        // The page's own children of a replaced paragraph, so the reader copies the original text.
        originalOf: (el: Element) => Node[] | undefined;
      }
    | undefined;
  // Turns translation mode on or off (the reader's translate button).
  var browserTranslatorToggle: (() => void) | undefined;
  // Set by the service worker right before injecting this script; read and cleared once.
  var browserTranslatorCommand: "reader" | undefined;
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

interface TranslatorOptions {
  serial: boolean;
  bilingual: boolean;
  onUnreachable: (message: string) => void;
  // The reader's: its bubble look and the shadow root holding root.
  bubbleLook?: () => BubbleLook;
  shadow?: ShadowRoot;
}

// Translates the paragraphs under root (document.body or the reader's article). Nothing is sent before the first
// resume(); pause() stops new requests and the observers, resume() looks at root again and queues what is not
// translated yet and what the page added or changed meanwhile; stop() also restores the original DOM.
function translator(root: HTMLElement, options: TranslatorOptions) {
  const { serial, bilingual } = options;
  let running = false;
  // Bumped by pause(): a response to a request sent before is dropped (its paragraph was queued again).
  let generation = 0;
  // Serial mode: the last paragraph that was translated, sent as translation history with the next one.
  let history: HistoryPair | undefined;
  const inserted: Element[] = [];
  // Every paragraph seen under root; paragraphs are the connected ones, in document order.
  const byElement = new Map<Element, Paragraph>();
  let paragraphs: Paragraph[] = [];
  const pending = new Set<Paragraph>();
  const inFlight = new Set<Paragraph>();
  let workers = 0;

  function insertMarked(el: HTMLElement, parent: Element): void {
    el.setAttribute(MARK, "inserted");
    parent.append(el);
    inserted.push(el);
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
    const gen = generation;
    inFlight.add(p);
    try {
      await send(p, gen);
    } finally {
      // After a pause the paragraph may be in flight again under the new generation.
      if (gen === generation) inFlight.delete(p);
    }
  }

  async function send(p: Paragraph, gen: number): Promise<void> {
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
      if (gen !== generation) return;
      // The page changed the paragraph while it was being translated; the change queued it again.
      if (p.source !== source || !p.el.isConnected) return;
      if (!res.ok) {
        if (res.unreachable) options.onUnreachable(res.message);
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
    if (!running) return undefined;
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
    if (!running) return;
    const idle = Math.min(
      (serial ? 1 : PARALLEL_REQUESTS) - workers,
      pending.size,
    );
    for (let n = 0; n < idle; n++) {
      workers++;
      worker().catch((e: unknown) =>
        options.onUnreachable(e instanceof Error ? e.message : String(e)),
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

  // Seen paragraphs the page changed are queued again; new paragraphs are added.
  function collect(els: Iterable<HTMLElement>): void {
    const added: HTMLElement[] = [];
    for (const el of els) {
      const p = byElement.get(el);
      if (p) {
        if (changedByPage(p) && isParagraph(el)) pending.add(p);
      } else if (!el.hasAttribute(MARK) && isParagraph(el)) added.push(el);
    }
    if (added.length > 0) addParagraphs(added);
  }

  // Paragraphs added or changed by the page (an SPA keeps the same document, so its new pages arrive here too).
  const mutations = new MutationObserver((records) => {
    if (!running) return;
    collect(touchedParagraphs(records));
    // Not left to the IntersectionObserver: it reports only when the page renders (not in a hidden tab).
    startWorkers();
  });

  // Hovering a replaced paragraph shows its original text; the bilingual display shows it already.
  // The page's bubbles are off while the reader is open, so none shows over it.
  let stopBubble: (() => void) | undefined;
  function showBubbles(on: boolean): void {
    stopBubble?.();
    stopBubble =
      on && !bilingual
        ? startBubble(
            (target) => {
              const el = target.closest(`[${MARK}="translated"]`);
              const p = el ? byElement.get(el) : undefined;
              // A paragraph whose translation the page replaced has no original to show.
              return p?.shown === undefined ? undefined : p;
            },
            options.bubbleLook,
            options.shadow,
          )
        : undefined;
  }
  showBubbles(true);

  function pause(): void {
    if (!running) return;
    running = false;
    generation++;
    mutations.disconnect();
    intersection.disconnect();
    // Their responses are dropped; resume() sends them again.
    for (const p of inFlight) pending.add(p);
    inFlight.clear();
  }

  function resume(): void {
    if (running) return;
    running = true;
    collect(root.querySelectorAll<HTMLElement>(PARAGRAPHS));
    for (const p of paragraphs) intersection.observe(p.el);
    mutations.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Every observe() reports once first (after a disconnect too), and that report starts the workers, so the
    // visible paragraphs are known before.
  }

  function stop(): void {
    pause();
    showBubbles(false);
    for (const p of byElement.values()) {
      p.added?.remove();
      // A translation the page has already replaced is left as the page made it.
      if (p.shown === undefined || textOf(p.el) !== p.shown) continue;
      p.el.replaceChildren(...(p.original ?? []));
      p.el.removeAttribute(MARK);
      p.shown = undefined;
    }
    for (const el of inserted) el.remove();
  }

  const originalOf = (el: Element) => {
    const p = byElement.get(el);
    return p?.shown === undefined ? undefined : p.original;
  };

  return { pause, resume, stop, showBubbles, originalOf };
}

// Translation mode of the tab: the page is translated, except while the reader is open, when only the reader is.
function start(serial: boolean, bilingual: boolean): void {
  let failed = false;
  let notice: HTMLElement | undefined;
  let inReader: ReturnType<typeof translator> | undefined;

  function showConnectionError(message: string): void {
    if (failed) return;
    failed = true; // stop sending; the next button press turns the mode off and removes the notice
    page.pause();
    inReader?.pause();
    status("error");
    globalThis.browserTranslatorReader?.showMode("error");
    notice = noticeElement(
      `Browser Translator: llama-server に接続できません（${message}）`,
    );
    notice.setAttribute(MARK, "inserted");
    // Outside body while the reader is open: a body that makes its own stacking context would keep it under the
    // reader's host; after the host in <html> with a higher z-index it is above.
    (globalThis.browserTranslatorReader
      ? document.documentElement
      : document.body
    ).append(notice);
  }

  const page = translator(document.body, {
    serial,
    bilingual,
    onUnreachable: showConnectionError,
  });

  function readerOpened(reader: OpenReader): void {
    page.pause();
    page.showBubbles(false);
    inReader?.stop();
    inReader = translator(reader.article, {
      serial,
      bilingual,
      onUnreachable: showConnectionError,
      bubbleLook: reader.bubbleLook,
      shadow: reader.shadow,
    });
    if (failed) {
      if (notice) document.documentElement.append(notice);
      reader.showMode("error");
      return;
    }
    inReader.resume();
    reader.showMode("on");
  }

  // The reader's translations are dropped (opening it again translates again).
  function readerClosed(): void {
    inReader?.stop();
    inReader = undefined;
    page.showBubbles(true);
    if (!failed) page.resume();
  }

  globalThis.browserTranslatorMode = {
    readerOpened,
    readerClosed,
    originalOf: page.originalOf,
  };
  addEventListener("pagehide", onPageHide);

  globalThis.browserTranslatorOff = () => {
    page.stop();
    inReader?.stop();
    notice?.remove();
    removeEventListener("pagehide", onPageHide);
    globalThis.browserTranslatorMode = undefined;
    globalThis.browserTranslatorOff = undefined;
    globalThis.browserTranslatorReader?.showMode("off");
    status("off");
  };
  status("on");
  const reader = globalThis.browserTranslatorReader;
  // Turned on while the reader is open: the page waits until it closes.
  if (reader) readerOpened(reader);
  else page.resume();
}

// The toolbar button and the reader's translate button.
function toggleMode(): void {
  if (globalThis.browserTranslatorOff) {
    globalThis.browserTranslatorOff();
    return;
  }
  // A second toggle while settings load cancels the pending start; no "off" status since the badge is not on yet.
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

globalThis.browserTranslatorToggle = toggleMode;
const command = globalThis.browserTranslatorCommand;
globalThis.browserTranslatorCommand = undefined;
if (command === "reader") toggleReader();
else toggleMode();
