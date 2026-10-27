// End-to-end: serve the demo pages, run the real CLI, check what it finds.
// Needs Chrome, Edge or Playwright's Chromium. Takes about a minute.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../demo/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'plugins', 'scrollproof', 'engine', 'cli.mjs');
let server;
let base;
let out;

before(async () => {
  server = createDemoServer();
  await new Promise((res) => server.listen(0, res));
  base = `http://localhost:${server.address().port}`;
  out = await mkdtemp(path.join(tmpdir(), 'scrollproof-test-'));
});

after(async () => {
  server.close();
  await rm(out, { recursive: true, force: true });
});

function audit(page, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, `${base}/${page}`, '--json', '--out', out, ...args], { maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err && err.code !== 1) return reject(new Error(stderr || err.message));
      resolve({ report: JSON.parse(stdout), exitCode: err ? err.code : 0 });
    });
  });
}

test('broken page: every planted bug is reported at the right place', { timeout: 240_000 }, async () => {
  const { report, exitCode } = await audit('broken.html', '--fail-on', 'error');
  const ids = new Set(report.findings.map((f) => f.id));
  const expected = [
    'flash-of-content',
    'from-conflict',
    'never-revealed',
    'layout-shift',
    'jank',
    'forced-reflow',
    'layout-property-animation',
    'pin-transformed-ancestor',
    'markers-left-on',
    'duplicate-trigger',
    'orphaned-trigger',
    'nested-scrolltrigger',
    'incomplete-scrub',
    'unreachable-trigger',
    'stale-trigger-positions',
    'non-passive-listener',
  ];
  for (const id of expected) assert.ok(ids.has(id), `missing ${id}; got ${[...ids].join(', ')}`);
  assert.equal(exitCode, 1, '--fail-on error should exit 1');

  const by = (id, el) => report.findings.find((f) => f.id === id && (!el || f.element?.includes(el)));
  assert.ok(by('never-revealed', 'reveal.tall'), 'tall IntersectionObserver reveal');
  assert.ok(by('never-revealed', 'quote'), 'quote hidden by duplicated from()');
  assert.equal(by('never-revealed', 'reveal.small'), undefined, 'small reveal works and must not be flagged');
  assert.match(by('forced-reflow').source.display, /broken\.html:\d+:\d+ \(thrashOnScroll\)/);
  assert.match(by('jank').source.display, /thrashOnScroll/);
  assert.ok(by('from-conflict').evidence.confirmedAtRuntime, 'conflict should be confirmed in the browser');
  assert.equal(by('pin-transformed-ancestor').evidence.ancestor.sel, 'div.tilt-wrap');

  const html = path.join(report.outDir, 'report.html');
  await access(html);
  await access(path.join(report.outDir, 'trace.json.gz'));
});

test('clean page: no errors or warnings', { timeout: 240_000 }, async () => {
  const { report } = await audit('clean.html', '--no-trace');
  const problems = report.findings.filter((f) => f.severity !== 'info');
  assert.deepEqual(
    problems.map((f) => `${f.id} ${f.element ?? ''} ${f.summary}`),
    [],
  );
  assert.equal(report.score, 100);
});
