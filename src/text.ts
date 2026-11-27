// Pure translation logic shared by the service worker, the content script and tests (no DOM, no chrome API).

export type InlineNode = string | InlineElement;
export interface InlineElement {
  kind: string;
  children: InlineNode[];
}

// A translated element: the source element it restores (looked up by identity) around translated children.
export type RestoredNode =
  | string
  | { source: InlineElement; children: RestoredNode[] };

// Opening tag as sent (e.g. "<a>" or '<code id="3">') -> the source element it stands for.
type TagMap = Record<string, InlineElement>;

// The paragraph as sent: each element as an HTML tag of its own name (with id="<n>" only when the name repeats),
// text escaped. Empty elements are sent as an open and close pair without their contents.
export function toTagged(nodes: InlineNode[]): {
  text: string;
  elements: TagMap;
} {
  const counts: Record<string, number> = {};
  const count = (list: InlineNode[]): void => {
    for (const node of list)
      if (typeof node !== "string") {
        counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        count(node.children);
      }
  };
  count(nodes);
  const elements: TagMap = {};
  let n = 0;
  const walk = (list: InlineNode[]): string =>
    list
      .map((node) => {
        if (typeof node === "string") return escapeText(node);
        n++;
        const open =
          counts[node.kind] > 1 ? `<${node.kind} id="${n}">` : `<${node.kind}>`;
        elements[open] = node;
        return `${open}${walk(node.children)}</${node.kind}>`;
      })
      .join("");
  return { text: walk(nodes), elements };
}

const escapeText = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};

// Only the three entities escapeText writes; any other entity the model writes stays as text.
const unescapeText = (s: string) =>
  s.replace(/&(?:amp|lt|gt);/g, (e) => ENTITY[e]);

type RestoreResult =
  | { ok: true; nodes: RestoredNode[] }
  | { ok: false; problems: string[] };

// shortcut: element names outside [a-z][a-z0-9-]* (SVG camelCase such as clipPath, custom names with "_" or ".") never match, so such paragraphs are marked untranslated; widen the name pattern if real pages need them.
// A tag in the translation: a closing tag, or an opening tag with whatever attributes the model wrote.
const TAG = /<\/([a-z][a-z0-9-]*)>|<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/g;

// Rebuilds the translated paragraph: each tag becomes its source element around the translated children.
export function restoreTags(text: string, elements: TagMap): RestoreResult {
  const problems = checkTags(text, elements);
  if (problems.length > 0) return { ok: false, problems };
  const root: RestoredNode[] = [];
  const stack: { open: string; name: string; children: RestoredNode[] }[] = [
    { open: "", name: "", children: root },
  ];
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    const top = stack[stack.length - 1];
    if (m.index > last)
      top.children.push(unescapeText(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const [tag, closing, opening] = m;
    if (closing) {
      if (top.name !== closing)
        return { ok: false, problems: [`unbalanced ${tag}`] };
      stack.pop();
      const parent = stack[stack.length - 1];
      const source = elements[top.open];
      // Code is never translated: keep the source contents whatever the model wrote inside the tag.
      const children =
        source.kind === "code" ? source.children.map(asRestored) : top.children;
      parent.children.push({ source, children });
    } else {
      stack.push({ open: tag, name: opening, children: [] });
    }
  }
  if (stack.length > 1)
    return {
      ok: false,
      problems: [`unclosed ${stack[stack.length - 1].open}`],
    };
  if (last < text.length) root.push(unescapeText(text.slice(last)));
  return { ok: true, nodes: root };
}

const asRestored = (node: InlineNode): RestoredNode =>
  typeof node === "string"
    ? node
    : { source: node, children: node.children.map(asRestored) };

// The opening tags (name and attributes) must be exactly the source ones, each once.
function checkTags(text: string, elements: TagMap): string[] {
  const opened = new Map<string, number>();
  for (const [tag, closing] of text.matchAll(TAG))
    if (!closing) opened.set(tag, (opened.get(tag) ?? 0) + 1);
  const problems: string[] = [];
  for (const [tag, count] of opened) {
    if (!Object.hasOwn(elements, tag)) problems.push(`unknown ${tag}`);
    else if (count > 1) problems.push(`duplicated ${tag}`);
  }
  for (const tag of Object.keys(elements))
    if (!opened.has(tag)) problems.push(`missing ${tag}`);
  return problems;
}

const T = "<|plamo:tag|>";
export const PLAMO_STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];

interface ParallelContext {
  title: string;
  description: string;
  previous: string;
  next: string;
}

// Context for parallel mode: the page description (<title> and meta description) and the neighbouring source paragraphs.
export function buildParallelContext(c: ParallelContext): string {
  const page = [c.title, c.description].filter(Boolean).join(" - ");
  return [
    page && `Page: ${page}`,
    c.previous && `Previous paragraph: ${c.previous}`,
    c.next && `Next paragraph: ${c.next}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface GlossaryEntry {
  source: string;
  target: string;
}

// A previously translated paragraph: the tagged source that was sent and the tagged translation that came back.
export interface HistoryPair {
  source: string;
  translation: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Glossary entries whose source term appears in the paragraph as a whole word, ignoring case.
// Inline tags such as <a> or <code id="3"> are removed and &amp; &lt; &gt; turned back into characters first,
// so tags neither match nor split words. Word forms are not handled.
export function matchGlossary(
  source: string,
  glossary: GlossaryEntry[],
): GlossaryEntry[] {
  const text = unescapeText(source.replace(TAG, ""));
  return glossary.filter((entry) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(entry.source)}(?![\\p{L}\\p{N}_])`,
      "iu",
    ).test(text),
  );
}

// en -> ja polite PFML3 prompt (PLaMo 3 Translate model card): dataset, context, history input/output pairs,
// glossary, then the current input. form applies only to the current output.
export function buildPfml3Prompt(
  source: string,
  context: string,
  {
    history = [],
    glossary = [],
  }: { history?: HistoryPair[]; glossary?: GlossaryEntry[] } = {},
): string {
  const ctx = context ? `${T}context<|plamo:msg|>${context}` : "";
  const pairs = history
    .map(
      (h) =>
        `${T}input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${h.source}` +
        `${T}output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>${h.translation}`,
    )
    .join("");
  const terms =
    glossary.length > 0
      ? `${T}glossary${glossary.map((g) => `<|plamo:index|>${g.source}<|plamo:item|>${g.target}`).join("")}`
      : "";
  return (
    `${T}dataset<|plamo:msg|>translation${ctx}${pairs}${terms}` +
    `${T}input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${source}` +
    `${T}output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>`
  );
}
