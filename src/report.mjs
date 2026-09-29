// Terminal table rendering. No dependency, no colour codes beyond a bold, so
// output stays readable when piped to a file.

const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
const OFF = process.stdout.isTTY ? '\x1b[0m' : '';

export const bold = (s) => `${BOLD}${s}${OFF}`;
export const dim = (s) => `${DIM}${s}${OFF}`;

const width = (s) => [...String(s ?? '')].length;

export function truncate(s, n) {
  const str = String(s ?? '');
  return width(str) <= n ? str : `${[...str].slice(0, Math.max(0, n - 1)).join('')}…`;
}

/**
 * columns: [{key, label, width, align}]
 * Widths are maxima, not fixed: a column narrower than its cap shrinks to fit.
 */
export function table(rows, columns) {
  const widths = columns.map((c) => Math.min(
    c.width ?? Infinity,
    Math.max(width(c.label), ...rows.map((r) => width(r[c.key])), 1)));

  const line = (cells) => cells
    .map((cell, i) => {
      const text = truncate(cell, widths[i]);
      const pad = ' '.repeat(Math.max(0, widths[i] - width(text)));
      return columns[i].align === 'right' ? pad + text : text + pad;
    })
    .join('  ')
    .replace(/\s+$/, '');

  const out = [bold(line(columns.map((c) => c.label))),
               dim(line(widths.map((w) => '─'.repeat(w))))];
  for (const r of rows) out.push(line(columns.map((c) => r[c.key])));
  return out.join('\n');
}

export function heading(text) {
  return `\n${bold(text)}\n${dim('═'.repeat(width(text)))}`;
}
