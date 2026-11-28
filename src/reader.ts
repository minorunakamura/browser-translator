// The reader: the article of the page at the moment it opens (extracted with Readability), drawn in a shadow root
// on a full-window layer over the current tab. Only the layer scrolls, so the page stays where it was.
import { Readability } from "@mozilla/readability";
import { noticeElement } from "./notice.ts";

const MARK = "data-browser-translator";
const NOTICE_MS = 4000;

const READER_THEMES = {
  black: {
    background: "#1e1e1e",
    text: "#d4d4d4",
    code: "#2a2a2a",
    link: "#6cb6ff",
  },
  sepia: {
    background: "#f4ecd8",
    text: "#5b4636",
    code: "#ebe1c9",
    link: "#8b4513",
  },
  white: {
    background: "#ffffff",
    text: "#1f1f1f",
    code: "#f4f4f4",
    link: "#1a5fb4",
  },
} as const;
const READER_FONTS = {
  gothic:
    '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif',
  mincho: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif',
} as const;
const CODE_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const READER_SIZES_PX = [14, 16, 18, 20, 22, 24, 28];
const READER_WIDTHS_EM = [30, 35, 40, 45, 50, 60];

// The reader's look, saved in chrome.storage.local under the "reader" key (apart from the extension's Settings).
interface ReaderLook {
  theme: keyof typeof READER_THEMES;
  font: keyof typeof READER_FONTS;
  sizePx: number;
  widthEm: number;
}

const DEFAULT_LOOK: ReaderLook = {
  theme: "black",
  font: "gothic",
  sizePx: 18,
  widthEm: 40,
};

// The value one step up (+1) or down (-1) from current in steps, kept at the ends.
export function stepValue(
  steps: readonly number[],
  current: number,
  delta: 1 | -1,
): number {
  const i = steps.indexOf(current);
  return steps[Math.min(steps.length - 1, Math.max(0, i + delta))];
}

// A saved value that is not one of the choices (e.g. from an older version) falls back to the default.
export function validLook(saved: Partial<ReaderLook> | undefined): ReaderLook {
  const look = { ...DEFAULT_LOOK, ...saved };
  return {
    theme: Object.hasOwn(READER_THEMES, look.theme)
      ? look.theme
      : DEFAULT_LOOK.theme,
    font: Object.hasOwn(READER_FONTS, look.font)
      ? look.font
      : DEFAULT_LOOK.font,
    sizePx: READER_SIZES_PX.includes(look.sizePx)
      ? look.sizePx
      : DEFAULT_LOOK.sizePx,
    widthEm: READER_WIDTHS_EM.includes(look.widthEm)
      ? look.widthEm
      : DEFAULT_LOOK.widthEm,
  };
}

async function loadLook(): Promise<ReaderLook> {
  const { reader } = await chrome.storage.local.get<{
    reader?: Partial<ReaderLook>;
  }>("reader");
  return validLook(reader);
}

// Survives between injections into the same document; set while the reader is open (or loading).
declare global {
  var browserTranslatorReaderClose: (() => void) | undefined;
}

// Code blocks built from one element per line (react.dev's div.cm-line with a trailing br) become paragraphs
// without their indentation in Readability. Each pre of the copy gets only the text the page shows, in one code.
// innerText ends every line element with the br's newline plus the block's, so those doubled newlines become one;
// a pre without line elements keeps its text as shown (its blank lines included).
function flattenCodeBlocks(copy: Document): void {
  const live = [...document.querySelectorAll("pre")];
  [...copy.querySelectorAll("pre")].forEach((pre, i) => {
    const source = live[i];
    if (!source) return;
    let text = source.innerText;
    if (source.querySelector("div, p")) text = text.replace(/\n\n/g, "\n");
    const code = copy.createElement("code");
    code.textContent = text.replace(/\n$/, "");
    pre.replaceChildren(code);
  });
}

function extract(): { title: string; content: string } | undefined {
  const copy = document.cloneNode(true);
  if (!(copy instanceof Document)) return undefined;
  flattenCodeBlocks(copy);
  const article = new Readability(copy).parse();
  if (!article?.content || !article.textContent?.trim()) return undefined;
  return { title: article.title ?? "", content: article.content };
}

function showCannotOpen(): void {
  const notice = noticeElement("このページはリーダー表示にできません");
  notice.setAttribute(MARK, "inserted");
  document.body.append(notice);
  setTimeout(() => notice.remove(), NOTICE_MS);
}

// The article HTML parsed inertly, without the page's inline event handlers.
function articleNodes(content: string): Node[] {
  const parsed = new DOMParser().parseFromString(content, "text/html");
  for (const el of parsed.body.querySelectorAll("*"))
    for (const name of el.getAttributeNames())
      if (name.startsWith("on")) el.removeAttribute(name);
  return [...parsed.body.childNodes];
}

const STYLE = `
:host{all:initial}
.layer{position:absolute;inset:0;overflow-y:scroll;overscroll-behavior:contain;outline:none;
  background:var(--bg);color:var(--fg)}
.bar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 12px;
  background:var(--bg);border-bottom:1px solid var(--code);font:13px/1.4 system-ui,sans-serif}
.bar .group{display:inline-flex;align-items:center;gap:2px}
.bar .label{margin:0 4px 0 8px}
.bar .spacer{flex:1}
.bar button{font:inherit;color:var(--fg);background:transparent;border:1px solid var(--code);border-radius:4px;
  padding:2px 8px;cursor:pointer}
.bar button[aria-pressed="true"]{background:var(--code);font-weight:bold}
.bar button:disabled{opacity:.45;cursor:default}
article{box-sizing:border-box;max-width:var(--width);margin:0 auto;padding:24px 20px 80px;
  font-family:var(--font);font-size:var(--size);line-height:1.8;overflow-wrap:break-word}
article a{color:var(--link)}
article img,article video{max-width:100%;height:auto}
article pre{font-family:${CODE_FONT};font-size:.85em;line-height:1.5;white-space:pre;overflow-x:auto;
  background:var(--code);padding:12px 14px;border-radius:6px}
article code{font-family:${CODE_FONT};font-size:.9em;background:var(--code);padding:.1em .3em;border-radius:3px}
article pre code{font-size:inherit;background:none;padding:0;border-radius:0}
article table{display:block;overflow-x:auto;border-collapse:collapse}
article th,article td{border:1px solid var(--code);padding:4px 8px;text-align:left;vertical-align:top}
article blockquote{margin-left:0;padding-left:1em;border-left:3px solid var(--code)}
`;

function button(
  text: string,
  onPress: () => void,
  title?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener("click", onPress);
  return b;
}
function group(
  label: string,
  ...buttons: HTMLButtonElement[]
): HTMLSpanElement {
  const g = document.createElement("span");
  g.className = "group";
  if (label) {
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    g.append(l);
  }
  g.append(...buttons);
  return g;
}

function open(): void {
  // The copy is taken now, so later changes of the page do not reach the reader.
  const article = extract();
  if (!article) {
    showCannotOpen();
    return;
  }
  let cancelled = false;
  globalThis.browserTranslatorReaderClose = () => {
    cancelled = true;
    globalThis.browserTranslatorReaderClose = undefined;
  };
  loadLook().then((look) => {
    if (!cancelled) show(article, look);
  }, console.error);
}

// The keyup of Esc while the reader is open (and of the Esc that closes it) does not reach the page either.
function onKeyUp(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function show(
  article: { title: string; content: string },
  saved: ReaderLook,
): void {
  let look = saved;
  // Focus moving to the page behind (Shift+Tab) scrolls it; close() puts it back.
  const { scrollX: pageX, scrollY: pageY } = window;
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;

  const host = document.createElement("div");
  host.setAttribute(MARK, "inserted");
  // Inline, so the page's rules for div do not apply; outside body like the extension's bubble.
  host.style.cssText =
    "all:initial;display:block;position:fixed;inset:0;z-index:2147483646";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const layer = document.createElement("div");
  layer.className = "layer";
  // Focused so the keyboard scrolls the reader, not the page.
  layer.tabIndex = -1;

  const bar = document.createElement("div");
  bar.className = "bar";
  const update = (next: Partial<ReaderLook>) => {
    look = { ...look, ...next };
    apply();
    chrome.storage.local.set({ reader: look }).catch(console.error);
  };
  // Translation inside the reader comes later; the button is in place but does nothing yet.
  const translateButton = button(
    "翻訳",
    () => {},
    "リーダーの中の翻訳はまだ使えません",
  );
  translateButton.disabled = true;
  translateButton.dataset.action = "translate";
  const themeButtons = (
    [
      ["black", "黒"],
      ["sepia", "セピア"],
      ["white", "白"],
    ] as const
  ).map(([theme, text]) => {
    const b = button(text, () => update({ theme }));
    b.dataset.action = `theme-${theme}`;
    return b;
  });
  const fontButtons = (
    [
      ["gothic", "ゴシック"],
      ["mincho", "明朝"],
    ] as const
  ).map(([font, text]) => {
    const b = button(text, () => update({ font }));
    b.dataset.action = `font-${font}`;
    return b;
  });
  const sizeDown = button("−", () =>
    update({ sizePx: stepValue(READER_SIZES_PX, look.sizePx, -1) }),
  );
  const sizeUp = button("+", () =>
    update({ sizePx: stepValue(READER_SIZES_PX, look.sizePx, 1) }),
  );
  const widthDown = button("−", () =>
    update({ widthEm: stepValue(READER_WIDTHS_EM, look.widthEm, -1) }),
  );
  const widthUp = button("+", () =>
    update({ widthEm: stepValue(READER_WIDTHS_EM, look.widthEm, 1) }),
  );
  sizeDown.dataset.action = "size-down";
  sizeUp.dataset.action = "size-up";
  widthDown.dataset.action = "width-down";
  widthUp.dataset.action = "width-up";
  const closeButton = button("✕", close, "閉じる（Esc）");
  closeButton.dataset.action = "close";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  bar.append(
    group("", translateButton),
    group("", ...themeButtons),
    group("", ...fontButtons),
    group("文字", sizeDown, sizeUp),
    group("行幅", widthDown, widthUp),
    spacer,
    closeButton,
  );

  const body = document.createElement("article");
  if (article.title) {
    const h1 = document.createElement("h1");
    h1.textContent = article.title;
    body.append(h1);
  }
  body.append(...articleNodes(article.content));
  layer.append(bar, body);
  shadow.append(style, layer);

  function apply(): void {
    const theme = READER_THEMES[look.theme];
    layer.style.setProperty("--bg", theme.background);
    layer.style.setProperty("--fg", theme.text);
    layer.style.setProperty("--code", theme.code);
    layer.style.setProperty("--link", theme.link);
    layer.style.setProperty("--font", READER_FONTS[look.font]);
    layer.style.setProperty("--size", `${look.sizePx}px`);
    layer.style.setProperty("--width", `${look.widthEm}em`);
    for (const b of themeButtons)
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.action === `theme-${look.theme}`),
      );
    for (const b of fontButtons)
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.action === `font-${look.font}`),
      );
    sizeDown.disabled = look.sizePx === READER_SIZES_PX[0];
    sizeUp.disabled = look.sizePx === READER_SIZES_PX.at(-1);
    widthDown.disabled = look.widthEm === READER_WIDTHS_EM[0];
    widthUp.disabled = look.widthEm === READER_WIDTHS_EM.at(-1);
  }

  // A link closes the reader and is followed by the page itself, in the same tab (#… too).
  function onLinkClick(e: Event): void {
    if (!(e instanceof MouseEvent)) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
      return;
    const link = e
      .composedPath()
      .find(
        (n): n is HTMLAnchorElement =>
          n instanceof HTMLAnchorElement && n.href !== "",
      );
    if (!link || !body.contains(link)) return;
    e.preventDefault();
    const href = link.href;
    close();
    location.assign(href);
  }

  // Captured on window before the page's own listeners on the document and below; Esc closes even with a
  // selection and does not reach the page. Listeners the page added in capture on window earlier still see it.
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    // The keyup of this Esc comes after closing.
    addEventListener("keyup", onKeyUp, { capture: true, once: true });
  }

  // A document kept in the back/forward cache comes back without the reader.
  function onPageHide(e: PageTransitionEvent): void {
    if (e.persisted) close();
  }

  function close(): void {
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("pagehide", onPageHide);
    host.remove();
    previousFocus?.focus({ preventScroll: true });
    // instant: a page with scroll-behavior:smooth would otherwise still be moving when a #… link follows.
    scrollTo({ left: pageX, top: pageY, behavior: "instant" });
    globalThis.browserTranslatorReaderClose = undefined;
  }

  apply();
  shadow.addEventListener("click", onLinkClick);
  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  addEventListener("pagehide", onPageHide);
  document.documentElement.append(host);
  layer.focus({ preventScroll: true });
  globalThis.browserTranslatorReaderClose = close;
}

// Opens the reader, or closes it when it is open.
export function toggleReader(): void {
  if (globalThis.browserTranslatorReaderClose)
    globalThis.browserTranslatorReaderClose();
  else open();
}
