import os from 'node:os';

type Koffi = typeof import('koffi');

let api: {
  GetWindowThreadProcessId: (hwnd: bigint | number, pid: number[]) => number;
  CreateToolhelp32Snapshot: (flags: number, pid: number) => unknown;
  Process32FirstW: (snap: unknown, entry: Record<string, unknown>) => boolean;
  Process32NextW: (snap: unknown, entry: Record<string, unknown>) => boolean;
  CloseHandle: (h: unknown) => boolean;
  entrySize: number;
} | null = null;

function load() {
  if (api || process.platform !== 'win32') return api;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi: Koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32',
    cntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  });
  api = {
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)'),
    CreateToolhelp32Snapshot: kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)'),
    Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(void *hSnapshot, _Inout_ PROCESSENTRY32W *lppe)'),
    Process32NextW: kernel32.func('bool __stdcall Process32NextW(void *hSnapshot, _Inout_ PROCESSENTRY32W *lppe)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)'),
    entrySize: koffi.sizeof(PROCESSENTRY32W),
  };
  return api;
}

export function windowsBuild(): number {
  if (process.platform !== 'win32') return 0;
  return Number(os.release().split('.')[2] ?? 0);
}

/** Chromium enables process loopback only from Windows 11 (build 22000). */
export function processLoopbackSupported(allowWin10: boolean): boolean {
  const b = windowsBuild();
  return b >= 22000 || (allowWin10 && b >= 19041);
}

export function hwndFromSourceId(id: string): bigint | null {
  const m = /^window:(\d+):/.exec(id);
  return m ? BigInt(m[1]) : null;
}

const TH32CS_SNAPPROCESS = 0x2;

function processes(w: NonNullable<typeof api>): Map<number, { parent: number; exe: string }> {
  const procs = new Map<number, { parent: number; exe: string }>();
  const snap = w.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap) return procs;
  try {
    const entry: Record<string, unknown> = { dwSize: w.entrySize };
    if (w.Process32FirstW(snap, entry)) {
      do {
        procs.set(entry.th32ProcessID as number, { parent: entry.th32ParentProcessID as number, exe: String(entry.szExeFile) });
        entry.dwSize = w.entrySize;
      } while (w.Process32NextW(snap, entry));
    }
  } finally {
    w.CloseHandle(snap);
  }
  return procs;
}

/** Climbs to the top ancestor with the same exe, so the loopback covers child processes. */
export function audioPidForWindow(hwnd: bigint): number | null {
  const w = load();
  if (!w) return null;
  const out = [0];
  w.GetWindowThreadProcessId(hwnd, out);
  const pid = out[0];
  if (!pid) return null;
  const procs = processes(w);
  let current = pid;
  for (let i = 0; i < 16; i++) {
    const me = procs.get(current);
    const parent = me && procs.get(me.parent);
    if (!me || !parent || parent.exe.toLowerCase() !== me.exe.toLowerCase() || me.parent === current) break;
    current = me.parent;
  }
  return current;
}

export function exeForPid(pid: number): string {
  const w = load();
  return w ? (processes(w).get(pid)?.exe ?? '') : '';
}
