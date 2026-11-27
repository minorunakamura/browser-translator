// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (Node standard library only).
// Chrome reads commands from fd 3 and writes responses/events to fd 4; messages are NUL-terminated JSON.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

export const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// CDP payloads are untyped JSON; callers narrow what they read.
type Json = any;

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
  sessionId?: string;
}

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

export interface LaunchedChrome {
  proc: ChildProcess;
  cdp: CdpPipe;
  userDataDir: string;
  stderr: string[];
  close: () => Promise<void>;
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export function launchChrome({
  chromePath = CHROME_PATH,
  extraArgs = [],
}: {
  chromePath?: string;
  extraArgs?: string[];
} = {}): LaunchedChrome {
  const userDataDir = mkdtempSync(join(tmpdir(), "bt-chrome-"));
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  proc.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  const [, , , commandPipe, eventPipe] = proc.stdio;
  if (!(commandPipe instanceof Writable) || !(eventPipe instanceof Readable)) {
    proc.kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error("chrome debugging pipes (fd 3/4) are not available");
  }
  const cdp = new CdpPipe(commandPipe, eventPipe);
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.once("exit", () => cdp.rejectAll(new Error("chrome exited")));
  async function close(): Promise<void> {
    try {
      await Promise.race([cdp.send("Browser.close"), sleep(3000)]);
    } catch {}
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    if (proc.exitCode === null && proc.signalCode === null)
      proc.kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
  return { proc, cdp, userDataDir, stderr, close };
}

export class CdpPipe {
  writable: Writable;
  nextId = 1;
  pending = new Map<number, Pending>();
  listeners = new Set<(msg: CdpMessage) => void>();

  constructor(writable: Writable, readable: Readable) {
    this.writable = writable;
    let buf = Buffer.alloc(0);
    readable.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let i = buf.indexOf(0);
      while (i !== -1) {
        const msg: CdpMessage = JSON.parse(buf.subarray(0, i).toString("utf8"));
        buf = buf.subarray(i + 1);
        this.#dispatch(msg);
        i = buf.indexOf(0);
      }
    });
  }

  #dispatch(msg: CdpMessage): void {
    const pending = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (msg.id !== undefined && pending) {
      this.pending.delete(msg.id);
      if (msg.error)
        pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    const msg: CdpMessage = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writable.write(`${JSON.stringify(msg)}\0`);
    });
  }

  // Resolves with the first event matching method and predicate.
  waitFor(
    method: string,
    predicate: (params: Json, msg: CdpMessage) => boolean = () => true,
    timeoutMs = 30000,
  ): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const fn = (msg: CdpMessage) => {
        if (msg.method === method && predicate(msg.params, msg)) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          resolve(msg);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.listeners.add(fn);
    });
  }

  rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  onEvent(fn: (msg: CdpMessage) => void): void {
    this.listeners.add(fn);
  }
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

// Loads an unpacked extension and returns { extensionId, sessionId } attached to its service worker.
export async function loadExtensionAndAttachWorker(
  cdp: CdpPipe,
  extensionPath: string,
): Promise<{ extensionId: string; sessionId: string; workerUrl: string }> {
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  // Start waiting before loadUnpacked so a targetCreated event dispatched in the same chunk as a command
  // response is not missed. The extension id is only known after loadUnpacked, so early extension worker
  // events are recorded and matched against the id afterwards.
  const isExtensionWorker = (info: TargetInfo) =>
    info.type === "service_worker" &&
    info.url.startsWith("chrome-extension://");
  const earlyWorkers: TargetInfo[] = [];
  let extensionId: string | undefined;
  const isOwnWorker = (info: TargetInfo) =>
    isExtensionWorker(info) &&
    info.url.startsWith(`chrome-extension://${extensionId}/`);
  const workerCreated = cdp.waitFor(
    "Target.targetCreated",
    ({ targetInfo }: { targetInfo: TargetInfo }) => {
      if (!isExtensionWorker(targetInfo)) return false;
      if (extensionId === undefined) {
        earlyWorkers.push(targetInfo);
        return false;
      }
      return isOwnWorker(targetInfo);
    },
  );
  workerCreated.catch(() => {}); // unused when the worker is found via getTargets; its timeout must not be unhandled
  const loaded: { id: string } = await cdp.send("Extensions.loadUnpacked", {
    path: extensionPath,
  });
  extensionId = loaded.id;
  const { targetInfos }: { targetInfos: TargetInfo[] } =
    await cdp.send("Target.getTargets");
  const target: TargetInfo =
    targetInfos.find(isOwnWorker) ||
    earlyWorkers.find(isOwnWorker) ||
    (await workerCreated).params.targetInfo;
  const { sessionId }: { sessionId: string } = await cdp.send(
    "Target.attachToTarget",
    { targetId: target.targetId, flatten: true },
  );
  return { extensionId, sessionId, workerUrl: target.url };
}

// Evaluates an expression in a target session, awaiting promises and returning the value.
export async function evaluate(
  cdp: CdpPipe,
  sessionId: string,
  expression: string,
  timeoutMs = 300000,
): Promise<Json> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `evaluate timeout after ${timeoutMs}ms: ${expression.slice(0, 80)}`,
          ),
        ),
      timeoutMs,
    );
  });
  const r = await Promise.race([
    cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text);
  }
  return r.result.value;
}
