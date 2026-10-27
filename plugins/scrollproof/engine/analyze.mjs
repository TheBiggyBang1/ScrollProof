// Turns raw audit data into findings. Every finding carries the scroll position
// where it happens, the element and (when known) the line of site code behind it.

const LAYOUT_PROP =
  /^(width|height|top|left|right|bottom|inset.*|margin.*|padding.*|border.*width|fontsize|lineheight|maxwidth|maxheight|minwidth|minheight|flex.*|gap|rowgap|columngap|gridtemplate.*)$/;
const TRANSFORM_PROPS = new Set(['x', 'y', 'xPercent', 'yPercent', 'rotation', 'rotate', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'transform', 'top', 'left']);
const STRONG_REASONS = ['gsap', 'gsap-scrub', 'reveal-attr', 'css-scroll-timeline', 'initially-clipped'];
const isLayoutProp = (p) => LAYOUT_PROP.test(String(p).replace(/-/g, '').toLowerCase());

export function analyze(data) {
  const { meta, setup, sweep, down, up, refresh, runtime, trace, pageErrors } = data;
  const elements = setup.tracked.elements;
  const findings = [];
  const add = (f) =>
    findings.push({
      severity: 'warning',
      scrollY: null,
      scrollRange: null,
      element: null,
      label: null,
      source: null,
      evidence: {},
      frame: null,
      box: null,
      ...f,
    });

  const stateOf = (cp, idx) => cp.states.find((s) => s[0] === idx);
  const nearest = (y) => down.reduce((best, c) => (!best || Math.abs(c.y - y) < Math.abs(best.y - y) ? c : best), null);
  // Prefer a checkpoint where the element is actually on screen, so the screenshot shows it.
  const attach = (f, idx, y) => {
    let cp = null;
    if (idx != null) {
      const visible = down.filter((c) => {
        const s = stateOf(c, idx);
        return s && inView(s, c);
      });
      cp = visible.reduce((b, c) => (!b || Math.abs(c.y - y) < Math.abs(b.y - y) ? c : b), null);
    }
    cp = cp || (y != null ? nearest(y) : null);
    if (!cp) return f;
    f.frame = cp.frame;
    f.frameY = cp.y;
    const s = idx != null ? stateOf(cp, idx) : null;
    if (s) f.box = { x: s[5], y: s[4], w: s[6], h: s[7], vw: cp.vw, vh: cp.vh };
    return f;
  };

  // ---------- scroll basics ----------

  if (meta.maxY <= 0) {
    add({ id: 'not-scrollable', severity: 'info', title: 'Page does not scroll', summary: 'The document is not taller than the viewport, so there is nothing to scroll-test.' });
  } else if (sweep.blocked) {
    attach(
      add2({
        id: 'scroll-locked',
        severity: 'error',
        title: 'Scrolling gets stuck',
        scrollY: sweep.endY,
        summary: `Wheel scrolling stopped at y=${sweep.endY} although the page is scrollable to y=${sweep.maxY}.`,
        evidence: { overflow: setup.tracked.overflow },
        fix:
          'Something blocks wheel scrolling: `overflow: hidden` left on <html>/<body> after a preloader or menu, a wheel listener calling preventDefault(), or a smooth-scroll library that was stopped (lenis.stop()) and never restarted.',
      }),
      null,
      sweep.endY,
    );
  }
  function add2(f) {
    add(f);
    return findings[findings.length - 1];
  }

  // ---------- elements that never become visible ----------

  const conflictEls = new Set();
  const dupEls = new Set();
  const unreachableEls = new Set();
  const gsapFindings = analyzeGsap();

  const vis = new Map();
  for (const cp of [...down, ...up]) {
    for (const s of cp.states) {
      const [i, opacity, hiddenVis, hiddenBy] = s;
      const m = elements[i];
      if (!eligible(m) || !inView(s, cp)) continue;
      const rec = vis.get(i) || { inView: 0, visible: false, first: null, why: null };
      rec.inView++;
      const why = opacity < 0.05 ? `opacity: ${opacity}` : hiddenVis ? 'visibility: hidden' : hiddenBy ? HIDDEN_BY[hiddenBy] : null;
      if (!why) rec.visible = true;
      else {
        rec.why = rec.why || why;
        if (cp.frame !== undefined && (!rec.first || cp.y < rec.first.y) && down.includes(cp)) rec.first = cp;
      }
      vis.set(i, rec);
    }
  }
  for (const [i, rec] of vis) {
    if (rec.visible || !rec.first) continue;
    const m = elements[i];
    const strong = m.reasons.some((r) => STRONG_REASONS.includes(r));
    const s = stateOf(rec.first, i);
    const tall = s && s[7] > rec.first.vh * 0.9;
    const cause = conflictEls.has(m.sel)
      ? 'from-conflict'
      : dupEls.has(m.sel)
        ? 'duplicate-trigger'
        : unreachableEls.has(m.sel)
          ? 'unreachable-trigger'
          : null;
    let fix =
      'The reveal never ran. Check that its trigger fires at this scroll position (start/end, threshold), and that no JS error stopped the setup code.';
    if (tall)
      fix = `The element is ${s[7]}px tall but the viewport is ${rec.first.vh}px: an IntersectionObserver threshold near 1.0 (or a ScrollTrigger start that needs the whole element in view) can never be met. Use threshold ≤ 0.2 or a rootMargin, or a start like "top 80%".`;
    if (m.reasons.includes('gsap') || m.reasons.includes('gsap-scrub'))
      fix += ' For GSAP: check toggleActions and start/end, and look for from() tweens that record an already-hidden state.';
    if (cause) fix = `Likely caused by the ${cause} finding on the same element. ` + fix;
    attach(
      add2({
        id: 'never-revealed',
        severity: strong ? 'error' : 'warning',
        title: 'Element never becomes visible',
        element: m.sel,
        label: m.label,
        scrollY: rec.first.y,
        summary: `Stays hidden (${rec.why}) at all ${rec.inView} checkpoints where it is on screen, first fully in view at y=${rec.first.y}.`,
        evidence: { hiddenBy: rec.why, checkpointsInView: rec.inView, trackedBecause: m.reasons, heightPx: s ? s[7] : null, likelyCause: cause },
        fix,
      }),
      i,
      rec.first.y,
    );
  }

  // from() conflicts usually show up as "visible, then gone while still on screen".
  for (const [selector, f] of gsapFindings.fromConflictBySel) {
    const i = elements.findIndex((m) => m.sel === selector);
    let visibleAt = null;
    for (const cp of down) {
      const s = stateOf(cp, i);
      if (!s || !inView(s, cp)) continue;
      if (s[1] >= 0.5 && visibleAt == null) visibleAt = cp.y;
      else if (s[1] < 0.05 && visibleAt != null) {
        f.evidence.confirmedAtRuntime = { visibleAt, hiddenAt: cp.y };
        f.summary += ` Seen in the browser: visible at y=${visibleAt}, gone at y=${cp.y} while still on screen.`;
        attach(f, i, cp.y);
        break;
      }
    }
  }

  // ---------- scrub determinism: same scroll position must give the same frame ----------

  const scrubOnly = new Set(
    elements
      .map((m, i) => [m, i])
      .filter(([m]) => (m.reasons.includes('gsap-scrub') || m.reasons.includes('css-scroll-timeline')) && !m.reasons.includes('gsap'))
      .map(([, i]) => i),
  );
  const downAt = new Map(down.map((c) => [c.y, c]));
  const mismatch = new Map();
  for (const u of up) {
    const d = downAt.get(u.y);
    if (!d || d.timedOut || u.timedOut || Math.abs(d.docH - u.docH) > 2) continue;
    for (const su of u.states) {
      if (!scrubOnly.has(su[0])) continue;
      const sd = stateOf(d, su[0]);
      if (!sd) continue;
      const dOpacity = Math.abs(su[1] - sd[1]);
      const dPos = Math.max(Math.abs(su[4] - sd[4]), Math.abs(su[5] - sd[5]), Math.abs(su[6] - sd[6]), Math.abs(su[7] - sd[7]));
      if (dOpacity <= 0.1 && dPos <= 4) continue;
      const prev = mismatch.get(su[0]);
      const severity = dOpacity * 100 + dPos;
      if (!prev || severity > prev.severity)
        mismatch.set(su[0], { y: u.y, severity, down: { opacity: sd[1], top: sd[4], left: sd[5] }, up: { opacity: su[1], top: su[4], left: su[5] }, count: (prev?.count || 0) + 1 });
      else prev.count++;
    }
  }
  for (const [i, mm] of mismatch) {
    const m = elements[i];
    const confirmed = gsapFindings.fromConflictBySel.get(m.sel);
    if (confirmed) {
      confirmed.evidence.confirmedAtRuntime = { y: mm.y, scrollingDown: mm.down, scrollingUp: mm.up };
      continue;
    }
    attach(
      add2({
        id: 'nondeterministic-scrub',
        severity: 'error',
        title: 'Scrubbed animation shows different frames for the same scroll position',
        element: m.sel,
        label: m.label,
        scrollY: mm.y,
        summary: `At y=${mm.y} the element is at opacity ${mm.down.opacity}, top ${mm.down.top}px when scrolling down but opacity ${mm.up.opacity}, top ${mm.up.top}px when scrolling back up (${mm.count} checkpoints differ).`,
        evidence: { scrollingDown: mm.down, scrollingUp: mm.up, checkpointsDiffering: mm.count },
        fix: 'A scrubbed animation should be a pure function of scroll position. Usually two tweens fight over the same property (overlapping ranges, or from() tweens with immediateRender), or a toggle-based tween also touches this element. Give each property one owner, use fromTo(), or set immediateRender: false.',
      }),
      i,
      mm.y,
    );
  }

  // ---------- frame timing (jank) ----------

  const metrics = {};
  const frames = runtime.frames;
  if (frames.length > 10) {
    const dts = frames.map((f) => f[1]).sort((a, b) => a - b);
    const q = (p) => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
    // Headless Chrome may produce frames faster than a 60 Hz display, so the
    // budget never drops below 16.7 ms; a "long" frame drops at least one more.
    const budget = Math.min(34, Math.max(16.7, q(0.5)));
    const longLimit = budget * 2;
    const worst = frames.reduce((a, f) => (f[1] > a[1] ? f : a), frames[0]);
    const dropped = frames.filter((f) => f[1] > budget * 1.5).length;
    Object.assign(metrics, {
      frames: frames.length,
      frameBudgetMs: round(budget),
      medianFrameMs: round(q(0.5)),
      p95FrameMs: round(q(0.95)),
      worstFrameMs: round(worst[1]),
      worstFrameAtY: worst[2],
      smoothFramesPct: round(100 * (1 - dropped / frames.length)),
      longFrames: frames.filter((f) => f[1] > longLimit).length,
      sweepPxPerSec: sweep.pxPerSec,
    });

    const long = frames.filter((f) => f[1] > longLimit).sort((a, b) => a[2] - b[2]);
    const ranges = [];
    for (const f of long) {
      const r = ranges[ranges.length - 1];
      if (r && f[2] - r.yMax <= 400) {
        r.frames.push(f);
        r.yMax = f[2];
      } else ranges.push({ yMin: f[2], yMax: f[2], frames: [f] });
    }
    for (const r of ranges) {
      const worstMs = Math.max(...r.frames.map((f) => f[1]));
      const scripts = new Map();
      for (const f of r.frames) {
        const tEnd = f[0];
        const tStart = f[0] - f[1];
        for (const l of runtime.loaf) {
          if (l.t < tStart - 20 || l.t > tEnd + 5) continue;
          for (const s of l.scripts) {
            if (String(s.url).includes('scrollproof-instrument')) continue;
            const key = `${s.invoker}|${s.url}|${s.fn}|${s.char}`;
            const e = scripts.get(key) || { invoker: s.invoker, url: s.url, fn: s.fn, char: s.char, ms: 0, forcedMs: 0, count: 0 };
            e.ms += s.dur;
            e.forcedMs += s.forced;
            e.count++;
            scripts.set(key, e);
          }
        }
      }
      const top = [...scripts.values()].sort((a, b) => b.ms - a.ms).slice(0, 3).map((e) => ({ ...e, ms: round(e.ms), forcedMs: round(e.forcedMs) }));
      const culprit = top[0];
      const severe = r.frames.length >= 5 || worstMs >= 100;
      attach(
        add2({
          id: 'jank',
          severity: severe ? 'error' : 'warning',
          title: 'Dropped frames while scrolling',
          scrollY: r.yMin,
          scrollRange: [r.yMin, r.yMax],
          summary:
            `${r.frames.length} frame${r.frames.length > 1 ? 's' : ''} over ${round(longLimit)}ms (worst ${round(worstMs)}ms) between y=${r.yMin} and y=${r.yMax}.` +
            (culprit ? ` Main thread busy in ${culprit.fn || culprit.invoker || 'script'} (${culprit.ms}ms${culprit.forcedMs ? `, ${culprit.forcedMs}ms forced layout` : ''}).` : ''),
          source: culprit && culprit.url ? { url: culprit.url, fn: culprit.fn, char: culprit.char } : null,
          evidence: { frames: r.frames.length, worstMs: round(worstMs), scripts: top },
          fix: 'Keep scroll and rAF handlers under a few ms: no layout reads after style writes (batch reads, then writes), no heavy work per scroll event (throttle with rAF), animate transform/opacity only. Open trace.json.gz in Chrome DevTools > Performance to see the exact call tree.',
        }),
        null,
        Math.round((r.yMin + r.yMax) / 2),
      );
    }
  }

  // ---------- Chrome trace ----------

  if (trace) {
    metrics.mainThreadBusyPct = trace.mainThreadBusyPct;
    metrics.mainThreadBreakdownMs = trace.breakdownMs;
    for (const f of trace.forcedReflows) {
      if (f.count < 3 || f.ms < 5) continue;
      attach(
        add2({
          id: 'forced-reflow',
          severity: f.ms >= 50 ? 'error' : 'warning',
          title: `Forced synchronous ${f.kind === 'layout' ? 'layout' : 'style recalculation'} during scroll`,
          scrollY: f.yMin,
          scrollRange: f.yMax > f.yMin ? [f.yMin, f.yMax] : null,
          source: { url: f.url, line: f.line, col: f.col, fn: f.fn },
          summary: `${f.fn || 'Anonymous function'} forced ${f.kind} ${f.count}× (${f.ms}ms total) ${f.yMax > f.yMin ? `between y=${f.yMin} and y=${f.yMax}` : `at y=${f.yMin}`}.`,
          evidence: { count: f.count, totalMs: f.ms, kind: f.kind },
          fix: 'This code reads layout (offsetTop, getBoundingClientRect, scrollHeight…) after styles were changed in the same frame, so the browser must lay out synchronously. Read all measurements first (or cache them on resize), then write styles, ideally inside one requestAnimationFrame.',
        }),
        null,
        f.yMin,
      );
    }
  }

  // ---------- layout shifts during scroll ----------

  // Only shifts during the wheel sweep count: instant checkpoint jumps make
  // pins flip between fixed and static for a frame, which users never see.
  const tScrollStart = frames.length ? frames[0][0] - frames[0][1] : Infinity;
  const tScrollEnd = frames.length ? frames[frames.length - 1][0] + 1000 : -Infinity;
  const pins = new Set((setup.gsap.triggers || []).map((t) => t.pin).filter(Boolean));
  const yAtTime = (t) => {
    const tl = runtime.yTimeline;
    let y = 0;
    for (const [tt, yy] of tl) {
      if (tt > t) break;
      y = yy;
    }
    return y;
  };
  const shiftGroups = new Map();
  let cls = 0;
  for (const s of runtime.shifts) {
    if (s.t < tScrollStart || s.t > tScrollEnd) continue;
    const node = s.sources[0]?.node || 'unknown element';
    if (pins.has(node)) continue;
    cls += s.value;
    const g = shiftGroups.get(node) || { node, value: 0, count: 0, ys: [], sample: s.sources[0] };
    g.value += s.value;
    g.count++;
    g.ys.push(yAtTime(s.t));
    shiftGroups.set(node, g);
  }
  metrics.clsDuringScroll = round(cls, 3);
  for (const g of [...shiftGroups.values()].sort((a, b) => b.value - a.value).slice(0, 5)) {
    // Per-element threshold is far below the CLS "good" limit: any visible jump mid-scroll is noticeable.
    if (g.value < 0.005) continue;
    const yMin = Math.min(...g.ys);
    const yMax = Math.max(...g.ys);
    const [px, py] = g.sample?.prev || [];
    const [cx, cy, cw, ch] = g.sample?.cur || [];
    const movement = !cw && !ch ? ', pushed out of the viewport' : py != null ? `, moving ${Math.abs(cy - py) || Math.abs(cx - px)}px` : '';
    attach(
      add2({
        id: 'layout-shift',
        severity: g.value >= 0.05 ? 'error' : 'warning',
        title: 'Content jumps while scrolling',
        element: g.node,
        scrollY: yMin,
        scrollRange: yMax > yMin ? [yMin, yMax] : null,
        summary: `${g.node} shifted ${g.count}× (score ${round(g.value, 3)}) at y=${yMin}${movement}.`,
        evidence: { score: round(g.value, 3), count: g.count, previousRect: g.sample?.prev, currentRect: g.sample?.cur },
        fix: 'Something above this element changed height after load: images/videos without width+height (or aspect-ratio), late web fonts, or injected content. Reserve the space. If GSAP ScrollTrigger is used, positions computed before the shift are now wrong too — call ScrollTrigger.refresh() after the content settles.',
      }),
      null,
      yMin,
    );
  }

  // ---------- layout-property animations (CSS seen running) ----------

  const layoutAnims = new Map(gsapFindings.layoutProps);
  for (const c of runtime.cssRunning) {
    const props = c.props.filter(isLayoutProp);
    if (!props.length) continue;
    const e = layoutAnims.get(c.sel) || { props: new Set(), y: c.y, source: null, via: 'CSS' };
    props.forEach((p) => e.props.add(p));
    layoutAnims.set(c.sel, e);
  }
  for (const [selector, e] of layoutAnims) {
    const idx = elements.findIndex((m) => m.sel === selector);
    attach(
      add2({
        id: 'layout-property-animation',
        severity: 'warning',
        title: 'Animating layout properties',
        element: selector,
        scrollY: e.y,
        source: e.source,
        summary: `${e.via} animates ${[...e.props].join(', ')} — every frame triggers layout and paint instead of running on the compositor.`,
        evidence: { properties: [...e.props], via: e.via },
        fix: 'Animate transform and opacity instead: x/y (or translate) instead of top/left/margin, scaleX/scaleY (with transform-origin) instead of width/height, clip-path for reveals.',
      }),
      idx >= 0 ? idx : null,
      e.y,
    );
  }

  // ---------- listeners that block scrolling ----------

  const smooth = setup.tracked.smoothScroll;
  const usesSmoothLib = smooth.lenis || smooth.locomotive || smooth.scrollSmoother;
  const blocking = new Map();
  for (const l of runtime.listeners) {
    if (l.type === 'scroll' || l.effectivePassive) continue;
    const key = `${l.type}|${l.target}|${l.site?.url}:${l.site?.line}`;
    if (!blocking.has(key)) blocking.set(key, l);
  }
  for (const l of blocking.values()) {
    add({
      id: 'non-passive-listener',
      severity: usesSmoothLib ? 'info' : 'warning',
      title: `Non-passive ${l.type} listener`,
      element: l.target,
      source: l.site,
      summary: `A ${l.type} listener on ${l.target} is not passive, so the browser has to wait for it before every scroll frame.` + (usesSmoothLib ? ' Expected if it belongs to the smooth-scroll library.' : ''),
      evidence: { type: l.type, target: l.target, passive: l.passive },
      fix: `Register it with { passive: true } unless it really calls preventDefault().`,
    });
  }
  const scrollListeners = runtime.listeners.filter((l) => l.type === 'scroll').length;

  // ---------- flash of content before intro animations ----------

  const fcp = runtime.paints['first-contentful-paint'];
  if (fcp != null) {
    const flashes = runtime.flashes.filter((f) => f.t > fcp + 16 && f.insertedAt <= fcp);
    for (const f of flashes.slice(0, 5)) {
      attach(
        add2({
          id: 'flash-of-content',
          severity: 'warning',
          title: 'Content flashes before its intro animation',
          element: f.sel,
          label: f.label,
          scrollY: 0,
          source: f.site,
          summary: `Painted visible at first contentful paint (${Math.round(fcp)}ms), then hidden by script at ${Math.round(f.t)}ms — a ~${Math.round(f.t - fcp)}ms flash before the animation starts.`,
          evidence: { firstContentfulPaintMs: Math.round(fcp), hiddenAtMs: Math.round(f.t) },
          fix: 'Hide the starting state in CSS so it is correct on first paint (e.g. `.js .hero h1 { visibility: hidden }` then gsap autoAlpha), or run gsap.set()/from() before first paint (inline script, useLayoutEffect/useGSAP) instead of on window load.',
        }),
        elements.findIndex((m) => m.sel === f.sel),
        0,
      );
    }
  }

  // ---------- sideways overflow (often elements animated in from off-screen) ----------

  const ovf = down.find((c) => c.overflow);
  const layoutWidth = Math.max(...down.map((c) => c.vw));
  const zoomedOut = meta.mobile && layoutWidth > meta.viewport.width + 1;
  if (ovf || zoomedOut) {
    const culprits = ovf?.overflow.culprits || [];
    const moving = culprits.find((c) => c.transform);
    attach(
      add2({
        id: 'horizontal-overflow',
        severity: 'warning',
        title: 'Content sticks out sideways',
        element: (moving || culprits[0])?.sel || null,
        scrollY: ovf ? ovf.y : 0,
        summary: zoomedOut
          ? `On a ${meta.viewport.width}px-wide phone the page lays out ${layoutWidth}px wide, so the browser zooms the whole page out (and every scroll position shifts).`
          : `The page scrolls sideways from y=${ovf.y}: content is ${ovf.overflow.scrollWidth}px wide in a ${ovf.overflow.clientWidth}px viewport.` +
            (moving ? ` ${moving.sel} is transformed (${moving.transform}) — likely an element waiting to slide in.` : ''),
        evidence: { culprits, layoutWidth },
        fix: 'Find the element wider than the viewport. Elements parked off-screen for slide-in animations (x: 100vw, translateX) need their section clipped with overflow-x: clip (keeps position: sticky working) or overflow: hidden; fixed-width blocks need max-width: 100%.',
      }),
      null,
      ovf ? ovf.y : 0,
    );
  }

  // ---------- configuration smells ----------

  if (usesSmoothLib && setup.tracked.scrollBehavior === 'smooth')
    add({
      id: 'smooth-scroll-conflict',
      severity: 'warning',
      title: 'CSS smooth scrolling fights the JS smooth-scroll library',
      element: 'html',
      summary: '`scroll-behavior: smooth` is set on <html> while a JS smooth-scroll library is active; programmatic scrolls get animated twice.',
      fix: 'Add `html.lenis, html.lenis body { height: auto } .lenis.lenis-smooth { scroll-behavior: auto !important }` (or the equivalent for your library).',
    });
  if (setup.tracked.willChange > 30)
    add({
      id: 'will-change-overuse',
      severity: 'info',
      title: 'Many elements use will-change',
      summary: `${setup.tracked.willChange} elements have will-change set; each one can get its own GPU layer.`,
      fix: 'Only set will-change on elements while they animate, or let GSAP handle it (force3D).',
    });
  if (pageErrors.length)
    add({
      id: 'js-errors',
      severity: 'warning',
      title: 'JavaScript errors during the audit',
      summary: `${pageErrors.length} uncaught error${pageErrors.length > 1 ? 's' : ''}: ${pageErrors.slice(0, 3).join(' | ')}`,
      evidence: { errors: pageErrors.slice(0, 10) },
      fix: 'An exception thrown during animation setup stops every animation registered after it. Fix these first.',
    });

  const context = {
    gsap: setup.gsap.present ? { version: setup.gsap.version, scrollTriggers: setup.gsap.triggers?.length ?? 0, smoother: setup.gsap.smoother } : null,
    smoothScroll: smooth,
    cssScrollTimelines: setup.tracked.scrollTimelines,
    trackedElements: elements.length,
    scrollListeners,
  };

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.scrollY ?? -1) - (b.scrollY ?? -1));
  findings.forEach((f, i) => (f.n = i + 1));
  return { findings, metrics, context };

  // ---------- GSAP / ScrollTrigger lint (static + refresh comparison) ----------

  function analyzeGsap() {
    const out = { fromConflictBySel: new Map(), layoutProps: new Map() };
    const G = setup.gsap;
    if (!G.present || !G.scrollTrigger) return out;
    // Judge reachability with the final page height and freshly refreshed
    // positions, so a stale layout can't mask (or fake) an unreachable trigger.
    const maxScroll = meta.maxY;
    const fresh = refresh && refresh.after.length === G.triggers.length ? refresh.after : null;
    const triggers = G.triggers.map((t) => (fresh ? { ...t, start: fresh[t.index][0], end: fresh[t.index][1], loadStart: t.start, loadEnd: t.end } : t));
    const firstTarget = (t) => t.tweens.flatMap((tw) => tw.targets)[0];
    const elIdx = (t) => t.triggerIdx ?? firstTarget(t)?.idx ?? null;
    const describe = (t) => (t.id ? `"${t.id}"` : t.trigger ? t.trigger : `#${t.index}`);

    const markers = [];
    const orphans = [];
    for (const t of triggers) {
      const base = { source: t.site, element: t.trigger || firstTarget(t)?.sel || null };
      if (t.scroller === 'window' && t.start > maxScroll + 1) {
        t.tweens.forEach((tw) => tw.targets.forEach((x) => unreachableEls.add(x.sel)));
        attach(
          add2({
            ...base,
            id: 'unreachable-trigger',
            severity: 'error',
            title: 'ScrollTrigger can never fire',
            scrollY: maxScroll,
            summary: `ScrollTrigger ${describe(t)} starts at y=${t.start}, but the page can only scroll to y=${maxScroll}.`,
            evidence: { start: t.start, end: t.end, maxScroll },
            fix: 'Use an earlier start (e.g. "top bottom" or "top 90%") for elements near the end of the page, or add space after them.',
          }),
          elIdx(t),
          maxScroll,
        );
      } else if (t.scroller === 'window' && t.scrub && t.animation && t.end > maxScroll + 1 && t.end > t.start) {
        const reach = (maxScroll - t.start) / (t.end - t.start);
        if (reach < 0.98)
          attach(
            add2({
              ...base,
              id: 'incomplete-scrub',
              severity: 'warning',
              title: 'Scrubbed animation cannot finish',
              scrollY: maxScroll,
              summary: `ScrollTrigger ${describe(t)} runs from y=${t.start} to y=${t.end}, but the page stops at y=${maxScroll}: the animation tops out at ${Math.round(reach * 100)}%.`,
              evidence: { start: t.start, end: t.end, maxScroll, maxProgress: round(reach, 3) },
              fix: 'Pull the end in (e.g. end: "bottom bottom" or "max"), or add space after the element.',
            }),
            elIdx(t),
            maxScroll,
          );
      }
      if (t.scrub && t.end - t.start <= 0)
        attach(
          add2({
            ...base,
            id: 'zero-length-scrub',
            severity: 'warning',
            title: 'Scrub range has no length',
            scrollY: t.start,
            summary: `ScrollTrigger ${describe(t)} has start=${t.start} and end=${t.end}; the scrubbed animation jumps instead of scrubbing.`,
            evidence: { start: t.start, end: t.end },
            fix: 'Make sure end is after start (e.g. start: "top bottom", end: "bottom top").',
          }),
          elIdx(t),
          t.start,
        );
      if (t.markers) markers.push(t);
      if (t.triggerConnected === false) orphans.push(t);
      if (t.nested)
        add({
          ...base,
          id: 'nested-scrolltrigger',
          severity: 'error',
          title: 'ScrollTrigger on a tween inside a timeline',
          scrollY: t.start,
          summary: `ScrollTrigger ${describe(t)} is attached to a child tween of a timeline; the timeline's playhead and the ScrollTrigger both try to control it.`,
          fix: 'Put the scrollTrigger on the timeline itself (gsap.timeline({ scrollTrigger })), or make the tween standalone.',
        });
      if (t.pinTransformedAncestor)
        attach(
          add2({
            ...base,
            element: t.pin,
            id: 'pin-transformed-ancestor',
            severity: 'error',
            title: 'Pinned element is inside a transformed ancestor',
            scrollY: t.start,
            summary: `${t.pin} is pinned with position: fixed, but its ancestor ${t.pinTransformedAncestor.sel} has ${t.pinTransformedAncestor.why}, which makes fixed positioning relative to that ancestor — the pin drifts or jumps.`,
            evidence: { ancestor: t.pinTransformedAncestor },
            fix: 'Remove the transform/filter/will-change/contain from the ancestor, set pinReparent: true, or use pinType: "transform".',
          }),
          elIdx(t),
          t.start,
        );
      const pinTween = t.tweens.find((tw) => tw.targetsPin && tw.props.some((p) => TRANSFORM_PROPS.has(p)));
      if (pinTween)
        add({
          ...base,
          element: t.pin,
          id: 'animated-pin',
          severity: 'warning',
          title: 'Pinned element is animated directly',
          scrollY: t.start,
          summary: `${t.pin} is pinned and its own ${pinTween.props.filter((p) => TRANSFORM_PROPS.has(p)).join('/')} is animated; ScrollTrigger measures the pin, so positions get thrown off.`,
          fix: 'Pin a wrapper and animate a child inside it.',
        });
      for (const tw of t.tweens)
        for (const target of tw.targets) {
          const props = tw.props.filter(isLayoutProp);
          if (!props.length) continue;
          const e = out.layoutProps.get(target.sel) || { props: new Set(), y: t.start, source: t.site, via: 'GSAP' };
          props.forEach((p) => e.props.add(p));
          out.layoutProps.set(target.sel, e);
        }
    }

    if (markers.length)
      add({
        id: 'markers-left-on',
        severity: 'warning',
        title: 'ScrollTrigger markers are enabled',
        element: markers.map(describe).join(', '),
        source: markers[0].site,
        scrollY: markers[0].start,
        summary: `${markers.length} ScrollTrigger${markers.length > 1 ? 's have' : ' has'} markers: true — debug markers will ship to production.`,
        fix: 'Remove markers: true (or gate it behind a dev flag).',
      });
    if (orphans.length)
      add({
        id: 'orphaned-trigger',
        severity: 'error',
        title: 'ScrollTriggers left behind for removed elements',
        source: orphans[0].site,
        summary: `${orphans.length} ScrollTrigger${orphans.length > 1 ? 's' : ''} still active although the trigger element is no longer in the DOM (${orphans.map(describe).join(', ')}). They keep firing callbacks and skew pin spacing.`,
        fix: 'Kill triggers when their component unmounts: wrap setup in gsap.context() / useGSAP() and call ctx.revert() on cleanup, or call trigger.kill().',
      });

    // Duplicates: same trigger, same range, same tweens → created twice (e.g. React effects without cleanup).
    const groups = new Map();
    for (const t of triggers) {
      const key = [t.trigger, t.start, t.end, t.tweens.map((tw) => tw.targets.map((x) => x.sel).join(',') + ':' + tw.props.join(',')).join(';')].join('|');
      groups.set(key, [...(groups.get(key) || []), t]);
    }
    const dupOf = new Map();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.forEach((t) => dupOf.set(t.index, list[0].index));
      list.forEach((t) => t.tweens.forEach((tw) => tw.targets.forEach((x) => dupEls.add(x.sel))));
      const t = list[0];
      attach(
        add2({
          id: 'duplicate-trigger',
          severity: 'error',
          title: 'Same ScrollTrigger created more than once',
          element: t.trigger,
          source: list[1].site || t.site,
          scrollY: t.start,
          summary: `${list.length} identical ScrollTriggers on ${describe(t)} (y=${t.start}–${t.end}). Typical of setup code that runs twice (React StrictMode, HMR, route changes) without cleanup.`,
          evidence: { indexes: list.map((x) => x.index) },
          fix: 'Make the setup idempotent: gsap.context()/useGSAP() with revert on cleanup, or kill existing triggers before creating new ones.',
        }),
        elIdx(t),
        t.start,
      );
    }

    // Two tweens owning the same property of the same element.
    const owners = new Map();
    for (const t of triggers)
      for (const tw of t.tweens)
        for (const target of tw.targets)
          for (const p of tw.props) {
            const key = `${target.sel}|${p}`;
            owners.set(key, [...(owners.get(key) || []), { t, tw, target }]);
          }
    const reported = new Set();
    for (const [key, list] of owners) {
      if (list.length < 2) continue;
      const [selector, prop] = key.split('|');
      const distinct = list.filter((o, i) => list.findIndex((x) => x.t.index === o.t.index) === i);
      if (distinct.length < 2) continue;
      const nonDup = distinct.filter((o) => !dupOf.has(o.t.index) || dupOf.get(o.t.index) === o.t.index);
      const fromOnes = distinct.filter((o) => o.tw.immediateRender);
      const a = distinct[0].t;
      const b = distinct[1].t;
      if (fromOnes.length && nonDup.length >= 2) {
        if (reported.has('from|' + selector)) {
          out.fromConflictBySel.get(selector).evidence.properties.push(prop);
          continue;
        }
        reported.add('from|' + selector);
        conflictEls.add(selector);
        const f = attach(
          add2({
            id: 'from-conflict',
            severity: 'error',
            title: 'from() tweens fight over the same property',
            element: selector,
            source: b.site || a.site,
            scrollY: Math.min(a.start, b.start),
            summary: `${distinct.length} ScrollTrigger tweens animate ${prop} on ${selector}, and at least one is a from()/fromTo() that renders immediately. The second one records the first one's hidden start state as its end value, so the element jumps or stays hidden.`,
            evidence: { properties: [prop], triggers: distinct.map((o) => ({ trigger: describe(o.t), start: o.t.start, end: o.t.end, from: o.tw.from })) },
            fix: 'Use one timeline per element, or fromTo() with explicit values, or set immediateRender: false on the later from() tweens.',
          }),
          a.triggerIdx ?? distinct[0].target.idx,
          Math.min(a.start, b.start),
        );
        out.fromConflictBySel.set(selector, f);
      } else if (nonDup.length >= 2 && a.start < b.end && b.start < a.end && !reported.has('overlap|' + selector)) {
        reported.add('overlap|' + selector);
        attach(
          add2({
            id: 'overlapping-tweens',
            severity: 'warning',
            title: 'Overlapping tweens on the same property',
            element: selector,
            source: b.site || a.site,
            scrollY: Math.max(a.start, b.start),
            scrollRange: [Math.max(a.start, b.start), Math.min(a.end, b.end)],
            summary: `${describe(a)} (y=${a.start}–${a.end}) and ${describe(b)} (y=${b.start}–${b.end}) both animate ${prop} on ${selector}; in the overlap the last one to render wins.`,
            fix: 'Give each property one owner at a time: split the ranges, or merge both into a single timeline.',
          }),
          distinct[0].target.idx,
          Math.max(a.start, b.start),
        );
      }
    }

    // Pins created after triggers further down the page shift those triggers.
    if (!triggers.some((t) => t.refreshPriority != null)) {
      for (const p of triggers) {
        if (!p.pin || p.pinSpacing === false || p.triggerDocTop == null) continue;
        const early = triggers.filter((t) => t.index < p.index && t.triggerDocTop != null && t.triggerDocTop > p.triggerDocTop);
        if (!early.length) continue;
        add({
          id: 'out-of-order',
          severity: 'warning',
          title: 'Pin created after triggers below it',
          element: p.pin,
          source: p.site,
          scrollY: p.start,
          summary: `The pin ${describe(p)} was created after ${early.length} ScrollTrigger(s) further down the page, so their positions don't include the pin's spacing.`,
          fix: 'Create ScrollTriggers in page order, or give later ones refreshPriority (higher = refreshed first) so pins are measured first.',
        });
      }
    }

    // Positions in use vs. positions after a fresh ScrollTrigger.refresh().
    if (refresh && refresh.before.length === refresh.after.length) {
      const stale = [];
      refresh.before.forEach(([s0, e0], i) => {
        const [s1, e1] = refresh.after[i];
        const d = Math.max(Math.abs(s1 - s0), Math.abs(e1 - e0));
        const t = triggers[i];
        if (d <= 20 || !t) return;
        // Only a real layout move counts. A trigger measured while its own
        // from() transform was applied also "moves" on refresh, harmlessly.
        const l0 = t.triggerLayoutTop;
        const l1 = refresh.layout?.[i];
        if (l0 != null && l1 != null && Math.abs(l1 - l0) <= 20) return;
        stale.push({ t, d, was: [s0, e0], now: [s1, e1], layoutMoved: l0 != null && l1 != null ? l1 - l0 : null });
      });
      if (stale.length) {
        stale.sort((x, y) => y.d - x.d);
        const w = stale[0];
        attach(
          add2({
            id: 'stale-trigger-positions',
            severity: w.d > 100 ? 'error' : 'warning',
            title: 'ScrollTrigger positions are out of date',
            element: w.t.trigger,
            source: w.t.site,
            scrollY: Math.min(w.was[0], w.now[0]),
            summary: `${stale.length} ScrollTrigger${stale.length > 1 ? 's' : ''} fire at the wrong scroll position — up to ${w.d}px off (${describe(w.t)} starts at y=${w.was[0]} but should start at y=${w.now[0]}). The layout changed after positions were calculated.`,
            evidence: { triggers: stale.slice(0, 8).map((s) => ({ trigger: describe(s.t), was: s.was, shouldBe: s.now })) },
            fix: 'Call ScrollTrigger.refresh() after late content settles (lazy images, fonts, injected sections), e.g. on each image load, or reserve the space so the layout does not change.',
          }),
          elIdx(w.t),
          w.was[0],
        );
      }
    }
    return out;
  }
}

const HIDDEN_BY = { clipped: 'clipped by an overflow:hidden parent', 'clip-path': 'clip-path hides it', 'scale-0': 'scaled to 0' };

function eligible(m) {
  if (!m || m.position === 'fixed') return false;
  if (m.reasons.some((r) => STRONG_REASONS.includes(r))) return true;
  return m.reasons.includes('initially-hidden') && m.position !== 'absolute' && m.content;
}

// "In view" = at least 60% of the viewport (or the whole element, if smaller) is covered by it.
function inView(s, cp) {
  const [, , , , top, left, w, h] = s;
  const { vw, vh } = cp;
  if (w < 1 || h < 1) return top >= 0 && top <= vh && left >= 0 && left <= vw;
  const visH = Math.min(top + h, vh) - Math.max(top, 0);
  const visW = Math.min(left + w, vw) - Math.max(left, 0);
  return visH >= Math.min(h, vh * 0.6) - 1 && visW >= Math.min(w, vw * 0.6) - 1;
}

function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
