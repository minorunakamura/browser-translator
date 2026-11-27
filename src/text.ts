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

// Tag name (e.g. "a1") -> the source element it stands for.
type TagMap = Record<string, InlineElement>;

const SHORT_TAG: Record<string, string> = {
  a: "a",
  code: "c",
  strong: "b",
  b: "b",
  em: "i",
  i: "i",
};

export function toTagged(nodes: InlineNode[]): {
  text: string;
  elements: TagMap;
} {
  const counts: Record<string, number> = {};
  const elements: TagMap = {};
  const walk = (list: InlineNode[]): string =>
    list
      .map((node) => {
        if (typeof node === "string") return node;
        const short = SHORT_TAG[node.kind] ?? "x";
        counts[short] = (counts[short] ?? 0) + 1;
        const name = `${short}${counts[short]}`;
        elements[name] = node;
        return `<${name}>${walk(node.children)}</${name}>`;
      })
      .join("");
  return { text: walk(nodes), elements };
}

type RestoreResult =
  | { ok: true; nodes: RestoredNode[] }
  | { ok: false; problems: string[] };

// Rebuilds the translated paragraph: each tag becomes its source element around the translated children.
export function restoreTags(text: string, elements: TagMap): RestoreResult {
  const problems = checkTags(text, elements);
  if (problems.length > 0) return { ok: false, problems };
  const root: RestoredNode[] = [];
  const stack: { name: string; children: RestoredNode[] }[] = [
    { name: "", children: root },
  ];
  let last = 0;
  for (const m of text.matchAll(/<(\/?)([a-z]\d+)>/g)) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, name] = m;
    if (closing) {
      if (top.name !== name)
        return { ok: false, problems: [`unbalanced ${name}`] };
      stack.pop();
      const parent = stack[stack.length - 1];
      const source = elements[name];
      // Code is never translated: keep the source contents whatever the model wrote inside the tag.
      const children =
        source.kind === "code" ? source.children.map(asRestored) : top.children;
      parent.children.push({ source, children });
    } else {
      stack.push({ name, children: [] });
    }
  }
  if (stack.length > 1)
    return { ok: false, problems: [`unbalanced ${stack[1].name}`] };
  if (last < text.length) root.push(text.slice(last));
  return { ok: true, nodes: root };
}

const asRestored = (node: InlineNode): RestoredNode =>
  typeof node === "string"
    ? node
    : { source: node, children: node.children.map(asRestored) };

// Every source tag must be opened exactly once and no other tag may appear.
// shortcut: source text that literally looks like a tag (e.g. "<h1>") always fails validation and is left untranslated with a marker; escape "<" if real pages need it.
function checkTags(text: string, elements: TagMap): string[] {
  const opened = new Map<string, number>();
  for (const [, name] of text.matchAll(/<\/?([a-z]\d+)>/g))
    if (!opened.has(name)) opened.set(name, 0);
  for (const [, name] of text.matchAll(/<([a-z]\d+)>/g))
    opened.set(name, (opened.get(name) ?? 0) + 1);
  const problems: string[] = [];
  for (const [name, count] of opened) {
    if (!Object.hasOwn(elements, name)) problems.push(`unknown ${name}`);
    else if (count > 1) problems.push(`duplicated ${name}`);
  }
  for (const name of Object.keys(elements))
    if (!opened.get(name)) problems.push(`missing ${name}`);
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

// en -> ja polite PFML3 prompt; context goes right after dataset (PLaMo 3 Translate model card).
export function buildPfml3Prompt(source: string, context: string): string {
  const ctx = context ? `${T}context<|plamo:msg|>${context}` : "";
  return (
    `${T}dataset<|plamo:msg|>translation${ctx}` +
    `${T}input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${source}` +
    `${T}output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>`
  );
}
