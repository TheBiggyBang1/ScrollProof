// Turns finding sources into "path:line:col" strings. Long-animation-frame
// entries only give a character offset, so those scripts are fetched once and
// the offset is converted to a line/column.

export async function resolveSources(context, findings) {
  const texts = new Map();
  const fetchText = async (url) => {
    if (!texts.has(url)) {
      texts.set(
        url,
        context.request
          .get(url, { timeout: 5000 })
          .then((r) => (r.ok() ? r.text() : null))
          .catch(() => null),
      );
    }
    return texts.get(url);
  };

  for (const f of findings) {
    const s = f.source;
    if (!s || !s.url) continue;
    if (s.line == null && Number.isInteger(s.char) && s.char >= 0 && /^https?:/.test(s.url)) {
      const text = await fetchText(s.url);
      const pos = text ? absoluteOffset(text, s.char, s.fn) : null;
      if (pos != null && pos < text.length) {
        const before = text.slice(0, pos);
        s.line = before.split('\n').length;
        s.col = pos - before.lastIndexOf('\n');
      }
    }
    s.display = displaySource(s);
  }
}

// For inline <script> blocks the offset is relative to the block, not the HTML
// document; pick the block where the offset lands on the named function.
function absoluteOffset(text, char, fn) {
  if (!/^\s*</.test(text)) return char;
  const starts = [];
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>/gi;
  for (let m; (m = re.exec(text)); ) starts.push(m.index + m[0].length);
  if (!starts.length) return null;
  if (fn) {
    const hit = starts.find((st) => text.slice(Math.max(0, st + char - 80), st + char + 40).includes(fn));
    if (hit != null) return hit + char;
  }
  return starts.length === 1 ? starts[0] + char : null;
}

export function displaySource(s) {
  let where = s.url;
  try {
    const u = new URL(s.url);
    where = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.hostname.endsWith('.localhost') ? u.pathname : u.href;
  } catch {
    /* keep raw url */
  }
  const pos = s.line != null ? `:${s.line}${s.col != null ? `:${s.col}` : ''}` : s.char != null ? ` (char ${s.char})` : '';
  return `${where}${pos}${s.fn ? ` (${s.fn})` : ''}`;
}
