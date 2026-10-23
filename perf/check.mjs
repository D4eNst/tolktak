#!/usr/bin/env node
// Usage: node perf/check.mjs perf/baseline/ci-linux.json <dir or files>...
// The lowest value of a label's runs counts: one noisy repeat cannot fail the job.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [baseFile, ...inputs] = process.argv.slice(2);
if (!baseFile || !inputs.length) {
  console.error('usage: check.mjs <baseline.json> <dir or run.json>...');
  process.exit(2);
}
const base = JSON.parse(readFileSync(baseFile, 'utf8'));
const runs = [];
for (const a of inputs) {
  const files = statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith('.json')).map((f) => path.join(a, f)) : [a];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j.schema === 'tolktak-perf/1') runs.push(j);
    } catch {
      /* not a run */
    }
  }
}
let failed = 0;
const lines = ['| label | metric | runs | best | limit | result |', '|---|---|---|---|---|---|'];
for (const c of base.checks) {
  const vals = runs.filter((r) => (r.label ?? r.scenario) === c.label).map((r) => r.metrics?.[c.metric]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const best = vals.length ? Math.min(...vals) : 'missing';
  const ok = vals.length ? best <= c.max : !!c.optional;
  if (!ok) failed++;
  lines.push(`| ${c.label} | ${c.metric} | ${vals.length} | ${best} | <= ${c.max} | ${ok ? 'ok' : 'FAIL'} |`);
}
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Perf regression check\n\n' + lines.join('\n') + '\n');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
