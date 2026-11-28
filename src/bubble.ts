// The original-text bubble of the replace display: hovering a translated paragraph for a moment shows its
// original text right below it (above when only that fits), in a shadow root the page's CSS does not reach.

const SHOW_DELAY_MS = 500;
// Time to cross the gap between the paragraph and the bubble before it hides.
const HIDE_DELAY_MS = 300;
const GAP_PX = 4;

// Below when the bubble fits under the paragraph, else above when it fits there, else below.
// Viewport coordinates.
export function bubbleSide(
  paragraphTop: number,
  paragraphBottom: number,
  bubbleHeight: number,
  viewportHeight: number,
): "below" | "above" {
  if (paragraphBottom + GAP_PX + bubbleHeight <= viewportHeight) return "below";
  if (paragraphTop - GAP_PX - bubbleHeight >= 0) return "above";
  return "below";
}

export interface Original {
  el: HTMLElement;
  source: string;
}

// Starts showing bubbles for the paragraphs originalAt finds under the mouse; returns the function that stops.
export function startBubble(
  originalAt: (target: Element) => Original | undefined,
): () => void {
  let host: HTMLElement | undefined;
  let shownFor: HTMLElement | undefined;
  let waitingFor: HTMLElement | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelHide(): void {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function hide(): void {
    cancelHide();
    host?.remove();
    host = undefined;
    shownFor = undefined;
  }

  function show(original: Original): void {
    // The page may have removed the paragraph while the show timer waited.
    if (!original.el.isConnected) return;
    hide();
    const rect = original.el.getBoundingClientRect();
    host = document.createElement("div");
    // Outside body (the MutationObserver's root) and marked as inserted, like the extension's other elements.
    host.setAttribute("data-browser-translator", "inserted");
    // Inline, so the page's own rules for div do not apply; all:initial also stops inheritance from <html>.
    host.style.cssText = `all:initial;display:block;position:absolute;z-index:2147483647;box-sizing:border-box;width:${rect.width}px;left:${rect.left + scrollX}px;top:0`;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      "div{display:block;box-sizing:border-box;padding:8px 12px;background:#fff;color:#1f1f1f;" +
      "border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);" +
      "font-family:system-ui,sans-serif;line-height:1.5;text-align:left;white-space:normal;" +
      "overflow-wrap:anywhere;user-select:text;cursor:text}";
    const text = document.createElement("div");
    text.style.fontSize = getComputedStyle(original.el).fontSize;
    text.textContent = original.source;
    shadow.append(style, text);
    document.documentElement.append(host);
    const height = host.getBoundingClientRect().height;
    const side = bubbleSide(
      rect.top,
      rect.bottom,
      height,
      document.documentElement.clientHeight,
    );
    const top =
      side === "below" ? rect.bottom + GAP_PX : rect.top - GAP_PX - height;
    host.style.top = `${top + scrollY}px`;
    shownFor = original.el;
  }

  function onOver(e: MouseEvent): void {
    const target = e.target;
    // Events from inside the shadow root reach the document retargeted to the host.
    if (target === host) {
      cancelHide();
      // A paragraph crossed in the gap on the way to the bubble must not replace it.
      clearTimeout(showTimer);
      waitingFor = undefined;
      return;
    }
    const original = target instanceof Element ? originalAt(target) : undefined;
    if (shownFor && original?.el === shownFor) {
      cancelHide();
      return;
    }
    if (original?.el !== waitingFor) {
      clearTimeout(showTimer);
      waitingFor = original?.el;
      if (original)
        showTimer = setTimeout(() => {
          waitingFor = undefined;
          show(original);
        }, SHOW_DELAY_MS);
    }
    // A button held down is a selection drag, which leaving the bubble must not cut short.
    if (host && hideTimer === undefined && e.buttons === 0)
      hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  // The mouse left the window.
  function onOut(e: MouseEvent): void {
    if (e.relatedTarget) return;
    clearTimeout(showTimer);
    waitingFor = undefined;
    if (host && hideTimer === undefined)
      hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  return () => {
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("mouseout", onOut, true);
    clearTimeout(showTimer);
    hide();
  };
}
