// Summarises a Chrome performance trace recorded during the scroll sweep.
// The in-page script drops `sp:y=<scrollY>` user-timing marks, which is how
// trace timestamps are mapped back to scroll positions.

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'blink.user_timing',
  'loading',
  'latencyInfo',
  'v8.execute',
];

const LIB_URL = /\/node_modules\/|\/\.vite\/deps\/|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|\/vendor\/|\/(gsap|ScrollTrigger|ScrollSmoother|lenis)(\.min)?\.m?js/i;
const RENDERING = {
  Layout: 'Layout',
  UpdateLayoutTree: 'Recalculate style',
  Paint: 'Paint',
  PrePaint: 'Pre-paint',
  Layerize: 'Layerize',
  HitTest: 'Hit testing',
};
// Script events nest (EventDispatch > FunctionCall), so only the outermost one is counted.
const SCRIPT = new Set(['FunctionCall', 'EventDispatch', 'FireAnimationFrame', 'TimerFire', 'EvaluateScript', 'RunMicrotasks']);

export function summarizeTrace(json) {
  const events = Array.isArray(json) ? json : json.traceEvents || [];
  const marks = events
    .filter((e) => typeof e.name === 'string' && e.name.startsWith('sp:y=') && String(e.cat).includes('user_timing'))
    .map((e) => ({ ts: e.ts, y: Number(e.name.slice(5)), pid: e.pid, tid: e.tid }))
    .sort((a, b) => a.ts - b.ts);
  if (!marks.length) return null;

  const { pid, tid } = marks[0];
  const t0 = marks[0].ts;
  const t1 = marks[marks.length - 1].ts;
  const yAt = (ts) => {
    let lo = 0;
    let hi = marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (marks[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return marks[lo].y;
  };

  const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ts >= t0 && e.ts <= t1).sort((a, b) => a.ts - b.ts);
  const totals = { Scripting: 0 };
  const forced = new Map();
  let busy = 0;
  let longTasks = 0;
  let scriptEnd = -1;
  const openB = [];

  const handle = (e, dur) => {
    if (e.name === 'RunTask') {
      busy += dur;
      if (dur > 50_000) longTasks++;
    }
    if (RENDERING[e.name]) totals[RENDERING[e.name]] = (totals[RENDERING[e.name]] || 0) + dur;
    if (SCRIPT.has(e.name) && e.ts >= scriptEnd) {
      totals.Scripting += dur;
      scriptEnd = e.ts + dur;
    }
    if (e.name === 'Layout' || e.name === 'UpdateLayoutTree') {
      const stack = e.args?.beginData?.stackTrace || e.args?.data?.stackTrace;
      if (!stack?.length) return;
      // Our own instrumentation sometimes flushes style; never blame the site for that.
      if (stack.some((f) => String(f.url).includes('scrollproof-instrument'))) return;
      const frame = stack.find((f) => f.url && !LIB_URL.test(f.url)) || stack[0];
      const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
      const entry = forced.get(key) || {
        url: frame.url,
        line: frame.lineNumber,
        col: frame.columnNumber,
        fn: frame.functionName || null,
        kinds: new Set(),
        count: 0,
        ms: 0,
        hits: [],
      };
      entry.kinds.add(e.name === 'Layout' ? 'layout' : 'style');
      entry.count++;
      entry.ms += dur / 1000;
      entry.hits.push([yAt(e.ts), dur / 1000]);
      forced.set(key, entry);
    }
  };

  for (const e of main) {
    if (e.ph === 'X') handle(e, e.dur || 0);
    else if (e.ph === 'B') openB.push(e);
    else if (e.ph === 'E') {
      for (let i = openB.length - 1; i >= 0; i--) {
        if (openB[i].name === e.name) {
          const [b] = openB.splice(i, 1);
          handle({ ...b, args: { ...b.args, ...e.args } }, e.ts - b.ts);
          break;
        }
      }
    }
  }

  const wallMs = (t1 - t0) / 1000;
  return {
    wallMs: Math.round(wallMs),
    mainThreadBusyPct: wallMs ? Math.round((busy / 1000 / wallMs) * 100) : null,
    longTasks,
    breakdownMs: Object.fromEntries(
      Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, Math.round(v / 1000)]),
    ),
    forcedReflows: [...forced.values()]
      .map(({ hits, kinds, ...f }) => ({
        ...f,
        kind: kinds.has('layout') ? 'layout' : 'style',
        ms: Math.round(f.ms * 10) / 10,
        ...costlyRange(hits),
      }))
      .sort((a, b) => b.ms - a.ms),
  };
}

// Scroll range that holds the expensive hits; cheap no-op flushes elsewhere don't widen it.
function costlyRange(hits) {
  const max = Math.max(...hits.map((h) => h[1]));
  const costly = hits.filter((h) => h[1] >= max * 0.25);
  const ys = (costly.length ? costly : hits).map((h) => h[0]);
  return { yMin: Math.min(...ys), yMax: Math.max(...ys) };
}
