// Self-contained visual report. Screenshots are referenced relatively
// (frames/…), so the HTML stays small and works offline from the report folder.

import { writeFile } from 'node:fs/promises';

export async function writeHtml(file, result) {
  const data = {
    meta: result.meta,
    score: result.score,
    counts: result.counts,
    metrics: result.metrics,
    context: result.context,
    findings: result.findings,
    checkpoints: result.checkpoints,
    frames: result.frames,
    files: result.files,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  await writeFile(file, TEMPLATE.replace('__DATA__', json).replace('__TITLE__', escapeHtml(`ScrollProof · ${result.meta.url}`)));
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  --bg: #f6f6f3; --surface: #ffffff; --surface-2: #eeeee9; --text: #16161a; --muted: #62626b; --border: #dcdcd5;
  --error: #d6304a; --warn: #c27a00; --info: #3866d6; --ok: #1f9d63; --chart: #9a9aa3;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e11; --surface: #17171c; --surface-2: #202027; --text: #ececf1; --muted: #9a9aa6; --border: #2c2c35;
    --error: #ff5d73; --warn: #ffb02e; --info: #7aa2ff; --ok: #3fd18b; --chart: #5c5c68;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--sans); }
main { max-width: 1180px; margin: 0 auto; padding: 32px 16px 80px; }
header { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: center; margin-bottom: 28px; }
.brand { font: 600 13px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: 26px; line-height: 1.2; margin: 8px 0 6px; word-break: break-all; }
.sub { color: var(--muted); font-size: 13px; }
.score { width: 112px; height: 112px; position: relative; }
.score svg { transform: rotate(-90deg); }
.score svg { display: block; }
.score b { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 700 30px/1 var(--sans); }
.score b small { color: var(--muted); font: 500 11px/1 var(--sans); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 24px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.stat span { display: block; color: var(--muted); font-size: 12px; }
.stat b { font-size: 18px; }
section { margin-top: 32px; }
h2 { font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
#chart { width: 100%; height: 190px; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: var(--muted); margin-top: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.filters button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.finding { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 18px; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--sev); border-radius: 12px; padding: 14px; margin-bottom: 12px; scroll-margin-top: 16px; }
.finding:target { outline: 2px solid var(--sev); }
.sev-error { --sev: var(--error); } .sev-warning { --sev: var(--warn); } .sev-info { --sev: var(--info); }
.shot { position: relative; align-self: start; border-radius: 8px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); }
.shot img { display: block; width: 100%; height: auto; }
.shot .box { position: absolute; border: 2px solid var(--sev); box-shadow: 0 0 0 9999px rgba(0,0,0,.35); border-radius: 3px; }
.shot .y { position: absolute; left: 6px; top: 6px; font: 600 11px/1 var(--mono); background: rgba(0,0,0,.7); color: #fff; padding: 4px 6px; border-radius: 4px; }
.noshot { display: grid; place-items: center; min-height: 120px; color: var(--muted); font-size: 13px; }
.top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; }
.pill { font: 700 11px/1 var(--mono); letter-spacing: .06em; padding: 5px 7px; border-radius: 5px; color: #fff; background: var(--sev); }
.pos { font: 600 12px/1 var(--mono); }
code { font: 12px/1.4 var(--mono); background: var(--surface-2); padding: 2px 5px; border-radius: 4px; word-break: break-all; }
.finding h3 { margin: 8px 0 6px; font-size: 17px; }
.finding p { margin: 0 0 10px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 10px; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; }
.fix { font-size: 14px; background: var(--surface-2); border-radius: 8px; padding: 10px 12px; }
.fix b { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.strip a { position: relative; display: block; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); color: inherit; text-decoration: none; }
.strip img { display: block; width: 100%; }
.strip span { position: absolute; left: 4px; bottom: 4px; font: 600 10px/1 var(--mono); background: rgba(0,0,0,.7); color: #fff; padding: 3px 4px; border-radius: 3px; }
.strip a.hit { border: 2px solid var(--error); }
.empty { text-align: center; padding: 40px; color: var(--muted); }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media (max-width: 720px) {
  header { grid-template-columns: 1fr; }
  .finding { grid-template-columns: 1fr; }
  .noshot { display: none; }
  h1 { font-size: 21px; }
}
</style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="brand">ScrollProof report</div>
      <h1 id="url"></h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="score" id="score"></div>
  </header>
  <div class="stats" id="stats"></div>
  <section>
    <h2>Frame time by scroll position</h2>
    <div class="panel">
      <svg id="chart" preserveAspectRatio="none" role="img" aria-label="Frame duration for each frame, plotted against scroll position"></svg>
      <div class="legend"><span><i style="background:var(--chart)"></i>on budget</span><span><i style="background:var(--warn)"></i>dropped frame</span><span><i style="background:var(--error)"></i><span id="long-label">long frame</span></span><span>▲ finding position (click to jump)</span></div>
    </div>
  </section>
  <section>
    <h2>Findings</h2>
    <div class="filters" id="filters"></div>
    <div id="findings"></div>
  </section>
  <section>
    <h2>Every checkpoint</h2>
    <div class="strip" id="strip"></div>
  </section>
  <footer id="footer"></footer>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
(() => {
  const R = JSON.parse(document.getElementById('data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const m = R.meta, x = R.metrics || {}, c = R.context || {};

  $('url').textContent = m.url;
  $('sub').textContent = [m.date.slice(0, 16).replace('T', ' '), m.browser, m.viewport.width + '×' + m.viewport.height + (m.mobile ? ' mobile' : ''), 'CPU ' + m.cpuThrottle + '×', R.checkpoints.length + ' checkpoints'].join(' · ');

  const color = R.score >= 85 ? 'var(--ok)' : R.score >= 60 ? 'var(--warn)' : 'var(--error)';
  const C = 2 * Math.PI * 48;
  $('score').innerHTML = '<svg width="112" height="112"><circle cx="56" cy="56" r="48" fill="none" stroke="var(--border)" stroke-width="8"/><circle cx="56" cy="56" r="48" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + (C * R.score / 100) + ' ' + C + '"/></svg><b>' + R.score + '<small>score / 100</small></b>';

  const stats = [
    ['Errors', R.counts.error], ['Warnings', R.counts.warning],
    ['Smooth frames', x.smoothFramesPct != null ? x.smoothFramesPct + '%' : '—'],
    ['Worst frame', x.worstFrameMs != null ? x.worstFrameMs + 'ms @ y=' + x.worstFrameAtY : '—'],
    ['Layout shift', x.clsDuringScroll ?? '—'],
    ['GSAP', c.gsap ? c.gsap.version + ' · ' + c.gsap.scrollTriggers + ' triggers' : 'not detected'],
  ];
  $('stats').innerHTML = stats.map(([k, v]) => '<div class="stat"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');

  // Frame-time chart: x = scroll position, y = frame duration (capped at 120ms).
  const svg = $('chart');
  const W = 1000, H = 190, CAP = 120, maxY = Math.max(1, m.maxY);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  // Same thresholds as the analysis: dropped > 1.5× budget, long > 2× budget.
  const budget = x.frameBudgetMs || 16.7;
  const longMs = budget * 2;
  $('long-label').textContent = 'long frame (>' + Math.round(longMs) + 'ms)';
  const paths = { ok: '', drop: '', long: '' };
  const yOf = (ms) => H - 18 - (Math.min(ms, CAP) / CAP) * (H - 28);
  for (const [dt, y] of R.frames) {
    const k = dt > longMs ? 'long' : dt > budget * 1.5 ? 'drop' : 'ok';
    const px = ((y / maxY) * W).toFixed(1);
    paths[k] += 'M' + px + ' ' + (H - 18) + 'V' + yOf(dt).toFixed(1);
  }
  let g = '';
  for (const [ms, label] of [[budget, Math.round(budget) + 'ms'], [longMs, Math.round(longMs) + 'ms']]) g += '<line x1="0" x2="' + W + '" y1="' + yOf(ms) + '" y2="' + yOf(ms) + '" stroke="var(--border)" stroke-dasharray="4 4"/><text x="4" y="' + (yOf(ms) - 4) + '" font-size="11" fill="var(--muted)">' + label + '</text>';
  g += '<path d="' + paths.ok + '" stroke="var(--chart)" stroke-width="1.5"/><path d="' + paths.drop + '" stroke="var(--warn)" stroke-width="2"/><path d="' + paths.long + '" stroke="var(--error)" stroke-width="2.5"/>';
  for (const f of R.findings) {
    if (f.scrollY == null) continue;
    const col = 'var(--' + (f.severity === 'warning' ? 'warn' : f.severity) + ')';
    // Shade only ranges narrow enough to point somewhere; page-wide bands are noise.
    if (f.scrollRange && f.scrollRange[1] > f.scrollRange[0] && f.scrollRange[1] - f.scrollRange[0] < maxY * 0.3) {
      const a = (f.scrollRange[0] / maxY) * W, b = (f.scrollRange[1] / maxY) * W;
      g += '<rect x="' + a + '" y="0" width="' + Math.max(2, b - a) + '" height="' + (H - 18) + '" fill="' + col + '" opacity=".08"/>';
    }
    const px = Math.min(W - 6, Math.max(6, (f.scrollY / maxY) * W));
    g += '<a href="#f-' + f.n + '"><path d="M' + px + ' ' + (H - 12) + 'l6 10h-12z" fill="' + col + '"><title>' + esc(f.n + '. ' + f.title + ' (y=' + f.scrollY + ')') + '</title></path></a>';
  }
  g += '<text x="4" y="' + (H - 1) + '" font-size="11" fill="var(--muted)">y=0</text><text x="' + (W - 4) + '" y="' + (H - 1) + '" font-size="11" fill="var(--muted)" text-anchor="end">y=' + maxY + '</text>';
  svg.innerHTML = g;

  const LABEL = { error: 'ERROR', warning: 'WARN', info: 'INFO' };
  const where = (f) => f.scrollRange ? 'y=' + f.scrollRange[0] + '–' + f.scrollRange[1] : f.scrollY != null ? 'y=' + f.scrollY : 'whole page';
  const pct = (v, of) => Math.max(0, Math.min(100, (v / of) * 100)).toFixed(2) + '%';
  function card(f) {
    let shot = '<div class="shot noshot">no screenshot</div>';
    if (f.frame) {
      let box = '';
      if (f.box) {
        const b = f.box, l = Math.max(0, b.x), t = Math.max(0, b.y);
        box = '<div class="box" style="left:' + pct(l, b.vw) + ';top:' + pct(t, b.vh) + ';width:' + pct(Math.min(b.x + b.w, b.vw) - l, b.vw) + ';height:' + pct(Math.min(b.y + Math.max(b.h, 2), b.vh) - t, b.vh) + '"></div>';
      }
      shot = '<a class="shot" href="' + esc(f.frame) + '" target="_blank"><img src="' + esc(f.frame) + '" alt="Viewport at scroll position ' + esc(f.frameY) + '" loading="lazy">' + box + '<span class="y">y=' + esc(f.frameY) + '</span></a>';
    }
    const rows = [];
    if (f.element) rows.push(['Element', '<code>' + esc(f.element) + '</code>' + (f.label ? ' “' + esc(f.label) + '”' : '')]);
    if (f.source && f.source.display) rows.push(['Source', '<code>' + esc(f.source.display) + '</code>']);
    rows.push(['Check', '<code>' + esc(f.id) + '</code>']);
    return '<article class="finding sev-' + f.severity + '" id="f-' + f.n + '" data-sev="' + f.severity + '">' + shot +
      '<div><div class="top"><span class="pill">' + LABEL[f.severity] + '</span><span class="pos">' + where(f) + '</span><span>#' + f.n + '</span></div>' +
      '<h3>' + esc(f.title) + '</h3><p>' + esc(f.summary) + '</p><dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>' +
      (f.fix ? '<div class="fix"><b>Fix</b>' + esc(f.fix) + '</div>' : '') + '</div></article>';
  }
  $('findings').innerHTML = R.findings.length ? R.findings.map(card).join('') : '<div class="panel empty">No problems found. Every checked transition behaved.</div>';

  const sevs = [['all', 'All', R.findings.length], ['error', 'Errors', R.counts.error], ['warning', 'Warnings', R.counts.warning], ['info', 'Info', R.counts.info]];
  $('filters').innerHTML = sevs.map(([k, l, n]) => '<button data-k="' + k + '" aria-pressed="' + (k === 'all') + '">' + l + ' · ' + n + '</button>').join('');
  $('filters').addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (!k) return;
    for (const b of $('filters').children) b.setAttribute('aria-pressed', String(b.dataset.k === k));
    for (const a of document.querySelectorAll('.finding')) a.hidden = k !== 'all' && a.dataset.sev !== k;
  });

  const hit = new Set(R.findings.filter((f) => f.severity !== 'info').map((f) => f.frame));
  $('strip').innerHTML = R.checkpoints.filter((p) => p.frame).map((p) => '<a href="' + esc(p.frame) + '" target="_blank" class="' + (hit.has(p.frame) ? 'hit' : '') + '"><img src="' + esc(p.frame) + '" alt="Viewport at y=' + p.y + '" loading="lazy"><span>y=' + p.y + '</span></a>').join('') || '<div class="empty">Screenshots were disabled for this run.</div>';
  $('footer').innerHTML = 'Generated by ScrollProof 0.1.0' + (R.files.trace ? ' · open <code>' + R.files.trace + '</code> in Chrome DevTools › Performance › Load profile for the full trace' : '');
})();
</script>
</body>
</html>
`;
