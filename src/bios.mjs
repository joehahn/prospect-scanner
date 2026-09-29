// Bios, board seats and portfolios, from a firm's own website.
//
// The site reader (enrich) kept names and titles from a team page and threw the
// bios away. For an investment firm the bio is the useful part: a partner's
// board seats say which companies they oversee, which is what the "PE
// operating partners" target is about: one relationship, several companies.
// The operator found this by pasting one partner's bio by hand (2026-09-28).
//
// For each firm: read its team page, follow each named person's bio link, read
// the bio; for an investment firm, read its portfolio page too. One cheap call
// per bio (prompts/read-bios.md) returns the bio, board seats and committees.
// Stored as sourced evidence on the person. Current portfolio companies enter
// the book as firms (kind unset, so nothing ranks them until they are vetted),
// linked to the investor and to the partner on their board.
//
// Own site only, robots.txt respected. A browser is used only where the team
// page is built in the browser, the plain fetch having already cleared
// robots.txt, and the run says so. Never LinkedIn.
//
// Usage:
//   npm run bios -- --org capstreet [--org gennx360_capital_partners]
//   npm run bios -- --investors [--limit 20]   every investment firm with a website
//   npm run bios -- --org <id> --dry           find the pages, spend nothing

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { fetchPage, extractText } from './sources/web.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/read-bios.md';
const PERSON = { type: 'object', additionalProperties: false,
  required: ['is_bio', 'bio', 'board_seats_current', 'board_seats_past', 'committees'],
  properties: { is_bio: { type: 'boolean' }, bio: { type: 'string' }, board_seats_current: { type: 'array', items: { type: 'string' } },
    board_seats_past: { type: 'array', items: { type: 'string' } }, committees: { type: 'array', items: { type: 'string' } } } };
const PORTFOLIO = { type: 'object', additionalProperties: false, required: ['companies'],
  properties: { companies: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['name', 'status', 'what', 'website'], properties: { name: { type: 'string' },
      status: { type: 'string', enum: ['current', 'exited', 'unknown'] }, what: { type: 'string' }, website: { type: 'string' } } } } } };

const argv = process.argv.slice(2);
const orgArgs = argv.flatMap((a, i) => (a === '--org' ? [argv[i + 1]] : []));
const dry = argv.includes('--dry');
const limit = Number(argv[argv.indexOf('--limit') + 1]) || 20;

const db = openDb();
const cfg = loadConfig();
const model = cfg.models?.cheap;
const system = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');
db.exec(`CREATE TABLE IF NOT EXISTS holdings (
    investor_id TEXT NOT NULL REFERENCES orgs(id), company_id TEXT NOT NULL REFERENCES orgs(id),
    status TEXT NOT NULL, source_url TEXT NOT NULL, first_seen TEXT NOT NULL,
    PRIMARY KEY (investor_id, company_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS board_seats (
    person_id TEXT NOT NULL REFERENCES people(id), company TEXT NOT NULL,
    company_id TEXT REFERENCES orgs(id), status TEXT NOT NULL, source_url TEXT NOT NULL,
    first_seen TEXT NOT NULL, PRIMARY KEY (person_id, company))`);

const orgs = orgArgs.length
  ? orgArgs.map((id) => db.prepare('SELECT * FROM orgs WHERE id = ?').get(id)).filter(Boolean)
  : argv.includes('--investors')
    ? db.prepare(`SELECT * FROM orgs WHERE kind = 'investor' AND domain IS NOT NULL AND domain <> ''
        AND id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')
        AND id NOT IN (SELECT DISTINCT org_id FROM evidence WHERE kind = 'staff_bio') ORDER BY name LIMIT ?`).all(limit)
    : [];
if (!orgs.length) { console.log('Nothing to read. Pass --org <id> or --investors.'); process.exit(0); }

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function links(html, base) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    let u; try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.href) !== hostOf(base)) continue;
    out.push({ url: u.href, text: extractText(m[2]).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const browserUsed = [];
// A team page built in the browser comes back from a plain fetch as a near-empty
// shell. The fetch having succeeded means robots.txt allowed it; only then is a
// browser used, and the run records it (CLAUDE.md).
async function read(url, { expectLinks = false } = {}) {
  let r = await fetchPage(url);
  if (r.ok && expectLinks && links(r.html, r.url).length < 12 && (r.text ?? '').length < 3000) {
    const { fetchPageWithBrowser } = await import('./sources/browser.mjs');
    const b = await fetchPageWithBrowser(url);
    if (b.ok) {
      browserUsed.push(hostOf(url));
      r = { ok: true, url: b.finalUrl ?? url, html: b.text, text: extractText(b.text), viaBrowser: true };
    }
  }
  return r;
}

const runId = dry ? null : startRun(db, 'bios', { model });
const now = new Date().toISOString();
const today = now.slice(0, 10);
const insEv = db.prepare(`INSERT OR IGNORE INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
    VALUES (?, ?, ?, ?, ?, ?, 'retrieved', ?)`);
const tally = { bios: 0, seats: 0, companies: 0, newFirms: 0 };

for (const org of orgs) {
  const base = `https://${String(org.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  console.log(heading(`${org.name} · ${base}`));
  const home = await read(base, { expectLinks: true });
  if (!home.ok) { console.log(dim(`  unreachable: ${home.error ?? home.status}`)); continue; }
  // The team page: stored ones first, then links and guesses.
  const stored = db.prepare(`SELECT source_url FROM evidence WHERE org_id = ? AND kind = 'web_page'`).all(org.id).map((r) => r.source_url);
  const guess = ['/team', '/our-team', '/people', '/leadership', '/about/team', '/who-we-are'].map((p) => base + p);
  const teamCands = [...new Set([...stored, ...links(home.html, home.url).map((l) => l.url), ...guess]
    // A path SEGMENT that names a team page, not any path containing the word:
    // "/news-article/...-private-equity-firms-for-executives" is not one.
    .filter((u) => /(^|\/)(team|our-team|the-team|people|our-people|leadership|leadership-team|who-we-are|partners|professionals)(\/|$)/i
      .test(new URL(u).pathname)))].slice(0, 4);
  const people = db.prepare('SELECT id, name, title FROM people WHERE org_id = ?').all(org.id);
  const bioLinks = new Map();
  for (const u of teamCands) {
    const t = await read(u, { expectLinks: true });
    if (!t.ok) continue;
    for (const l of links(t.html, t.url)) {
      if (l.url.replace(/\/$/, '') === u.replace(/\/$/, '')) continue;
      const p = people.find((x) => {
        const n = norm(x.name); const parts = String(x.name).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        const slug = new URL(l.url).pathname.toLowerCase();
        return (n.length > 5 && norm(l.text).startsWith(n))
          || (parts.length >= 2 && slug.includes(parts[0].replace(/[^a-z]/g, '')) && slug.includes(parts[parts.length - 1].replace(/[^a-z]/g, '')));
      });
      if (p && !bioLinks.has(p.id)) bioLinks.set(p.id, { ...p, url: l.url });
    }
    if (bioLinks.size) break;
  }
  // NO LINKS, BUT BIO PAGES ALL THE SAME. Some team pages open each bio on a
  // click with no link to follow (the page is built in the browser), while the
  // bio has its own address all the same. Try the usual shapes on one person;
  // the first that returns a page naming them is used for everyone.
  if (!bioLinks.size && people.length) {
    const slugOf = (n) => String(n).toLowerCase().normalize('NFKD').replace(/[^a-z\s-]/g, '').trim().split(/\s+/).join('-');
    const shapes = ['/team-info/', '/team/', '/people/', '/our-team/', '/bio/', '/team-member/'];
    const probe = people.filter((x) => String(x.name).split(/\s+/).length === 2).slice(0, 2);
    let shape = null;
    for (const sh of shapes) {
      for (const x of probe) {
        const r = await read(base + sh + slugOf(x.name), { expectLinks: true });
        const last = String(x.name).split(/\s+/).pop();
        if (r.ok && new RegExp(last, 'i').test(r.text ?? '') && (r.text ?? '').length > 600) { shape = sh; break; }
      }
      if (shape) break;
    }
    if (shape) for (const x of people) bioLinks.set(x.id, { ...x, url: base + shape + slugOf(x.name), guessed: true });
    console.log(dim(`  no bio links on the team page; ${shape ? `bio pages found at ${base}${shape}<name>` : 'no bio page shape found either'}`));
  }
  console.log(dim(`  team page: ${teamCands[0] ?? 'none found'} · ${bioLinks.size} bio link(s) matched to ${people.length} people on file`));

  // Portfolio page, for an investment firm.
  let portfolio = null;
  if (org.kind === 'investor') {
    // A portfolio page by its ADDRESS: a path segment that names one, and not
    // an article whose title happens to contain "investments" or "companies".
    const cands = [...new Set([...links(home.html, home.url).map((l) => l.url),
      ...['/portfolio', '/our-companies', '/companies', '/investments', '/our-portfolio'].map((p) => base + p)]
      .filter((u) => { const path = new URL(u).pathname;
        return /(^|\/)(portfolio|our-portfolio|companies|our-companies|investments|current-investments)(\/|$)/i.test(path)
          && !/(^|\/)(news|insights|blog|press|articles?|stories)(\/|$)/i.test(path) && !/[?]/.test(u); }))];
    for (const u of cands.slice(0, 4)) {
      const r = await read(u, { expectLinks: true });
      if (r.ok && (r.text ?? '').length > 400) { portfolio = r; break; }
    }
    console.log(dim(`  portfolio page: ${portfolio?.url ?? 'none found'}`));
  }
  if (dry) { for (const b of bioLinks.values()) console.log(`    ${b.name} · ${b.url}`); continue; }

  // Bios, one cheap call each.
  for (const p of bioLinks.values()) {
    const page = await read(p.url, { expectLinks: Boolean(p.guessed) });
    if (!page.ok) continue;
    // A guessed address must turn out to be THIS person's page: it names them,
    // and it does not name a crowd of colleagues. A site that serves its whole
    // team list at every /team-info/<name> address (the bio loaded by script)
    // passed the first test and stored each title with the firm's boilerplate
    // as a "bio". Checked on every page, linked or guessed.
    const t = page.text ?? '';
    const lastOf = (n) => String(n).split(/\s+/).pop();
    if (!new RegExp(lastOf(p.name), 'i').test(t)) continue;
    const others = people.filter((x) => x.id !== p.id && lastOf(x.name).length > 3
      && new RegExp(`\\b${lastOf(x.name)}\\b`, 'i').test(t)).length;
    // A team list names most of the firm; a bio may name a few colleagues it
    // works with (a deal team), and those were wrongly thrown away at > 3.
    if (others >= 8 && others >= 0.6 * (people.length - 1)) {
      console.log(dim(`  ${p.name}: the page names ${others} of ${people.length - 1} colleagues, so it is a team list, not a bio; skipped`));
      continue;
    }
    const text = (page.text ?? '').slice(0, 5000);
    const res = await complete(db, runId, { model, system, schema: PERSON, effort: 'low', thinking: false, maxTokens: 800,
      messages: [{ role: 'user', content: `## Firm\n${org.name}\n\n## Bio page of ${p.name} (${p.title ?? ''})\n${page.url}\n\n${text}` }] });
    const d = res.data;
    // Not a bio: the model says so rather than writing "no details on this page"
    // as if it were one (read-bios v3).
    if (!d?.bio || d.is_bio === false) continue;
    db.transaction(() => {
      db.prepare(`DELETE FROM evidence WHERE person_id = ? AND kind IN ('staff_bio', 'board_seats') AND source_url = ?`).run(p.id, page.url);
      insEv.run(org.id, p.id, 'staff_bio', d.bio, page.url, now, text);
      const cur = d.board_seats_current ?? []; const past = d.board_seats_past ?? [];
      if (cur.length || past.length || d.committees?.length) {
        insEv.run(org.id, p.id, 'board_seats', [
          cur.length ? `Sits on the boards of ${cur.join(', ')}` : '',
          past.length ? `previously ${past.join(', ')}` : '',
          d.committees?.length ? `member of the ${d.committees.join(', ')}` : '',
        ].filter(Boolean).join('; ') + '.', page.url, now, null);
      }
      for (const [list, status] of [[cur, 'current'], [past, 'past']]) {
        for (const c of list) {
          db.prepare(`INSERT OR REPLACE INTO board_seats (person_id, company, status, source_url, first_seen)
              VALUES (?, ?, ?, ?, COALESCE((SELECT first_seen FROM board_seats WHERE person_id = ? AND company = ?), ?))`)
            .run(p.id, c, status, page.url, p.id, c, today);
          tally.seats++;
        }
      }
    })();
    tally.bios++;
    console.log(`  ${bold(p.name)} ${dim(`· ${d.bio.slice(0, 90)}${(d.board_seats_current ?? []).length ? ` · boards: ${d.board_seats_current.join(', ')}` : ''}`)}`);
  }

  // The portfolio: current companies into the book, linked to the investor.
  if (portfolio) {
    const res = await complete(db, runId, { model, system, schema: PORTFOLIO, effort: 'low', thinking: false, maxTokens: 4000,
      messages: [{ role: 'user', content: `## Firm\n${org.name}\n\n## Portfolio page\n${portfolio.url}\n\n${(portfolio.text ?? '').slice(0, 12000)}` }] });
    const all = db.prepare('SELECT id, name FROM orgs').all();
    const findOrg = (n) => { const k = norm(n); return k.length > 3 ? all.find((o) => norm(o.name) === k) : null; };
    for (const c of res.data?.companies ?? []) {
      if (c.status === 'exited') continue;
      let cid = findOrg(c.name)?.id;
      if (!cid) {
        cid = slugify(c.name);
        const dom = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.website ?? '') ? c.website.toLowerCase().replace(/^www\./, '') : null;
        const n = db.prepare(`INSERT OR IGNORE INTO orgs (id, name, domain, first_seen, source, seeded) VALUES (?, ?, ?, ?, ?, 0)`)
          .run(cid, c.name, dom, today, `portfolio of ${org.name}`).changes;
        tally.newFirms += n;
        all.push({ id: cid, name: c.name });
      }
      db.prepare(`INSERT OR IGNORE INTO holdings (investor_id, company_id, status, source_url, first_seen) VALUES (?, ?, ?, ?, ?)`)
        .run(org.id, cid, c.status, portfolio.url, today);
      insEv.run(cid, null, 'ownership', `${org.name} lists ${c.name} in its portfolio${c.status === 'current' ? ' as current' : ''}${c.what ? ` (${c.what})` : ''}`,
        portfolio.url, now, null);
      tally.companies++;
    }
    // Board seats name companies; link each to the firm now in the book.
    for (const s of db.prepare(`SELECT b.rowid, b.company FROM board_seats b JOIN people p ON p.id = b.person_id
        WHERE p.org_id = ? AND b.company_id IS NULL`).all(org.id)) {
      const hit = findOrg(s.company);
      if (hit) db.prepare('UPDATE board_seats SET company_id = ? WHERE rowid = ?').run(hit.id, s.rowid);
    }
    // A current board seat is the firm's own word that it still owns the company;
    // a company named only as a past seat has been sold.
    db.prepare(`UPDATE holdings SET status = 'current' WHERE investor_id = ? AND company_id IN
        (SELECT b.company_id FROM board_seats b JOIN people p ON p.id = b.person_id WHERE p.org_id = ? AND b.status = 'current')`).run(org.id, org.id);
    db.prepare(`UPDATE holdings SET status = 'exited' WHERE investor_id = ? AND status <> 'current' AND company_id IN
        (SELECT b.company_id FROM board_seats b JOIN people p ON p.id = b.person_id WHERE p.org_id = ? AND b.status = 'past')`).run(org.id, org.id);
    const cs = res.data?.companies ?? [];
    console.log(dim(`  ${cs.filter((c) => c.status !== 'exited').length} portfolio companies listed, `
      + `${cs.filter((c) => c.status === 'current').length} marked current by the page`));
  }
}

if (!dry) {
  finishRun(db, runId, { notes: browserUsed.length ? `browser needed for: ${[...new Set(browserUsed)].join(', ')}` : null });
  const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM runs WHERE id = ?').get(runId)?.c ?? 0;
  console.log(heading(`${tally.bios} bio(s) · ${tally.seats} board seat(s) · ${tally.companies} portfolio companies (${tally.newFirms} new to the book) · $${cost}`
    + (browserUsed.length ? ` · browser needed for ${[...new Set(browserUsed)].join(', ')}` : '')));
}
