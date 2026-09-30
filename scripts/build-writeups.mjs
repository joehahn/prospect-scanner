/**
 * THE WRITE-UPS AS WEB PAGES: docs/writeups/<name>.md -> docs/writeups/<name>.html
 *
 * A write-up is the one-page story a LinkedIn post links to. The Markdown is the
 * source and GitHub renders it; this renders the same file as a standalone page
 * for GitHub Pages, so a reader arriving cold gets a clean article rather than a
 * repository view. One source, two renderings, so the two cannot tell different
 * stories.
 *
 * Handles only what the write-ups use: headings, paragraphs, lists, tables,
 * bold, italic, links, inline code and images. An .svg image is inlined, so its
 * hover titles and its dark-mode styles work on the page. A relative link to a
 * Markdown file elsewhere in the repo points at that file on GitHub, which is
 * where it renders.
 *
 * Nothing about any author is written here: the byline is in each write-up.
 *
 *   node scripts/build-writeups.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'docs/writeups');

// The repo's page on GitHub, from the checkout's own remote.
const REPO = (() => {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/](.+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
})();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function href(link) {
  if (/^[a-z]+:/i.test(link) || link.startsWith('#')) return link;
  if (link.endsWith('.md') && REPO) {
    const target = relative(ROOT, resolve(DIR, link));
    return `${REPO}/blob/main/${target}`;
  }
  return link;
}

function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, link) => `<a href="${href(link)}">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  return s;
}

function image(alt, src) {
  const file = resolve(DIR, src);
  if (src.endsWith('.svg') && existsSync(file)) {
    return `<figure>${readFileSync(file, 'utf8').replace(/<\?xml[^>]*>/, '')}</figure>`;
  }
  return `<figure><img src="${src}" alt="${esc(alt)}"></figure>`;
}

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const img = ln.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    const h = ln.match(/^(#{1,3})\s+(.*)$/);
    const li = ln.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!ln.trim()) { flush(); continue; }
    if (img) { flush(); out.push(image(img[1], img[2])); continue; }
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (ln.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${body}</tbody></table>`);
      continue;
    }
    if (li && !li[1]) {
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(li[3]);
      continue;
    }
    if (list && /^\s+\S/.test(ln)) { list.items[list.items.length - 1] += ` ${ln.trim()}`; continue; }
    if (list) flush();
    para.push(ln.trim());
  }
  flush();
  return out.join('\n');
}

const CSS = `
:root{--surface:#fcfcfb;--text:#0b0b0b;--text2:#52514e;--line:#e6e5e1;--link:#1c5cab}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--surface:#1a1a19;--text:#fff;--text2:#c3c2b7;--line:#33322f;--link:#86b6ef}}
:root[data-theme="dark"]{--surface:#1a1a19;--text:#fff;--text2:#c3c2b7;--line:#33322f;--link:#86b6ef}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:1.9rem;line-height:1.25;margin:0 0 .4rem}
h2{font-size:1.25rem;margin:2.2rem 0 .6rem}
p,li{color:var(--text)}
main>p:first-of-type{color:var(--text2);margin-top:0}
a{color:var(--link)}
code{font-size:.9em;background:var(--line);padding:1px 5px;border-radius:4px}
figure{margin:1.6rem 0;overflow-x:auto}figure svg,figure img{width:100%;min-width:520px;height:auto;display:block}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.95rem}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
th{color:var(--text2);font-weight:600}
`;

function page(md, name) {
  const title = (md.match(/^#\s+(.*)$/m) ?? [])[1] ?? name;
  const lead = md.split('\n\n').find((b) => b.trim() && !b.startsWith('#') && !b.startsWith('*'))
    ?.replace(/\s+/g, ' ').replace(/[*`]/g, '').trim() ?? '';
  const plain = (s) => esc(s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, ''));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${plain(title)}</title>
<meta name="description" content="${plain(lead)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${plain(title)}">
<meta property="og:description" content="${plain(lead)}">
<meta name="twitter:card" content="summary">
<style>${CSS}</style></head>
<body><main>
${render(md)}
</main></body></html>
`;
}

const built = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.md'))) {
  const md = readFileSync(join(DIR, f), 'utf8');
  const out = join(DIR, f.replace(/\.md$/, '.html'));
  writeFileSync(out, page(md, f));
  built.push(relative(ROOT, out));
}
console.log(built.length ? `wrote ${built.join(', ')}` : 'no write-ups in docs/writeups');
