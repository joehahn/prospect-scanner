// What the business is and wants: config/business.yml, with a way back.
//
// Seven config files are becoming two. This module is the one place that reads
// the new business file, and it has a way back: when there is no business.yml,
// it builds the same shape from the old files, so a checkout that has not
// migrated keeps working and stages can move over one at a time.
//
// The shape, whichever file it came from:
//   firm        name, url, contact_email, size, location
//   budget      outreach per month, per channel
//   you         strengths, proof_points, standing, credentials, never_claim,
//               identifying_terms
//   offers      [{ name, label?, price, unit, for, pitch, replaces? }]   live offers only (replaces: old offer ids, a bridge)
//   size        { revenue_min_usd, headcount_max, revenue_max_usd }
//   where       { countries, home_metro, home_metro_towns, home_region }
//   targets     [{ name, label?, description, examples, where?, size?, replaces? }]  (replaces: old thesis ids, a bridge)
//   events      [{ name, description, counts_for_days?, does_not_count?, searched_in? }]
//               (searched_in: web, for an event found in what people write and say
//               themselves; news, the default, for one found in reporting)
//   label: a short name for a filter chip; the name is used everywhere else
//   where.kinds: firm kinds (staffing, investor, ...) a target is limited to; a
//               firm of that kind is filed under it and gets its size band
//   seats:      titles worth writing to at the target's firms (npm run firms)
//   specialty:  what a firm's own site must say it does to be admitted (npm run firms)
//
// Nothing about any particular operator is written here; see CLAUDE.md.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config');
export const BUSINESS_PATH = resolve(CONFIG_DIR, 'business.yml');

const clean = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();

/** The raw business.yml, or null when it does not exist. Throws on a malformed one. */
export function readBusinessFile(path = BUSINESS_PATH) {
  if (!existsSync(path)) return null;
  const doc = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  const bad = [];
  if (!doc.firm?.name) bad.push('firm.name is required');
  if (!Array.isArray(doc.offers) || !doc.offers.length) bad.push('offers: at least one is required');
  for (const [i, o] of (doc.offers ?? []).entries()) {
    if (!o?.name) bad.push(`offers[${i}].name is required`);
    if (o?.price == null) bad.push(`offers[${i}].price is required (a number)`);
  }
  for (const [i, t] of (doc.targets ?? []).entries()) {
    if (!t?.name || !t?.description) bad.push(`targets[${i}] needs a name and a description`);
  }
  if (bad.length) throw new Error(`${path} is invalid:\n  - ${bad.join('\n  - ')}`);
  return doc;
}

/** Built from the old files, for a checkout without business.yml. */
function fromOldConfig(cfg, targeting) {
  const pitch = Object.fromEntries((cfg.buyers ?? []).map((b) => [b.id, clean(b.buyer_problem)]));
  const icp = cfg.icp ?? {};
  return {
    firm: cfg.firm ?? {},
    budget: cfg.outreach_budget_per_month ?? {},
    you: cfg.operator ?? {},
    offers: (cfg.packages ?? []).filter((p) => (p.status ?? 'live') !== 'retired').map((p) => ({
      name: p.name ?? p.id,
      price: p.price_usd ?? p.price_usd_month ?? p.rate_usd_hour,
      unit: p.rate_usd_hour ? 'per hour' : p.price_usd_month ? 'per month' : (p.duration ?? 'fixed'),
      for: clean(p.best_for), pitch: pitch[p.buyer] || null, replaces: [p.id],
    })),
    size: { revenue_min_usd: icp.revenue_floor_usd, headcount_max: icp.headcount_ceiling,
            revenue_max_usd: icp.revenue_ceiling_usd },
    where: { countries: icp.geography, home_metro: icp.home_metro_label,
             home_metro_towns: icp.home_metros, home_region: icp.home_region_label },
    targets: ((targeting?.live ?? targeting?.verticals) ?? []).map((v) => ({
      name: v.name ?? v.id, description: clean(v.thesis), examples: [], replaces: [v.id] })),
    events: (cfg.triggers ?? []).filter((t) => !t.orphaned).map((t) => ({
      name: String(t.id).replace(/_/g, ' '), description: clean(t.description),
      counts_for_days: t.decay_days, does_not_count: t.not ?? [] })),
    _source: 'old config files',
  };
}

/**
 * The business, from business.yml when it exists, otherwise from the old files.
 * `targeting` is only needed for the fallback.
 */
export function loadBusiness(cfg, targeting = null, { path = BUSINESS_PATH } = {}) {
  const doc = readBusinessFile(path);
  if (!doc) return fromOldConfig(cfg, targeting);
  return {
    firm: doc.firm,
    budget: doc.outreach_budget_per_month ?? {},
    you: doc.you ?? {},
    offers: doc.offers.map((o) => ({ ...o, for: clean(o.for), pitch: o.pitch ? clean(o.pitch) : null })),
    size: doc.size ?? {},
    where: doc.where ?? {},
    targets: (doc.targets ?? []).map((t) => ({ ...t, description: clean(t.description), examples: t.examples ?? [] })),
    events: doc.events ?? [],
    _source: path.slice(path.indexOf('config/')),
  };
}

/**
 * Lay business.yml over the old config for the settings that have moved, so
 * every stage still reading `cfg` sees the operator's edits. Only settings
 * whose shape did not change are laid over; the rest move stage by stage.
 */
export function overlayBusiness(cfg) {
  const doc = readBusinessFile();
  if (!doc) return cfg;
  if (doc.firm) cfg.firm = { ...(cfg.firm ?? {}), ...doc.firm };
  if (doc.you) cfg.operator = doc.you;
  if (doc.outreach_budget_per_month) cfg.outreach_budget_per_month = doc.outreach_budget_per_month;
  cfg._business = 'config/business.yml';
  return cfg;
}

/**
 * The operator as the judge sees it: every offer with its price, who it is for
 * and its pitch, and every target with its examples. One function, so the
 * judge and the tests render the same text -- and the test can show that a
 * fictional business renders without a word of anyone else's.
 */
export function describeForJudge(b) {
  const offers = (b.offers ?? []).map((o) => {
    const price = o.price != null ? `$${Number(o.price).toLocaleString('en-US')}${o.unit ? ` ${o.unit}` : ''}` : 'price not set';
    return `- ${o.name}: ${price}${o.for ? ` — for ${o.for}` : ''}${o.pitch ? `\n    Pitch: ${o.pitch}` : ''}`;
  });
  const targets = (b.targets ?? []).map((t) => `- ${t.name}: ${t.description}`
    + (t.examples?.length ? `\n    e.g. ${t.examples.slice(0, 3).join('; ')}` : ''));
  return ['## The operator', 'Offers:', ...offers, '', 'The kinds of client they look for:', ...targets].join('\n');
}

/** Whether a title is one of a target's `seats`, matched as words anywhere in it. */
export function inSeat(target, title) {
  const seats = target?.seats ?? [];
  if (!seats.length || !title) return false;
  return new RegExp(`\\b(${seats.map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')).join('|')})`, 'i').test(title);
}

/** A short stable id for a target, from its name, for page files and filters. */
export const targetId = (t) => String(t.name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .slice(0, 4).join('-');

const ALIASES = { 'united arab emirates': ['uae'], 'saudi arabia': ['ksa'] };
/** Whether a location string (countries and headquarters, joined) names one of `countries`. */
export function inCountries(here, countries = []) {
  const h = String(here).toLowerCase();
  return countries.some((c) => {
    const k = String(c).toLowerCase();
    return h.includes(k) || (ALIASES[k] ?? []).some((a) => new RegExp(`\\b${a}\\b`).test(h));
  });
}

/**
 * Which of the business's targets each person sits under. The judge's recorded
 * target wins when there is one. Otherwise the firm's old theses, through each
 * target's `replaces:` list (`thesis` or `thesis:kind`), plus any target whose
 * `where.countries` the firm is located in. A bridge: firms were filed under
 * the old theses, and nothing refiles them until the old ranker retires.
 */
export function targetsOfPeople(db, business) {
  const targets = (business.targets ?? []).map((t) => ({ ...t, id: targetId(t) }));
  const byName = new Map(targets.map((t) => [t.name.toLowerCase(), t.id]));
  const has = (t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const orgs = new Map();
  const add = (org, id) => { if (!orgs.has(org)) orgs.set(org, new Set()); orgs.get(org).add(id); };
  if (has('org_verticals')) {
    for (const r of db.prepare(`SELECT ov.org_id, ov.vertical_id, o.kind FROM org_verticals ov
        JOIN orgs o ON o.id = ov.org_id`).all()) {
      for (const t of targets) {
        if ((t.replaces ?? []).some((x) => { const [v, k] = String(x).split(':');
          return v === r.vertical_id && (!k || k === r.kind); })) add(r.org_id, t.id);
      }
    }
  }
  const placed = targets.filter((t) => t.where?.countries?.length);
  if (placed.length) {
    for (const o of db.prepare(`SELECT o.id, COALESCE(o.hq, '') || ' | ' || COALESCE((SELECT group_concat(DISTINCT
        country) FROM people p WHERE p.org_id = o.id), '') here FROM orgs o`).all()) {
      for (const t of placed) if (inCountries(o.here, t.where.countries)) add(o.id, t.id);
    }
  }
  for (const t of targets.filter((x) => x.where?.kinds?.length)) {
    for (const o of db.prepare(`SELECT id FROM orgs WHERE kind IN (${t.where.kinds.map(() => '?').join(',')})`)
      .all(...t.where.kinds)) add(o.id, t.id);
  }
  const judged = new Map();
  if (has('judgments')) {
    for (const r of db.prepare(`SELECT person_id, target FROM judgments WHERE target IS NOT NULL
        ORDER BY id`).all()) {
      const id = byName.get(String(r.target).toLowerCase());
      if (id) judged.set(r.person_id, id);
    }
  }
  return {
    targets,
    of: (personId, orgId) => (judged.has(personId) ? [judged.get(personId)] : [...(orgs.get(orgId) ?? [])]),
    ofOrg: (orgId) => [...(orgs.get(orgId) ?? [])],
  };
}
