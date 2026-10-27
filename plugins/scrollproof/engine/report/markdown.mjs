import { writeFile } from 'node:fs/promises';

const LABEL = { error: 'ERROR', warning: 'WARN', info: 'INFO' };

export function renderMarkdown(r) {
  const m = r.meta;
  const x = r.metrics || {};
  const lines = [];
  lines.push(`# ScrollProof report — ${m.url}`, '');
  lines.push(
    `${m.date.slice(0, 16).replace('T', ' ')} · ${m.browser} · ${m.viewport.width}×${m.viewport.height}${m.mobile ? ' (mobile)' : ''}` +
      ` · CPU ${m.cpuThrottle}× · page ${m.scrollHeight}px tall · ${r.checkpoints.length} checkpoints every ${m.step}px`,
    '',
  );
  lines.push(`**Score ${r.score}/100** — ${r.counts.error} errors · ${r.counts.warning} warnings · ${r.counts.info} info`, '');

  lines.push('| Metric | Value |', '|---|---|');
  if (x.frames) {
    lines.push(`| Smooth frames | ${x.smoothFramesPct}% of ${x.frames} |`);
    lines.push(`| Median / p95 frame | ${x.medianFrameMs}ms / ${x.p95FrameMs}ms |`);
    lines.push(`| Worst frame | ${x.worstFrameMs}ms at y=${x.worstFrameAtY} |`);
  }
  if (x.mainThreadBusyPct != null) lines.push(`| Main thread busy while scrolling | ${x.mainThreadBusyPct}% |`);
  if (x.clsDuringScroll != null) lines.push(`| Layout shift during scroll | ${x.clsDuringScroll} |`);
  const c = r.context || {};
  lines.push(`| GSAP | ${c.gsap ? `${c.gsap.version}, ${c.gsap.scrollTriggers} ScrollTriggers` : 'not detected'} |`);
  const smooth = Object.entries(c.smoothScroll || {}).filter(([, v]) => v).map(([k]) => k);
  lines.push(`| Smooth scroll | ${smooth.length ? smooth.join(', ') : 'native'} |`);
  lines.push(`| Tracked animated elements | ${c.trackedElements ?? 0} |`, '');

  lines.push('## Findings', '');
  if (!r.findings.length) lines.push('No problems found.', '');
  for (const f of r.findings) {
    const where = f.scrollRange ? `y=${f.scrollRange[0]}–${f.scrollRange[1]}` : f.scrollY != null ? `y=${f.scrollY}` : 'whole page';
    lines.push(`### ${f.n}. ${LABEL[f.severity]} · ${f.title} · ${where}`, '');
    lines.push(f.summary, '');
    if (f.element) lines.push(`- **Element:** \`${f.element}\`${f.label ? ` — "${f.label}"` : ''}`);
    if (f.source?.display) lines.push(`- **Source:** \`${f.source.display}\``);
    if (f.frame) lines.push(`- **Screenshot:** [${f.frame}](${f.frame})`);
    lines.push(`- **Check:** \`${f.id}\``);
    if (f.fix) lines.push(`- **Fix:** ${f.fix}`);
    lines.push('');
  }

  if (r.trace?.breakdownMs) {
    lines.push('## Main thread while scrolling', '', '| Activity | ms |', '|---|---|');
    for (const [k, v] of Object.entries(r.trace.breakdownMs)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
  }
  lines.push('## Files', '');
  lines.push('- `report.html` — visual report with screenshots and the frame-time chart');
  if (r.files.trace) lines.push('- `trace.json.gz` — open in Chrome DevTools › Performance › Load profile');
  if (r.files.frames) lines.push('- `frames/` — one screenshot per checkpoint');
  lines.push('- `report.json` — everything above, machine-readable', '');
  return lines.join('\n');
}

export async function writeMarkdown(file, result) {
  await writeFile(file, renderMarkdown(result));
}
