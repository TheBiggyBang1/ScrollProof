// Launches a Chromium-based browser. We prefer the user's installed Chrome or
// Edge (no 150 MB download needed) and fall back to Playwright's Chromium.

const CHANNELS = {
  chrome: 'chrome',
  msedge: 'msedge',
  chromium: undefined,
};

export async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const err = new Error(
      'playwright-core is not installed. Run: npm install --prefix "<plugin root>" --omit=dev',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }
}

export async function launchBrowser({ browser = 'auto', headed = false }) {
  const { chromium } = await loadPlaywright();
  const order = browser === 'auto' ? ['chrome', 'msedge', 'chromium'] : [browser];
  const failures = [];
  for (const name of order) {
    if (!(name in CHANNELS)) throw new Error(`Unknown --browser "${name}" (use chrome, msedge or chromium)`);
    try {
      const instance = await chromium.launch({
        channel: CHANNELS[name],
        headless: !headed,
        args: [
          // Keep rAF and timers running at full rate even when the window is not focused.
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ],
      });
      return { instance, name, version: instance.version() };
    } catch (e) {
      failures.push(`  ${name}: ${String(e.message).split('\n')[0]}`);
    }
  }
  const err = new Error(
    `No Chromium-based browser could be launched.\n${failures.join('\n')}\n` +
      'Install Google Chrome, or run: npx playwright install chromium',
  );
  err.code = 'NO_BROWSER';
  throw err;
}
