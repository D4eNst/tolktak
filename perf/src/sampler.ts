// Reads /proc from outside, so sampling does not wake the measured processes.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

type ProcInfo = {
  cpuSec: number; // cumulative user+system CPU seconds
  rssMB: number;
  pssMB?: number; // proportional set size
};
export type Snapshot = { t: number; procs: Map<number, ProcInfo>; tree(root: number): number[] };

const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString()) || 100;
const PAGE_SIZE = Number(execFileSync('getconf', ['PAGESIZE']).toString()) || 4096;

// comm may contain ')': the fields start after the last one.
const statFields = (stat: string) => stat.slice(stat.lastIndexOf(')') + 2).split(' ');

function readProc(pid: number): ProcInfo | null {
  try {
    const f = statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    const info: ProcInfo = { cpuSec: (Number(f[11]) + Number(f[12])) / CLK_TCK, rssMB: (Number(statm[1]) * PAGE_SIZE) / 1048576 };
    try {
      const pss = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (pss) info.pssMB = Number(pss[1]) / 1024;
    } catch {
      /* kernel without smaps_rollup */
    }
    return info;
  } catch {
    return null; // exited between readdir and read
  }
}

/** Only these trees: reading smaps of every process costs more than what is measured. */
export function makeSampler(roots: () => number[]) {
  return {
    snapshot(): Snapshot {
      const t = Date.now();
      const children = new Map<number, number[]>();
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const ppid = Number(statFields(readFileSync(`/proc/${d}/stat`, 'utf8'))[1]);
          (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(Number(d));
        } catch {
          /* gone */
        }
      }
      const descendants = (root: number) => {
        const out: number[] = [];
        const stack = [root];
        while (stack.length) {
          const pid = stack.pop()!;
          out.push(pid);
          stack.push(...(children.get(pid) ?? []));
        }
        return out;
      };
      const procs = new Map<number, ProcInfo>();
      for (const pid of roots().flatMap(descendants)) {
        const info = readProc(pid);
        if (info) procs.set(pid, info);
      }
      return { t, procs, tree: (root) => descendants(root).filter((pid) => procs.has(pid)) };
    },
  };
}
