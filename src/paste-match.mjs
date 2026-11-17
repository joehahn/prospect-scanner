// What a pasted LinkedIn page says about whose page it is, and the fields
// near the subject's name, used by the paste server (inbox.mjs). Nothing here
// fetches linkedin.com: it reads text a person copied.
import { nameKey, sameName, headerName, firmOnPage, firmShare, ownPart } from './profile-identity.mjs';

// THE DEGREE AND THE FOLLOWER COUNT ARE ALREADY IN THE PASTE, and the first
// version of this form made the operator retype them into dropdowns. He asked
// whether they had been captured; they had not, and the text said "· 3rd" eight
// times.
//
// EIGHT TIMES IS THE WHOLE DIFFICULTY. A LinkedIn copy carries the subject's
// degree AND every degree in the "More profiles for you" and "People you may
// know" rails, so the naive first-match or most-common reading picks a
// stranger's. The subject's own sits a few characters after their name, before
// any rail exists, so both are read FROM THE NAME FORWARD and only within a
// short window. Outside that window they are left unset, because an unset field
// is honest and a wrong degree quietly changes what the ranker thinks is
// reachable.
export function fieldsNear(text, name) {
  const t = String(text);
  // OUTSIDE YOUR NETWORK LINKEDIN SHOWS "Frantz F.", not the full name, so the
  // header was never found and the model's own reading of the degree (wrong,
  // "1st") stood in for "· 3rd". The first name and surname initial is tried next.
  let at = name ? t.toLowerCase().indexOf(String(name).toLowerCase()) : -1;
  if (at < 0 && name) {
    const w = String(name).trim().split(/\s+/);
    if (w.length > 1) at = t.toLowerCase().indexOf(`${w[0]} ${w[w.length - 1][0]}.`.toLowerCase());
  }
  if (at < 0) return {};
  const win = t.slice(at, at + 900);              // the header block, not the rails
  const out = {};

  const deg = win.match(/·\s*([123])(?:st|nd|rd)\b/);
  if (deg) out.degree = deg[1];

  // FOLLOWERS HANG OFF THE "Activity" HEADING, not off the name. On one real
  // paste three counts appeared: the subject's 2,696 just after Activity, and
  // 8,163 and 9,950 belonging to company pages in the "Pages for you" rail at
  // the very bottom. Anchoring to the heading picks the person's; anchoring to
  // the name or to the largest number picks a software vendor's.
  const act = t.indexOf('Activity', at);
  if (act > 0) {
    const fol = t.slice(act, act + 200).match(/([\d,]{3,})\s+followers/i);
    if (fol) out.followers = fol[1].replace(/,/g, '');
  }

  // LOCATION sits between the headline and "Contact info", on its own line, and
  // is the only line in the header shaped like a place. Taken only from the
  // header block, because the rails are full of other people's cities.
  const head = win.slice(0, win.indexOf('Contact info') + 1 || 600);
  const loc = head.split('\n').map((l) => l.trim())
    .find((l) => /^[A-Z][\w .'-]+(?:,\s*[A-Z][\w .'-]+){1,3}$/.test(l)
      && /(United States|United Kingdom|Canada|Australia|Ireland|Bermuda|Area|Metropolitan)/i.test(l));
  if (loc) {
    out.location = loc;
    const parts = loc.split(',').map((x) => x.trim());
    if (parts.length > 1) out.country = parts[parts.length - 1];
  } else {
    // A METRO WITH NO COUNTRY (2026-10-31): "Greater Paris Metropolitan Region",
    // "Detroit Metropolitan Area". Kept as the location; the country only where
    // the city settles it, so a card can say a Paris profile is abroad.
    const metro = head.split('\n').map((l) => l.trim())
      .find((l) => /^(Greater\s+)?[A-Z][\w .'-]+\s+(Metropolitan\s+)?(Area|Region)$/.test(l));
    if (metro) {
      out.location = metro;
      const city = Object.keys(METRO_COUNTRY).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(metro));
      if (city) out.country = METRO_COUNTRY[city];
    }
  }

  // ACTIVITY FROM HOW OLD THE POSTS ARE, which is the only honest source for it.
  // LinkedIn stamps each item "1w", "3mo", "2yr", and says "has no recent posts"
  // when there are none. The freshest one decides. Guessing this wrong changes
  // what the ranker believes about reachability, so an unreadable feed yields
  // NOTHING rather than a default.
  //
  // THE AGE SITS ON EITHER SIDE OF THE BULLET, and the first version only read
  // one. One real profile stamps its items "• \n 1w"; another stamps them
  // "1mo • Edited", and that second one came back with activity UNSET while
  // every other field filled. So the token is matched on its own line with an
  // optional bullet before or after, rather than anchored to the bullet.
  //
  // WORTH KNOWING WHEN READING THE RESULT: on a feed of RESHARES the timestamp
  // belongs to the post being reshared, not to the act of resharing. That makes
  // this a lower bound on how recently someone touched LinkedIn, which is the
  // safe direction to be wrong in for a reachability signal.
  const AGE = /(?:^|\n)[ \t]*(?:•[ \t]*\n?[ \t]*)?(\d{1,2})\s*(d|w|mo|yr)\b[ \t]*(?:•|$|\n)/gm;
  if (/no recent posts/i.test(t)) out.activity = 'dormant';
  else if (act > 0) {
    const ages = [...t.slice(act, act + 9000).matchAll(AGE)]
      .map((m) => Number(m[1]) * ({ d: 1, w: 7, mo: 30, yr: 365 }[m[2]]));
    if (ages.length) {
      const freshest = Math.min(...ages);
      out.activity = freshest <= 14 ? 'high' : freshest <= 60 ? 'active'
        : freshest <= 365 ? 'low' : 'dormant';
    }
  }
  return out;
}

// Metros LinkedIn prints without a country, by the country they settle.
const METRO_COUNTRY = { Paris: 'France', Lyon: 'France', London: 'United Kingdom', Manchester: 'United Kingdom',
  Frankfurt: 'Germany', Munich: 'Germany', Berlin: 'Germany', Hamburg: 'Germany', Milan: 'Italy', Rome: 'Italy',
  Madrid: 'Spain', Barcelona: 'Spain', Amsterdam: 'Netherlands', Zurich: 'Switzerland', Geneva: 'Switzerland',
  Stockholm: 'Sweden', Oslo: 'Norway', Copenhagen: 'Denmark', Helsinki: 'Finland', Dublin: 'Ireland',
  Toronto: 'Canada', Montreal: 'Canada', Vancouver: 'Canada', Dubai: 'United Arab Emirates', Singapore: 'Singapore',
  Sydney: 'Australia', Detroit: 'United States', Chicago: 'United States', Boston: 'United States',
  Dallas: 'United States', Houston: 'United States', Austin: 'United States', Atlanta: 'United States',
  Seattle: 'United States', Denver: 'United States', Phoenix: 'United States', Philadelphia: 'United States',
  'New York': 'United States', 'Los Angeles': 'United States', 'San Francisco': 'United States',
  'Washington DC': 'United States', Minneapolis: 'United States', Miami: 'United States', Charlotte: 'United States' };

/** Pull a linkedin.com/in/ URL out of pasted text. Nothing fetches it. */
export function urlFrom(text) {
  const m = String(text).match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s"'<>)]+/i);
  return m ? m[0].replace(/[.,;]$/, '') : '';
}

// THE NAME IS THE FIRST LINE THAT IS A NAME. A LinkedIn copy-paste opens with
// the URL, then the nav chrome, then the person. Matching against the book
// rather than guessing at structure is what makes this reliable across the
// layout changes that have already broken two parsers in this project.
//
// THE HEADER FIRST (2026-10-29). The page names its subject once, on the line
// just above their degree ("Jane Q. Doe" then "· 2nd"), and that line is not
// always the name on file: "Dr. Jane Doe" is "Jane Doe" on the page, so
// the scan below found a commenter instead. Where the header is there, it alone
// decides, on first name and surname; a header that matches no one, or two,
// is a refusal, never a fall back to some other name on the page.
export function matchPerson(db, text) {
  const head = nameKey(headerName(text));
  if (head) {
    const all = db.prepare(`SELECT p.id, p.name, p.title, o.name org
      FROM people p LEFT JOIN orgs o ON o.id = p.org_id`).all();
    const loose = all.filter((r) => sameName(head, r.name));
    // AN EXACT FIRST NAME OUTRANKS A NICKNAME MATCH (2026-10-31). sameName lets
    // "Kathy" find "Katherine" on three shared letters, which also matched two
    // different first names sharing their first three; where the page's first
    // name is someone's own, it is theirs.
    const exact = loose.filter((r) => nameKey(r.name)?.first === head.first);
    const same = exact.length ? exact : loose;
    // TWO OF THE SAME NAME: the one whose firm the page names (profile-identity.mjs).
    // A same-named stranger matches no one's firm, so lead paste refuses it.
    const atFirm = same.filter((r) => firmOnPage(text, r.org));
    // Several firms on the page: the one named most fully. A tie stays a tie.
    const best = Math.max(0, ...atFirm.map((r) => firmShare(text, r.org)));
    const top = atFirm.length > 1 ? atFirm.filter((r) => firmShare(text, r.org) === best) : atFirm;
    return (top.length ? top : same).map((r) => ({ ...r, at: 0 }));
  }
  // THE RAILS ARE OTHER PEOPLE. Everything from the first of LinkedIn's
  // suggestion rails on is someone else's name and headline; on 282 stored
  // pastes, matching into them picked the wrong person 95 times.
  const hay = ownPart(text).slice(0, 4000).toLowerCase();
  const rows = db.prepare(`SELECT p.id, p.name, p.title, o.name org,
      EXISTS(SELECT 1 FROM evidence e WHERE e.person_id = p.id
             AND e.provenance = 'operator_supplied' AND e.body IS NOT NULL) has_profile
    FROM people p LEFT JOIN orgs o ON o.id = p.org_id`).all();
  const hits = rows.filter((r) => r.name && r.name.length > 5 && hay.includes(r.name.toLowerCase()))
    .map((r) => ({ ...r, at: hay.indexOf(r.name.toLowerCase()) }));
  // A name inside a longer one is not a second person: "Alex Chen" also matches
  // inside "Alex Chenoweth".
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.name.length > h.name.length
    && o.name.toLowerCase().includes(h.name.toLowerCase())));
  // EARLIEST WINS, not longest (2026-10-29). A profile's first 4,000 characters
  // carry its Activity too, and a repost names someone else ("join <subject>'s
  // team" sat under a recruiter's longer name). The subject's name
  // comes first, after the nav chrome; a paste that ingests itself on arrival
  // has no one looking at the match before it is written.
  if (kept.length) return kept.sort((a, b) => a.at - b.at);
  // A NICKNAME WITHOUT THE HEADER (2026-11-09). A paste with no degree line
  // reached only the exact-substring scan above, so a full first name on the
  // page found no nickname of it in the book. The first name-shaped line near
  // the top is tried with the same nickname rule the header uses; two
  // matches are narrowed by the firm on the page, and a tie is no match.
  const lines = ownPart(text).split(/\r?\n/).map((l) => l.trim()).slice(0, 40);
  for (const [i, line] of lines.entries()) {
    if (!/^[A-Z][\p{L}.'’-]+(?: [\p{L}.'’-]+){1,3}$/u.test(line)) continue;
    const k = nameKey(line);
    if (!k?.last || k.last.length < 2) continue;
    const same = rows.filter((r) => sameName(k, r.name));
    if (!same.length) continue;
    const atFirm = same.filter((r) => firmOnPage(text, r.org));
    const pick = atFirm.length ? atFirm : same;
    return pick.length === 1 ? [{ ...pick[0], at: i }] : [];
  }
  return [];
}
