// The small red notice at the top right of the page (connection errors, a page the reader cannot show).
export function noticeElement(text: string): HTMLDivElement {
  const notice = document.createElement("div");
  notice.textContent = text;
  notice.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;max-width:420px;padding:10px 14px;" +
    "background:#d93025;color:#fff;font:14px/1.5 sans-serif;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  return notice;
}
