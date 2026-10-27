# ScrollProof

Objective testing for scroll-driven animations — a Claude Code plugin for creative developers.

```
/scrollproof:audit localhost:3000
```

ScrollProof scrolls through your site like a user, captures every animation's state at each scroll position, records a Chrome performance trace, and reads GSAP/ScrollTrigger's internals. It reports **what broke, the exact scroll position, the element, and the line of code** behind it — then Claude explains the cause and proposes the fix.

It does not create animations. It tests them.

```
ScrollProof 0/100 — 10 errors, 7 warnings

ERROR y=1224        from-conflict              section.conflict > div.conflict-box
       2 ScrollTrigger tweens animate opacity … Seen in the browser: visible at y=1350, gone at y=1800 while still on screen.
       at /broken.html:109:10
ERROR y=3150        never-revealed             section.io > div.reveal.tall
       Stays hidden (opacity: 0) at all 4 checkpoints where it is on screen, first fully in view at y=3150.
ERROR y=5184-7072   jank
       60 frames over 33.4ms (worst 48.5ms) between y=5184 and y=7072. Main thread busy in thrashOnScroll.
       at /broken.html:128:28 (thrashOnScroll)
```

## Install

```bash
claude plugin marketplace add TheBiggyBang1/ScrollProof
claude plugin install scrollproof@scrollproof
```

Or load it for one session while developing: `claude --plugin-dir ./plugins/scrollproof`.

The first `/scrollproof:audit` installs its single dependency (`playwright-core`, ~14 MB). It drives your installed Chrome or Edge — no browser download — and falls back to Playwright's Chromium.

## Use

| Command | What it does |
|---|---|
| `/scrollproof:audit` | Finds your running dev server (3000, 5173, 4321, 8080…) and audits it |
| `/scrollproof:audit localhost:3000` | Audits a specific URL |
| `/scrollproof:audit :5173 --mobile --cpu 4` | 390×844 touch viewport on a 4× slower CPU (mid-range phone) |
| `/scrollproof:audit https://staging.example.com --step 300` | Denser checkpoints |

Output goes to `.scrollproof/<site>-<time>/`:

- `report.md` — findings, sorted by severity, with scroll positions and sources
- `report.html` — screenshots with the broken element outlined, frame-time-by-scroll-position chart
- `trace.json.gz` — Chrome performance trace; open in DevTools › Performance › Load profile (scroll positions appear as `sp:y=…` timings)
- `report.json` — everything, machine-readable

Add `.scrollproof/` to `.gitignore`.

### In CI

The engine is a plain CLI:

```bash
node plugins/scrollproof/engine/cli.mjs http://localhost:4173 --fail-on error
```

Exit codes: `0` ok · `1` findings at or above `--fail-on` · `2` crash · `3` URL unreachable · `4` no Playwright/browser. `--json` prints the full report to stdout.

## What it checks

| Check | Severity | How it is detected |
|---|---|---|
| `never-revealed` | error | Element on screen at every settled checkpoint, still `opacity: 0` / clipped / scaled to 0 |
| `from-conflict` | error | Two ScrollTrigger tweens own the same property and one is an immediate-render `from()`; confirmed in the browser when it vanishes on screen |
| `nondeterministic-scrub` | error | Scrubbed element differs at the same scroll position going down vs up |
| `duplicate-trigger` | error | Identical ScrollTriggers (setup ran twice without cleanup) |
| `orphaned-trigger` | error | ScrollTrigger whose trigger element left the DOM |
| `nested-scrolltrigger` | error | `scrollTrigger` on a tween inside a timeline |
| `pin-transformed-ancestor` | error | Pinned element inside an ancestor with transform/filter/contain/will-change |
| `unreachable-trigger` | error | Start position is beyond the maximum scroll |
| `stale-trigger-positions` | error/warn | Positions in use vs. a fresh `ScrollTrigger.refresh()`, counted only when the trigger's layout really moved |
| `jank` | error/warn | Frames over 2× budget during a real wheel-scroll sweep, attributed with Long Animation Frame script data |
| `forced-reflow` | error/warn | Layout/style recalculation forced from JS, with file:line from the Chrome trace |
| `layout-shift` | error/warn | Layout shifts during the sweep, ignoring ScrollTrigger pins |
| `flash-of-content` | warn | Painted visible at first contentful paint, then hidden by script |
| `horizontal-overflow` | warn | Page scrolls sideways (often an element parked off-screen to slide in) |
| `layout-property-animation` | warn | GSAP or CSS animating width/height/top/left/margin… |
| `incomplete-scrub` | warn | Scrub range ends below the bottom of the page |
| `overlapping-tweens` | warn | Two triggers drive the same property over overlapping ranges |
| `out-of-order` | warn | Pin created after triggers below it |
| `markers-left-on` | warn | `markers: true` |
| `non-passive-listener` | warn | wheel/touch listener that blocks scrolling |
| `smooth-scroll-conflict` | warn | CSS `scroll-behavior: smooth` with Lenis/Locomotive |
| `js-errors` | warn | Uncaught exceptions during the audit |

The bundled `fix-scroll-animations` skill gives Claude the root cause and fix for each check.

## How it works

1. **Instrument.** A script injected before any site code wraps `ScrollTrigger.create` (to record the call site of every trigger), observes Long Animation Frames, layout shifts and paint timing, records scroll/wheel listeners, and watches for content hidden after first paint. It never changes the site's DOM.
2. **Sweep.** Real wheel input scrolls to the bottom (smooth-scroll libraries behave as for users) while frame times and a Chrome trace are recorded.
3. **Checkpoints.** The page is visited every half viewport — down, then back up. At each stop ScrollProof waits until scrolling and all finite CSS/GSAP animations have settled, then records opacity, visibility, clipping and position of every animated element, plus a screenshot.
4. **Analyse.** Static ScrollTrigger lint, runtime state comparison, trace parsing and frame statistics turn into findings with scroll positions and sources.

GSAP is found automatically, including bundled ES-module builds (GSAP registers itself on `window`).

## Develop

```bash
npm run setup           # install demo + engine dependencies
npm run demo            # http://localhost:4173/broken.html and /clean.html
npm run audit:demo      # audit the broken demo
npm test                # end-to-end: every planted bug found, clean page scores 100
```

`demo/public/broken.html` contains one deliberate bug per check; `clean.html` does the same effects correctly and must stay at 100/100. Set `SCROLLPROOF_DEBUG=1` to also write the raw capture (`raw.json`).

```
plugins/scrollproof/
  .claude-plugin/plugin.json
  commands/audit.md                 /scrollproof:audit
  skills/fix-scroll-animations/     causes + fixes per check
  engine/
    cli.mjs                         argument parsing, summary, exit codes
    audit.mjs                       load → sweep → checkpoints → analyse
    instrument.js                   in-page probes (window.__scrollproof)
    analyze.mjs                     findings
    trace.mjs                       Chrome trace summary
    sources.mjs                     char offsets → file:line
    report/                         markdown + html
```

## Roadmap

- `prefers-reduced-motion` pass (do animations respect it?)
- Baseline comparison between runs (`--baseline`) for regression testing
- Framer Motion / Motion One state introspection
- Source-map resolution for production bundles

## License

MIT
