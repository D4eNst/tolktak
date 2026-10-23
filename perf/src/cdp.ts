// Raw CDP, not Playwright: its loader and focus emulation keep a hidden window reporting visible.
import { spawn } from 'node:child_process';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Rpc {
  private seq = 0;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== undefined) {
        const p = this.pending.get(d.id);
        this.pending.delete(d.id);
        if (d.error) p?.fail(new Error(d.error.message));
        else p?.ok(d.result);
      } else for (const f of this.listeners.get(d.method) ?? []) f(d.params);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.fail(new Error('connection closed'));
      this.pending.clear();
    };
  }
  static async open(url: string) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    return new Rpc(ws);
  }
  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        fail(e as Error);
      }
    });
  }
  on(method: string, f: (p: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]);
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

async function json(url: string, ms = 30000): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error('timeout ' + url);
    await sleep(200);
  }
}

type Page = {
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  click(selector: string, text?: string): Promise<void>;
  waitFor(selector: string, ms?: number): Promise<void>;
};

export type ElectronClient = {
  pid: number;
  page: Page;
  /** Runs `fn(require('electron'), arg)` in the main process. */
  main<R, A = undefined>(fn: (electron: typeof import('electron'), arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  close(): Promise<void>;
};

/** Starts the client with a DevTools port (renderer) and a Node inspector (main process). */
export async function launchElectron(opts: { electron: string; app: string; args: string[]; env: Record<string, string>; port: number; initScript: string; onError?: (m: string) => void }): Promise<ElectronClient> {
  const proc = spawn(opts.electron, [`--inspect=127.0.0.1:${opts.port + 1}`, opts.app, `--remote-debugging-port=${opts.port}`, ...opts.args], {
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'ignore', process.env.PERF_VERBOSE ? 'inherit' : 'ignore'],
  });
  const [target] = await json(`http://127.0.0.1:${opts.port + 1}/json/list`);
  const main = await Rpc.open(target.webSocketDebuggerUrl);
  let pageUrl = '';
  for (const end = Date.now() + 30000; !pageUrl; await sleep(100)) {
    const list = (await json(`http://127.0.0.1:${opts.port}/json/list`)) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    pageUrl = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'))?.webSocketDebuggerUrl ?? '';
    if (Date.now() > end) throw new Error('no TolkTak window');
  }
  const page = await Rpc.open(pageUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  page.on('Runtime.exceptionThrown', (p) => opts.onError?.(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  // The init script applies from the next load, so reload once.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.initScript });
  const loaded = new Promise((r) => page.on('Page.loadEventFired', r));
  await page.send('Page.reload', {});
  await Promise.race([loaded, sleep(15000)]);
  const run = <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.eval<R>(`(async () => (${fn.toString()})(${JSON.stringify(arg ?? null)}))()`);
  const drv: Page = {
    evaluate: run as Page['evaluate'],
    async waitFor(selector, ms = 60_000) {
      const end = Date.now() + ms;
      while (!(await run((s: string) => !!document.querySelector(s), selector))) {
        if (Date.now() > end) throw new Error('timeout waiting for ' + selector);
        await sleep(100);
      }
    },
    async click(selector, text) {
      const end = Date.now() + 60_000;
      for (;;) {
        const ok = await run(
          ([s, t]: [string, string]) => {
            const el = [...document.querySelectorAll<HTMLElement>(s)].find((e) => !t || (e.textContent ?? '').includes(t));
            el?.click();
            return !!el;
          },
          [selector, text ?? ''] as [string, string],
        );
        if (ok) return;
        if (Date.now() > end) throw new Error(`no ${selector} with "${text ?? ''}"`);
        await sleep(100);
      }
    },
  };
  const client: ElectronClient = {
    pid: proc.pid!,
    page: drv,
    main: ((fn: Function, arg?: unknown) => main.eval(`(async () => (${fn.toString()})(require('electron'), ${JSON.stringify(arg ?? null)}))()`)) as ElectronClient['main'],
    async close() {
      page.close();
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        await client.main(({ app }) => void setTimeout(() => app.exit(0), 50)).catch(() => {});
        main.close();
        const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(t);
      }
    },
  };
  return client;
}
