---
name: fix-scroll-animations
description: Root causes and code fixes for broken scroll animations — GSAP ScrollTrigger mistakes, reveals that never appear, scroll jank, forced reflows, layout shifts, flashes before intro animations, smooth-scroll conflicts. Use when fixing findings from a ScrollProof report (check ids like never-revealed, from-conflict, stale-trigger-positions) or when debugging scroll-driven animations by hand.
---

# Fixing scroll animations

Each ScrollProof finding has a check id. Find it below, confirm the cause in the source line the report points at, then apply the smallest fix. Prefer fixes that keep the designer's intent (same motion, same timing).

## Elements that never show

**`never-revealed`** — on screen, still `opacity: 0` / clipped / scaled to 0.
- Taller than the viewport + IntersectionObserver `threshold: 1` (or close): it can never be fully visible. Use `threshold: 0.15` or `rootMargin: '0px 0px -15% 0px'`.
- ScrollTrigger start needs the element's bottom in view (`start: "bottom bottom"` on a tall element): use `"top 80%"`.
- The report's `likelyCause` names another finding on the same element (`from-conflict`, `duplicate-trigger`, `unreachable-trigger`) — fix that one.
- A JS error stopped setup (`js-errors` finding).

**`unreachable-trigger`** — start is below the maximum scroll position, so it never fires. Near the page end use `start: "top bottom"` / `"top 90%"`, or add space after the element.

**`incomplete-scrub`** — scrub end is below the page end, so the animation stops part-way. Use `end: "bottom bottom"` or `end: "max"`.

## GSAP ScrollTrigger mistakes

**`from-conflict`** — several `from()` tweens on the same property. `from()` renders immediately, so the second one records the hidden state as its *end* value and animates 0 → 0.
```js
// before
gsap.from(el, { opacity: 0, scrollTrigger: { trigger: el, start: 'top 90%', end: 'top 60%', scrub: true } });
gsap.from(el, { opacity: 0, scrollTrigger: { trigger: el, start: 'top 50%', end: 'top 20%', scrub: true } });
// after: one timeline owns the property
gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 90%', end: 'top 20%', scrub: true } })
  .fromTo(el, { opacity: 0 }, { opacity: 1 })
  .to(el, { opacity: 0 }, '+=0.5');
```
Alternatives: `fromTo()` with explicit values, or `immediateRender: false` on later `from()` tweens.

**`overlapping-tweens`** — two triggers drive the same property over overlapping ranges; the last render wins. Split the ranges or merge into one timeline.

**`nondeterministic-scrub`** — a scrubbed element looks different at the same scroll position going down vs up. Same root causes as the two above, or a toggle tween also touching the element.

**`duplicate-trigger`** — setup ran twice without cleanup (React StrictMode, HMR, route changes). In React:
```js
import { useGSAP } from '@gsap/react';
useGSAP(() => {
  gsap.from('.quote', { opacity: 0, y: 30, scrollTrigger: { trigger: '.quote', start: 'top 80%' } });
}, { scope: container }); // reverts on unmount, safe in StrictMode
```
Without React: `const ctx = gsap.context(() => { ... }); ... ctx.revert();`.

**`orphaned-trigger`** — the trigger element was removed but the ScrollTrigger lives on. Same fix as duplicates: `gsap.context()` / `useGSAP()` revert, or `trigger.kill()` when the element goes away.

**`nested-scrolltrigger`** — `scrollTrigger` on a tween inside a timeline. Put it on the timeline: `gsap.timeline({ scrollTrigger: {...} }).to(...)`.

**`pin-transformed-ancestor`** — `position: fixed` inside an ancestor with `transform`, `filter`, `perspective`, `will-change: transform`, `contain: paint` or `container-type` is fixed to that ancestor, not the viewport. Remove that style from the ancestor (the report names it), or `pinReparent: true`, or `pinType: "transform"`.

**`animated-pin`** — the pinned element's own transform is animated. Pin a wrapper, animate a child.

**`out-of-order`** — a pin was created after triggers below it, so their positions miss the pin spacing. Create triggers top-to-bottom, or set `refreshPriority` (higher refreshes first).

**`stale-trigger-positions`** — layout above the trigger changed after ScrollTrigger measured (lazy images without size, late fonts, injected content). Best: reserve the space (`width`/`height` attributes, `aspect-ratio`). Otherwise refresh once things settle:
```js
document.querySelectorAll('img[loading="lazy"]').forEach((img) =>
  img.addEventListener('load', () => ScrollTrigger.refresh(), { once: true }));
document.fonts.ready.then(() => ScrollTrigger.refresh());
```

**`markers-left-on`** — remove `markers: true` or gate it: `markers: import.meta.env.DEV`.

**`zero-length-scrub`** — end equals start; make the range positive.

## Performance

**`jank`** — frames over 2× budget while scrolling; the finding names the script (from Long Animation Frame data). Typical fixes: do less per scroll event (move work into one `requestAnimationFrame`, or use ScrollTrigger / IntersectionObserver instead of scroll listeners), avoid layout reads after writes, cache measurements on resize.

**`forced-reflow`** — the exact line that reads layout after a style write. Batch: read everything first, then write.
```js
// before: read + write per item → one forced layout per item
items.forEach((it) => (it.style.paddingLeft = (it.offsetTop % 7) + 'px'));
// after: all reads, then all writes
const tops = items.map((it) => it.offsetTop);
items.forEach((it, i) => (it.style.paddingLeft = (tops[i] % 7) + 'px'));
```

**`layout-property-animation`** — animating `width`, `height`, `top`, `left`, `margin`, `padding`… relayouts every frame. Use `scaleX`/`scaleY` with `transform-origin`, `x`/`y`, or `clip-path`.

**`non-passive-listener`** — `wheel`/`touch*` listener without `{ passive: true }` makes every scroll wait for JS. Add `passive: true` unless it calls `preventDefault()` (smooth-scroll libraries legitimately do).

**`layout-shift`** — visible content jumped mid-scroll. Reserve space for late content; don't insert above what the user is reading.

## Load and setup

**`flash-of-content`** — painted visible, then hidden by JS for its intro. Make the start state correct on first paint:
```css
.hero h1 { visibility: hidden; } /* GSAP autoAlpha flips visibility back */
```
```js
gsap.fromTo('.hero h1', { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0 });
```
Run intro setup before first paint (inline script, `useLayoutEffect` / `useGSAP`), not on `window.load`.

**`smooth-scroll-conflict`** — CSS `scroll-behavior: smooth` together with Lenis/Locomotive. Add the library's CSS (`.lenis.lenis-smooth { scroll-behavior: auto !important; }`).

**`scroll-locked`** — wheel scrolling stops early: `overflow: hidden` left on `html`/`body` by a preloader or menu, `lenis.stop()` never followed by `start()`, or a wheel handler calling `preventDefault()`.

**`js-errors`** — fix these first; an exception during setup silently kills every animation registered after it.

## After fixing

Re-run `/scrollproof:audit` with the same arguments and compare scores. For CI, `--fail-on error` exits non-zero when errors remain.
