// Orchestrates one audit: load → sweep (perf + trace) → checkpoint passes
// down and up (state + screenshots) → ScrollTrigger refresh check → analysis.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { summarizeTrace, TRACE_CATEGORIES } from './trace.mjs';
import { analyze } from './analyze.mjs';
import { resolveSources } from './sources.mjs';
import { writeMarkdown } from './report/markdown.mjs';
import { writeHtml } from './report/html.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_CHECKPOINTS = 150;

export async function runAudit(opts, log = () => {}) {
  const started = new Date();
  const outDir = path.resolve(opts.out, `${slug(opts.url)}-${stamp(started)}`);
  await mkdir(path.join(outDir, 'frames'), { recursive: true });
  const instrument = await readFile(path.join(here, 'instrument.js'), 'utf8');

  const { instance: browser, name: browserName, version } = await launchBrowser(opts);
  let result;
  try {
    const context = await browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: 1,
      isMobile: opts.mobile,
      hasTouch: opts.mobile,
      reducedMotion: 'no-preference',
    });
    await context.addInitScript({ content: instrument });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.length < 50 && pageErrors.push(String(e.message).split('\n')[0]));

    if (opts.cpu > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });
    }

    log(1, `Loading ${opts.url} in ${browserName} ${version}`);
    try {
      await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeout });
    } catch (e) {
      if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(e.message)) {
        const err = new Error(`Nothing is listening at ${opts.url}. Start the dev server and run the audit again.`);
        err.code = 'UNREACHABLE';
        throw err;
      }
      throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.waitForTimeout(opts.wait);

    const setup = await page.evaluate(() => {
      const sp = window.__scrollproof;
      sp.endSetup();
      const tracked = sp.collect();
      return { tracked, gsap: sp.gsapInfo() };
    });
    const g = setup.gsap;
    log(
      2,
      `Tracking ${setup.tracked.elements.length} animated elements` +
        (g.present ? `, GSAP ${g.version} with ${g.triggers?.length ?? 0} ScrollTriggers` : ', GSAP not detected'),
    );

    // Sweep: continuous wheel scrolling, like a user, while recording frames + trace.
    const vp = opts.viewport;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    const tracePath = path.join(outDir, 'trace.json');
    if (opts.trace) await browser.startTracing(page, { path: tracePath, categories: TRACE_CATEGORIES });
    await page.evaluate(() => window.__scrollproof.startRecording());
    log(3, 'Sweeping down with wheel input (frame timing + Chrome trace)');
    const sweep = await sweepDown(page, opts);
    await page.evaluate(() => window.__scrollproof.stopRecording());
    if (opts.trace) await browser.stopTracing();

    // Checkpoints: stop every `step` px, let animations settle, record element state.
    const maxY = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    const bottom = Math.max(0, Math.min(maxY, opts.maxScroll));
    const step = Math.max(opts.step || Math.round(vp.height * 0.5), Math.ceil(bottom / MAX_CHECKPOINTS));
    const ys = [];
    for (let y = 0; y < bottom; y += step) ys.push(y);
    ys.push(bottom);

    await scrollToY(page, 0);
    await page.evaluate((ms) => window.__scrollproof.settle(ms), opts.settle);
    log(4, `Checkpoint pass down: ${ys.length} stops, ${step}px apart`);
    const down = await checkpointPass(page, ys, { ...opts, outDir, screenshots: opts.screenshots, tag: 'down' });
    const gsapAtBottom = g.present ? await page.evaluate(() => window.__scrollproof.gsapInfo()) : null;
    log(5, 'Checkpoint pass up (determinism check)');
    const up = await checkpointPass(page, [...ys].reverse(), { ...opts, outDir, screenshots: false, tag: 'up' });

    const refresh = await page.evaluate(() => {
      const ST = window.ScrollTrigger;
      if (!ST || !ST.getAll) return null;
      const pos = () => ST.getAll().map((st) => [Math.round(st.start), Math.round(st.end)]);
      const before = pos();
      const layout = ST.getAll().map((st) => (st.trigger ? window.__scrollproof.layoutTop(st.trigger) : null));
      ST.refresh();
      return { before, after: pos(), layout };
    });
    const runtime = await page.evaluate(() => window.__scrollproof.drain());

    log(6, 'Analysing');
    let trace = null;
    if (opts.trace) {
      try {
        trace = summarizeTrace(JSON.parse(await readFile(tracePath, 'utf8')));
        await pipeline(createReadStream(tracePath), createGzip(), createWriteStream(tracePath + '.gz'));
        await rm(tracePath);
      } catch (e) {
        log(6, `Could not read the trace (${e.message}); continuing without it`);
      }
    }

    const data = {
      meta: {
        url: opts.url,
        date: started.toISOString(),
        browser: `${browserName} ${version}`,
        viewport: vp,
        mobile: opts.mobile,
        cpuThrottle: opts.cpu,
        step,
        maxY,
        scrollHeight: maxY + vp.height,
        durationMs: Date.now() - started.getTime(),
      },
      setup,
      sweep,
      down,
      up,
      gsapAtBottom,
      refresh,
      runtime,
      trace,
      pageErrors,
    };
    if (process.env.SCROLLPROOF_DEBUG) await writeFile(path.join(outDir, 'raw.json'), JSON.stringify(data));
    const analysis = analyze(data);
    await resolveSources(context, analysis.findings);
    result = buildResult(data, analysis, outDir, opts);
  } finally {
    await browser.close();
  }

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));
  await writeMarkdown(path.join(outDir, 'report.md'), result);
  await writeHtml(path.join(outDir, 'report.html'), result);
  await writeFile(path.join(path.resolve(opts.out), 'latest.txt'), outDir + '\n');
  return result;
}

async function sweepDown(page, { speed, maxScroll }) {
  const tickMs = 16;
  const delta = Math.max(20, Math.round((speed * tickMs) / 1000));
  const t0 = Date.now();
  let y = 0;
  let max = 0;
  let last = -1;
  let stuckTicks = 0;
  for (;;) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(tickMs);
    ({ y, max } = await page.evaluate(() => ({
      y: Math.round(scrollY),
      max: document.scrollingElement.scrollHeight - innerHeight,
    })));
    if (y >= Math.min(max, maxScroll) - 2) break;
    if (Math.abs(y - last) < 1) {
      if (++stuckTicks > 60) break;
    } else stuckTicks = 0;
    last = y;
    if (Date.now() - t0 > 180_000) break;
  }
  await page.evaluate(() => window.__scrollproof.settle(1500));
  const ms = Date.now() - t0;
  return { ms, endY: y, maxY: max, blocked: stuckTicks > 60, pxPerSec: ms ? Math.round((y / ms) * 1000) : 0 };
}

async function scrollToY(page, y) {
  await page.evaluate((top) => {
    const lenis = window.lenis || window.__lenis;
    const smoother = window.ScrollSmoother && window.ScrollSmoother.get && window.ScrollSmoother.get();
    if (lenis && lenis.scrollTo) lenis.scrollTo(top, { immediate: true, force: true });
    else if (smoother) smoother.scrollTo(top, false);
    else window.scrollTo({ top, left: 0, behavior: 'instant' });
  }, y);
}

async function checkpointPass(page, ys, { settle, outDir, screenshots, tag }) {
  const out = [];
  for (const target of ys) {
    await scrollToY(page, target);
    const s = await page.evaluate((ms) => window.__scrollproof.settle(ms), settle);
    const snap = await page.evaluate(() => window.__scrollproof.snapshot());
    let frame = null;
    if (screenshots) {
      frame = `frames/${tag}-${String(snap.y).padStart(6, '0')}.jpg`;
      await page.screenshot({ path: path.join(outDir, frame), type: 'jpeg', quality: 60 });
    }
    out.push({ ...snap, target, settleMs: s.ms, timedOut: s.timedOut, frame });
  }
  return out;
}

function buildResult(data, { findings, metrics, context }, outDir, opts) {
  const counts = { error: 0, warning: 0, info: 0 };
  findings.forEach((f) => counts[f.severity]++);
  return {
    tool: 'scrollproof',
    version: '0.1.0',
    outDir,
    meta: data.meta,
    score: score(findings),
    counts,
    metrics,
    context,
    findings,
    checkpoints: data.down.map((c) => ({ y: c.y, frame: c.frame, settleMs: c.settleMs, timedOut: c.timedOut })),
    frames: data.runtime.frames.map(([, dt, y]) => [dt, y]),
    tracked: data.setup.tracked.elements.map((e) => ({ sel: e.sel, label: e.label, reasons: e.reasons })),
    trace: data.trace,
    files: {
      report: 'report.md',
      html: 'report.html',
      json: 'report.json',
      trace: opts.trace ? 'trace.json.gz' : null,
      frames: opts.screenshots ? 'frames/' : null,
    },
  };
}

// Each kind of problem costs points once per occurrence, capped at three.
function score(findings) {
  const weight = { error: 12, warning: 4, info: 0 };
  const perId = new Map();
  for (const f of findings) {
    const k = f.id;
    const cur = perId.get(k) || { n: 0, w: weight[f.severity] };
    cur.n++;
    cur.w = Math.max(cur.w, weight[f.severity]);
    perId.set(k, cur);
  }
  let penalty = 0;
  perId.forEach(({ n, w }) => (penalty += w * Math.min(n, 3)));
  return Math.max(0, 100 - penalty);
}

const slug = (url) =>
  url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'site';

const stamp = (d) => d.toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
