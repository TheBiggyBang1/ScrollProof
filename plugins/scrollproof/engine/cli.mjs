#!/usr/bin/env node
// scrollproof <url> [options] — see --help.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { runAudit } from './audit.mjs';
import { launchBrowser, loadPlaywright } from './browser.mjs';

const HELP = `ScrollProof — objective scroll-animation testing

Usage: scrollproof [url] [options]
  url                 e.g. localhost:3000, :5173, https://staging.example.com
                      (omitted: probes common dev-server ports)

Options:
  --mobile            390×844 touch viewport
  --viewport WxH      viewport size (default 1440x900)
  --step PX           distance between checkpoints (default: half the viewport)
  --settle MS         max wait for animations at each checkpoint (default 2000)
  --speed PX/S        wheel speed during the performance sweep (default 2000)
  --cpu N             CPU slowdown, e.g. 4 for a mid-range phone (default 1)
  --wait MS           extra wait after load for preloaders/intros (default 1500)
  --browser NAME      auto | chrome | msedge | chromium (default auto)
  --headed            show the browser window
  --no-trace          skip the Chrome performance trace
  --no-screenshots    skip checkpoint screenshots
  --max-scroll PX     stop after this many px on infinite pages (default 40000)
  --out DIR           output folder (default ./.scrollproof)
  --fail-on LEVEL     exit 1 on: error | warning | never (default never)
  --json              print report.json to stdout instead of the summary
  --check             only verify that Playwright and a browser are available
`;

const DEV_PORTS = [3000, 5173, 4321, 8080, 8000, 4173, 3001, 1234, 5000];

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mobile: { type: 'boolean', default: false },
      viewport: { type: 'string' },
      step: { type: 'string' },
      settle: { type: 'string', default: '2000' },
      speed: { type: 'string', default: '2000' },
      cpu: { type: 'string', default: '1' },
      wait: { type: 'string', default: '1500' },
      browser: { type: 'string', default: 'auto' },
      headed: { type: 'boolean', default: false },
      'no-trace': { type: 'boolean', default: false },
      'no-screenshots': { type: 'boolean', default: false },
      'max-scroll': { type: 'string', default: '40000' },
      out: { type: 'string', default: '.scrollproof' },
      'fail-on': { type: 'string', default: 'never' },
      timeout: { type: 'string', default: '60000' },
      json: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) return void process.stdout.write(HELP);

  if (v.check) {
    await loadPlaywright();
    const { instance, name, version } = await launchBrowser({ browser: v.browser });
    await instance.close();
    console.log(`ok: ${name} ${version}`);
    return;
  }

  const url = positionals[0] ? normalizeUrl(positionals[0]) : await detectDevServer();
  const viewport = v.mobile ? { width: 390, height: 844 } : parseViewport(v.viewport || '1440x900');
  const opts = {
    url,
    viewport,
    mobile: v.mobile,
    step: v.step ? int(v.step, 'step') : null,
    settle: int(v.settle, 'settle'),
    speed: int(v.speed, 'speed'),
    cpu: Number(v.cpu) || 1,
    wait: int(v.wait, 'wait'),
    browser: v.browser,
    headed: v.headed,
    trace: !v['no-trace'],
    screenshots: !v['no-screenshots'],
    maxScroll: int(v['max-scroll'], 'max-scroll'),
    out: v.out,
    timeout: int(v.timeout, 'timeout'),
  };

  const log = v.json ? () => {} : (n, msg) => process.stderr.write(`[${n}/6] ${msg}\n`);
  const result = await runAudit(opts, log);

  if (v.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printSummary(result);

  const failOn = v['fail-on'];
  if ((failOn === 'error' && result.counts.error) || (failOn === 'warning' && (result.counts.error || result.counts.warning)))
    process.exitCode = 1;
}

function printSummary(r) {
  const x = r.metrics || {};
  const out = [];
  out.push('');
  out.push(`ScrollProof ${r.score}/100 — ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} info`);
  if (x.frames) out.push(`Frames: ${x.smoothFramesPct}% smooth, p95 ${x.p95FrameMs}ms, worst ${x.worstFrameMs}ms at y=${x.worstFrameAtY}; layout shift ${x.clsDuringScroll}`);
  out.push('');
  const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' };
  for (const f of r.findings.slice(0, 25)) {
    const y = f.scrollRange ? `y=${f.scrollRange[0]}-${f.scrollRange[1]}` : f.scrollY != null ? `y=${f.scrollY}` : 'page';
    out.push(`${tag[f.severity]} ${y.padEnd(13)} ${f.id.padEnd(26)} ${f.element ? truncate(f.element, 50) : ''}`);
    out.push(`       ${f.summary}`);
    if (f.source?.display) out.push(`       at ${f.source.display}`);
  }
  if (r.findings.length > 25) out.push(`… ${r.findings.length - 25} more in the report`);
  out.push('');
  out.push(`Report: ${path.join(r.outDir, 'report.md')}`);
  out.push(`Visual: ${path.join(r.outDir, 'report.html')}`);
  if (r.files.trace) out.push(`Trace:  ${path.join(r.outDir, r.files.trace)}`);
  console.log(out.join('\n'));
}

function normalizeUrl(raw) {
  let s = raw.trim();
  if (/^\d+$/.test(s)) s = `localhost:${s}`;
  if (s.startsWith(':')) s = `localhost${s}`;
  if (!/^[a-z]+:\/\//i.test(s)) {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[^/]+\.localhost|[^/]+\.test)(:|\/|$)/i.test(s);
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  return new URL(s).href;
}

async function detectDevServer() {
  const probes = DEV_PORTS.map(async (port) => {
    const url = `http://localhost:${port}/`;
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!/html/.test(res.headers.get('content-type') || '')) throw new Error('not html');
    return url;
  });
  try {
    return await Promise.any(probes);
  } catch {
    const err = new Error(`No URL given and no dev server answered on ports ${DEV_PORTS.join(', ')}. Pass the URL, e.g. scrollproof localhost:3000`);
    err.code = 'UNREACHABLE';
    throw err;
  }
}

function parseViewport(s) {
  const m = /^(\d+)x(\d+)$/i.exec(s);
  if (!m) throw new Error(`--viewport must look like 1440x900, got "${s}"`);
  return { width: +m[1], height: +m[2] };
}

function int(s, name) {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got "${s}"`);
  return n;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

main().catch((e) => {
  console.error(`scrollproof: ${e.message}`);
  process.exitCode = e.code === 'UNREACHABLE' ? 3 : e.code === 'NO_PLAYWRIGHT' || e.code === 'NO_BROWSER' ? 4 : 2;
});
