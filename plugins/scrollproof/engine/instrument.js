// ScrollProof in-page instrumentation.
// Injected with page.addInitScript, so it runs before any site script. It never
// mutates the site's DOM; everything the Node side needs is read through
// window.__scrollproof.
(() => {
  if (window !== window.top || window.__scrollproof) return;

  const now = () => performance.now();
  const r1 = (n) => Math.round(n * 10) / 10;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  // Stack frames from libraries (and from this file) are skipped when we look
  // for the line of *site* code that created something.
  const LIB_URL =
    /\/node_modules\/|\/\.vite\/deps\/|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|scrollproof-instrument|\/vendor\/|\/(gsap|ScrollTrigger|ScrollSmoother|SplitText|lenis|locomotive-scroll)(\.min)?\.m?js/i;
  const MEDIA = 'img,svg,video,canvas,picture,iframe';
  const REVEAL_SELECTOR = [
    '[data-aos]', '[data-sal]', '[data-scroll]', '[data-animate]', '[data-animation]', '[data-reveal]',
    '[data-motion]', '[data-inview]', '[data-in-view]', '.reveal', '.fade-in', '.fade-up', '.animate-on-scroll',
    '.wow', '.js-reveal', '[class*="animate__"]',
  ].join(',');
  const RESERVED = new Set(
    ('duration delay ease repeat repeatDelay repeatRefresh yoyo yoyoEase stagger scrollTrigger onStart onUpdate ' +
      'onComplete onRepeat onReverseComplete onInterrupt onStartParams onUpdateParams onCompleteParams onRepeatParams ' +
      'onReverseCompleteParams callbackScope overwrite immediateRender lazy id paused reversed runBackwards startAt data ' +
      'inherit keyframes autoRound force3D transformOrigin svgOrigin smoothOrigin clearProps parent stringFilter defaults ' +
      'easeEach onToggle').split(' '),
  );

  const sp = {
    recording: false,
    frames: [], // [t, dt, scrollY] for every frame while recording
    yTimeline: [], // [t, scrollY] whenever scrollY changes, to map timestamps to scroll positions
    loaf: [],
    shifts: [],
    listeners: [],
    flashes: [],
    paints: {},
    cssSeen: new Map(), // element -> { props, y, name } for CSS animations seen running during the sweep
    tracked: [],
    trackedIndex: new Map(),
    clipParents: [],
  };
  Object.defineProperty(window, '__scrollproof', { value: sp });

  // ---------- helpers ----------

  function sel(el) {
    if (el === window) return 'window';
    if (el === document) return 'document';
    if (!el || el.nodeType !== 1) return null;
    if (el === document.body || el === document.documentElement) return el.tagName.toLowerCase();
    const parts = [];
    // ScrollTrigger wraps pinned elements in a .pin-spacer; skip it and use a
    // descendant combinator so the selector also matches when nothing is pinned.
    let joiner = ' > ';
    for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
      if (n === document.body || n === document.documentElement) break;
      if (n.classList.contains('pin-spacer')) {
        joiner = ' ';
        continue;
      }
      if (parts.length) parts.unshift(joiner);
      joiner = ' > ';
      if (n.id && !/^\d/.test(n.id)) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      let part = n.tagName.toLowerCase();
      const cls = [...n.classList]
        .filter((c) => !/^(pin-spacer|gsap-|is-|has-|lenis|aos-)/.test(c) && c.length < 40)
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = n.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === n.tagName);
        const lookalikes = sameTag.filter((c) => cls.every((k) => c.classList.contains(k)));
        if (lookalikes.length > 1) part += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join('');
  }

  const label = (el) =>
    ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt'))) || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48) || el.tagName.toLowerCase();

  const hasContent = (el) =>
    el.matches(MEDIA) || !!el.querySelector(MEDIA) || (el.textContent || '').trim().length > 0;

  // First stack frame that belongs to the site rather than a library.
  function callSite() {
    const lines = (new Error().stack || '').split('\n').slice(1);
    for (const line of lines) {
      const m = line.match(/^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/);
      if (!m) continue;
      const url = m[2];
      if (LIB_URL.test(url) || !/^(https?|file):/.test(url)) continue;
      return { fn: m[1] || null, url, line: +m[3], col: +m[4] };
    }
    return null;
  }

  function observe(type, cb) {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({ type, buffered: true });
    } catch {
      /* entry type not supported in this browser */
    }
  }

  const rectOf = (r) => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null);

  // ---------- frame timing + scroll position timeline ----------

  let lastT = 0;
  let lastY = -1;
  let lastMarkBucket = -1;
  let frameNo = 0;
  function tick(t) {
    const y = window.scrollY;
    if (y !== lastY) {
      if (sp.yTimeline.length < 100000) sp.yTimeline.push([r1(t), Math.round(y)]);
      lastY = y;
    }
    if (sp.recording && lastT) {
      sp.frames.push([r1(t), r1(t - lastT), Math.round(y)]);
      // User-timing marks let the Chrome trace be mapped back to scroll positions.
      const bucket = Math.floor(y / 100);
      if (bucket !== lastMarkBucket) {
        lastMarkBucket = bucket;
        performance.mark('sp:y=' + Math.round(y));
      }
      if (++frameNo % 20 === 0) sampleCssAnimations(y);
    }
    lastT = t;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  const keyframeProps = new WeakMap();
  function sampleCssAnimations(y) {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue;
      const el = a.effect && a.effect.target;
      if (!el || el.nodeType !== 1) continue;
      let props = keyframeProps.get(a);
      if (!props) {
        props =
          typeof CSSTransition !== 'undefined' && a instanceof CSSTransition
            ? [a.transitionProperty]
            : [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter(
                (k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k),
              );
        keyframeProps.set(a, props);
      }
      let seen = sp.cssSeen.get(el);
      if (!seen) {
        if (sp.cssSeen.size > 500) continue;
        seen = { props: new Set(), y: Math.round(y), name: a.animationName || a.transitionProperty || a.id || null };
        sp.cssSeen.set(el, seen);
      }
      props.forEach((p) => seen.props.add(p));
    }
  }

  // ---------- performance observers ----------

  observe('long-animation-frame', (e) => {
    if (sp.loaf.length > 3000) return;
    sp.loaf.push({
      t: r1(e.startTime),
      dur: r1(e.duration),
      blocking: r1(e.blockingDuration || 0),
      scripts: (e.scripts || []).slice(0, 6).map((s) => ({
        invoker: s.invoker,
        type: s.invokerType,
        url: s.sourceURL,
        fn: s.sourceFunctionName,
        char: s.sourceCharPosition,
        dur: r1(s.duration),
        forced: r1(s.forcedStyleAndLayoutDuration || 0),
      })),
    });
  });

  observe('layout-shift', (e) => {
    if (e.hadRecentInput || sp.shifts.length > 2000) return;
    sp.shifts.push({
      t: r1(e.startTime),
      value: r3(e.value),
      sources: (e.sources || []).slice(0, 3).map((s) => ({
        node: s.node ? sel(s.node) : null,
        prev: rectOf(s.previousRect),
        cur: rectOf(s.currentRect),
      })),
    });
  });

  observe('paint', (e) => {
    sp.paints[e.name] = r1(e.startTime);
  });

  // ---------- scroll / wheel / touch listeners ----------

  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'wheel' || type === 'mousewheel' || type === 'touchmove' || type === 'touchstart' || type === 'scroll') {
      try {
        if (sp.listeners.length < 300) {
          const explicit = options && typeof options === 'object' && 'passive' in options ? !!options.passive : null;
          const rootTarget =
            this === window || this === document || this === document.documentElement || this === document.body;
          sp.listeners.push({
            type,
            target: sel(this),
            passive: explicit,
            // Chrome treats wheel/touch listeners on window/document/body as passive unless told otherwise.
            effectivePassive: type === 'scroll' ? true : explicit !== null ? explicit : rootTarget,
            site: callSite(),
          });
        }
      } catch {
        /* never break the site */
      }
    }
    return origAdd.call(this, type, listener, options);
  };

  // ---------- GSAP / ScrollTrigger hooks ----------

  function hookGlobal(name, onSet) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v) => {
          value = v;
          try {
            onSet(v);
          } catch {
            /* ignore */
          }
        },
      });
    } catch {
      /* property already locked down by the site */
    }
  }

  // GSAP registers ScrollTrigger on window (even from bundled ES modules), and
  // tweens with a `scrollTrigger` config go through ScrollTrigger.create, so
  // wrapping create gives us the site's call site for every trigger.
  hookGlobal('ScrollTrigger', (ST) => {
    if (!ST || ST.__spHooked || typeof ST.create !== 'function') return;
    ST.__spHooked = true;
    const create = ST.create;
    ST.create = function () {
      const st = create.apply(this, arguments);
      try {
        st.__spSite = callSite();
      } catch {
        /* ignore */
      }
      return st;
    };
  });

  const tweenIds = new WeakMap();
  let nextTweenId = 1;
  const tweenId = (t) => {
    if (!tweenIds.has(t)) tweenIds.set(t, nextTweenId++);
    return tweenIds.get(t);
  };

  function tweenProps(vars) {
    const out = new Set();
    const add = (o) =>
      o &&
      typeof o === 'object' &&
      Object.keys(o).forEach((k) => {
        if (k === 'css') add(o.css);
        else if (!RESERVED.has(k)) out.add(k === 'autoAlpha' ? 'opacity' : k);
      });
    add(vars);
    if (vars.startAt) add(vars.startAt);
    const kf = vars.keyframes;
    if (Array.isArray(kf)) kf.forEach(add);
    else if (kf && typeof kf === 'object')
      Object.keys(kf).forEach((k) => (/^\d+%$/.test(k) ? add(kf[k]) : !RESERVED.has(k) && out.add(k)));
    return [...out];
  }

  const leafTweens = (st) => {
    const a = st.animation;
    if (!a) return [];
    return a.getChildren ? a.getChildren(true, true, false) : [a];
  };

  // Document position from layout alone (offsetTop ignores transforms), so an
  // element's own animation never looks like a layout change.
  sp.layoutTop = (el) => {
    if (!el || !el.isConnected) return null;
    if (!('offsetTop' in el)) return Math.round(el.getBoundingClientRect().top + scrollY);
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
    return Math.round(y);
  };

  const getST = () => window.ScrollTrigger || (window.gsap && window.gsap.core && window.gsap.core.globals().ScrollTrigger);

  // Ancestors with these styles become the containing block for position:fixed,
  // which breaks ScrollTrigger's default pinning.
  function transformedAncestor(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.classList.contains('pin-spacer')) continue;
      const cs = getComputedStyle(n);
      const why =
        (cs.transform !== 'none' && `transform: ${cs.transform}`) ||
        (cs.filter !== 'none' && `filter: ${cs.filter}`) ||
        (cs.perspective !== 'none' && `perspective: ${cs.perspective}`) ||
        (/transform|filter|perspective/.test(cs.willChange) && `will-change: ${cs.willChange}`) ||
        (/paint|layout|strict|content/.test(cs.contain) && `contain: ${cs.contain}`) ||
        (cs.backdropFilter && cs.backdropFilter !== 'none' && `backdrop-filter: ${cs.backdropFilter}`) ||
        (cs.containerType && cs.containerType !== 'normal' && `container-type: ${cs.containerType}`);
      if (why) return { sel: sel(n), why };
    }
    return null;
  }

  sp.gsapInfo = () => {
    const g = window.gsap;
    if (!g) return { present: false, versions: window.gsapVersions || null };
    const ST = getST();
    const info = {
      present: true,
      version: g.version,
      scrollTrigger: !!ST,
      maxScroll: null,
      smoother: !!(window.ScrollSmoother && window.ScrollSmoother.get && window.ScrollSmoother.get()),
      triggers: [],
    };
    if (!ST) return info;
    info.maxScroll = Math.round(ST.maxScroll(window));
    ST.getAll().forEach((st, index) => {
      const vars = st.vars || {};
      const anim = st.animation;
      const winScroller =
        !st.scroller || st.scroller === window || st.scroller === document.documentElement || st.scroller === document.body;
      const tweens = leafTweens(st).map((t) => {
        const targets = t.targets();
        const isFrom = !!(t.vars.runBackwards || t.vars.startAt);
        return {
          id: tweenId(t),
          targets: targets
            .filter((e) => e && e.nodeType === 1)
            .map((e) => ({ sel: sel(e), idx: sp.trackedIndex.has(e) ? sp.trackedIndex.get(e) : null })),
          props: tweenProps(t.vars),
          from: isFrom,
          immediateRender: isFrom && t.vars.immediateRender !== false,
          targetsPin: !!(st.pin && targets.includes(st.pin)),
        };
      });
      info.triggers.push({
        index,
        id: vars.id != null ? String(vars.id) : null,
        trigger: st.trigger ? sel(st.trigger) : null,
        triggerIdx: st.trigger && sp.trackedIndex.has(st.trigger) ? sp.trackedIndex.get(st.trigger) : null,
        triggerConnected: st.trigger ? st.trigger.isConnected : null,
        triggerDocTop: st.trigger && st.trigger.isConnected ? Math.round(st.trigger.getBoundingClientRect().top + scrollY) : null,
        triggerLayoutTop: st.trigger ? sp.layoutTop(st.trigger) : null,
        start: Math.round(st.start),
        end: Math.round(st.end),
        scrub: vars.scrub != null ? vars.scrub : false,
        pin: st.pin ? sel(st.pin) : null,
        pinSpacing: vars.pinSpacing != null ? vars.pinSpacing : true,
        pinTransformedAncestor:
          st.pin && winScroller && !vars.pinReparent && vars.pinType !== 'transform' ? transformedAncestor(st.pin) : null,
        markers: !!vars.markers,
        toggleActions: vars.toggleActions || null,
        once: !!vars.once,
        refreshPriority: 'refreshPriority' in vars ? vars.refreshPriority : null,
        scroller: winScroller ? 'window' : sel(st.scroller),
        progress: r3(st.progress),
        isActive: !!st.isActive,
        nested: !!(anim && anim.parent && g.globalTimeline && anim.parent !== g.globalTimeline),
        animation: anim ? (anim.getChildren ? 'timeline' : 'tween') : null,
        tweens,
        site: st.__spSite || null,
      });
    });
    return info;
  };

  // ---------- early "flash of content" detection ----------
  // Elements painted visible at first contentful paint, then hidden by JS
  // (typically gsap.from() running after first paint) flash on screen.

  const insertedAt = new WeakMap();
  const flashed = new WeakSet();
  // True when a same-origin stylesheet already hides the element (or an ancestor),
  // i.e. the hidden start state was there on first paint and nothing flashed.
  function hiddenByStylesheet(el) {
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) chain.push(n);
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet
      }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.style) continue;
        const op = rule.style.opacity;
        const hides = (op !== '' && +op < 0.05) || rule.style.visibility === 'hidden';
        if (!hides) continue;
        try {
          if (chain.some((n) => n.matches(rule.selectorText))) return true;
        } catch {
          /* selector the engine cannot match */
        }
      }
    }
    return false;
  }
  const insertedTime = (el) => {
    for (let n = el; n; n = n.parentElement) if (insertedAt.has(n)) return insertedAt.get(n);
    return 0;
  };
  const flashObserver = new MutationObserver((records) => {
    const t = now();
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => n.nodeType === 1 && insertedAt.set(n, t));
        continue;
      }
      const el = r.target;
      if (el.nodeType !== 1 || flashed.has(el) || el === document.body || el === document.documentElement) continue;
      if (r.attributeName === 'style') {
        const op = el.style.opacity;
        const hiddenInline = (op !== '' && +op < 0.05) || el.style.visibility === 'hidden';
        const wasHidden = /opacity:\s*0(\.0+)?\s*(;|$)|visibility:\s*hidden/.test(r.oldValue || '');
        if (!hiddenInline || wasHidden) continue;
      } else {
        const cs = getComputedStyle(el);
        if (+cs.opacity >= 0.05 && cs.visibility !== 'hidden') continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.width * rect.height < 64 || !hasContent(el)) continue;
      flashed.add(el);
      if (r.attributeName === 'style' && hiddenByStylesheet(el)) continue;
      if (sp.flashes.length < 200)
        sp.flashes.push({ t: r1(t), insertedAt: r1(insertedTime(el)), sel: sel(el), label: label(el), site: callSite() });
    }
  });
  flashObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['style', 'class'],
  });

  sp.endSetup = () => flashObserver.disconnect();

  // ---------- tracked elements ----------

  function clipParentOf(el) {
    let n = el.parentElement;
    for (let depth = 0; n && depth < 4 && n !== document.body; depth++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/hidden|clip/.test(cs.overflowX + cs.overflowY)) return n;
    }
    return null;
  }

  const isScrollDriven = (a) => !!a.timeline && a.timeline !== document.timeline;

  sp.collect = (max = 1500) => {
    const meta = [];
    const add = (el, reason) => {
      if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return;
      let i = sp.trackedIndex.get(el);
      if (i === undefined) {
        if (sp.tracked.length >= max) return;
        i = sp.tracked.length;
        sp.trackedIndex.set(el, i);
        sp.tracked.push(el);
        sp.clipParents.push(clipParentOf(el));
        const cs = getComputedStyle(el);
        meta.push({ sel: sel(el), label: label(el), reasons: [], position: cs.position, content: hasContent(el) });
      }
      if (!meta[i].reasons.includes(reason)) meta[i].reasons.push(reason);
    };

    const ST = getST();
    if (ST) {
      for (const st of ST.getAll()) {
        for (const t of leafTweens(st))
          for (const el of t.targets()) add(el, st.vars && st.vars.scrub ? 'gsap-scrub' : 'gsap');
        if (st.trigger) add(st.trigger, 'gsap-trigger');
      }
    }

    let scrollTimelines = 0;
    for (const a of document.getAnimations()) {
      const el = a.effect && a.effect.target;
      if (!el) continue;
      if (isScrollDriven(a)) {
        scrollTimelines++;
        add(el, 'css-scroll-timeline');
      }
    }

    document.querySelectorAll(REVEAL_SELECTOR).forEach((el) => add(el, 'reveal-attr'));

    let willChange = 0;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|BR)$/.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.willChange && cs.willChange !== 'auto') willChange++;
      if (cs.display === 'none' || cs.position === 'fixed') continue;
      const parentHidden = el.parentElement && getComputedStyle(el.parentElement).visibility === 'hidden';
      if ((+cs.opacity < 0.05 || (cs.visibility === 'hidden' && !parentHidden)) && hasContent(el)) {
        add(el, 'initially-hidden');
        continue;
      }
      if (cs.transform !== 'none') {
        const cp = clipParentOf(el);
        if (cp && !intersects(el.getBoundingClientRect(), cp.getBoundingClientRect()) && hasContent(el))
          add(el, 'initially-clipped');
      }
    }

    const html = document.documentElement;
    return {
      elements: meta,
      willChange,
      scrollTimelines,
      scrollBehavior: getComputedStyle(html).scrollBehavior,
      smoothScroll: {
        lenis: !!(window.lenis || window.__lenis || html.classList.contains('lenis')),
        locomotive: !!(window.LocomotiveScroll || document.querySelector('[data-scroll-container]')),
        scrollSmoother: !!(window.ScrollSmoother && window.ScrollSmoother.get && window.ScrollSmoother.get()),
      },
      overflow: { html: getComputedStyle(html).overflowY, body: document.body ? getComputedStyle(document.body).overflowY : null },
    };
  };

  function intersects(a, b) {
    return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  }

  function clipPathHidden(cp) {
    if (!cp || cp === 'none') return false;
    if (/^circle\(\s*0/.test(cp)) return true;
    const m = cp.match(/^inset\(([^)]*)\)/);
    if (!m) return false;
    const v = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map((s) => (s.endsWith('%') ? parseFloat(s) : NaN));
    const [t, r = t, b = t, l = r] = v;
    return t + b >= 99.5 || l + r >= 99.5;
  }

  // Outermost elements that stick out past `limit` px without a clipping ancestor.
  function overflowCulprits(limit) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right <= limit + 1 || r.width === 0) continue;
      const parent = el.parentElement;
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > limit + 1) continue;
      let clipped = false;
      for (let n = parent; n && n !== document.body; n = n.parentElement) {
        if (/hidden|clip/.test(getComputedStyle(n).overflowX) && n.getBoundingClientRect().right <= limit + 1) clipped = true;
      }
      if (clipped) continue;
      const cs = getComputedStyle(el);
      out.push({ sel: sel(el), right: Math.round(r.right), transform: cs.transform !== 'none' ? cs.transform : null });
      if (out.length >= 5) break;
    }
    return out;
  }

  // State of every tracked element near the viewport, at the current scroll position.
  sp.snapshot = () => {
    const vw = innerWidth;
    const vh = innerHeight;
    const cw = document.documentElement.clientWidth;
    const sw = document.scrollingElement.scrollWidth;
    let overflow = null;
    if (sw > cw + 1 && !sp.overflowSeen) {
      sp.overflowSeen = true;
      overflow = { scrollWidth: sw, clientWidth: cw, culprits: overflowCulprits(cw) };
    }
    const states = [];
    sp.tracked.forEach((el, i) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < -vh * 0.5 || r.top > vh * 1.5) return;
      const cs = getComputedStyle(el);
      const cp = sp.clipParents[i];
      let hiddenBy = '';
      if (cp && cp.isConnected && !intersects(r, cp.getBoundingClientRect())) hiddenBy = 'clipped';
      else if (clipPathHidden(cs.clipPath)) hiddenBy = 'clip-path';
      else if ((r.width < 1 || r.height < 1) && el.offsetWidth > 4 && el.offsetHeight > 4) hiddenBy = 'scale-0';
      states.push([
        i,
        r3(+cs.opacity),
        cs.visibility === 'hidden' ? 1 : 0,
        hiddenBy,
        Math.round(r.top),
        Math.round(r.left),
        Math.round(r.width),
        Math.round(r.height),
      ]);
    });
    return { y: Math.round(scrollY), vw, vh, docH: document.scrollingElement.scrollHeight, overflow, states };
  };

  // ---------- settling ----------

  function busy() {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running' || isScrollDriven(a)) continue;
      const timing = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming();
      if (!timing || timing.endTime === Infinity) continue;
      return true;
    }
    const g = window.gsap;
    if (g && g.globalTimeline) {
      for (const t of g.globalTimeline.getChildren(false, true, true)) {
        if (t.isActive() && t.repeat() !== -1 && t.totalDuration() < 60) return true;
      }
    }
    return false;
  }

  // Resolves once scrolling has stopped and no finite CSS/GSAP animation is running.
  // minMs gives throttled scroll handlers (AOS uses ~100 ms) time to react.
  sp.settle = async (maxMs = 2000, minFrames = 6, minMs = 150) => {
    const t0 = now();
    let y0 = scrollY;
    let still = 0;
    for (;;) {
      await new Promise((res) => requestAnimationFrame(res));
      if (Math.abs(scrollY - y0) < 0.5) still++;
      else {
        still = 0;
        y0 = scrollY;
      }
      const ms = Math.round(now() - t0);
      if (still >= minFrames && ms >= minMs && !busy()) return { ms, timedOut: false };
      if (ms > maxMs) return { ms, timedOut: true };
    }
  };

  sp.startRecording = () => {
    sp.frames = [];
    sp.recording = true;
    lastMarkBucket = -1;
    performance.mark('sp:y=' + Math.round(scrollY));
  };
  sp.stopRecording = () => {
    performance.mark('sp:y=' + Math.round(scrollY));
    sp.recording = false;
  };

  sp.drain = () => {
    const cssRunning = [];
    sp.cssSeen.forEach((v, el) => cssRunning.push({ sel: sel(el), props: [...v.props], y: v.y, name: v.name }));
    return {
      frames: sp.frames,
      yTimeline: sp.yTimeline,
      loaf: sp.loaf,
      shifts: sp.shifts,
      listeners: sp.listeners,
      flashes: sp.flashes,
      paints: sp.paints,
      cssRunning,
    };
  };
})();
//# sourceURL=scrollproof-instrument.js
