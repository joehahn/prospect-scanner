// Whether a person filed off a profile sidebar is confirmed to work at the firm
// they were filed under. Used by the dashboard to keep the ready list honest.

// A SIDEBAR NAME IS NOT AN EMPLOYEE UNTIL SOMETHING SAYS SO (2026-11-08).
// "More profiles for you" beside a pasted profile lists people LinkedIn thinks
// are similar, and each was filed at the pasted person's firm. In one sitting
// the operator looked up four: a graduate student and a professor at a
// university, a community-college vice president, and a city IT manager in
// another state, all filed as staff of a state agency or a city they never
// worked for, and rated 3 on that employer alone. A sidebar name reaches the
// ready list only once one of these confirms the firm: their own profile
// pasted, the firm's team page listing them, their headline naming the firm,
// or the operator's own write call. Nothing is deleted; pasting them places them.
const GENERIC_ORG_WORDS = new Set(['department', 'state', 'city', 'county', 'services', 'service',
  'information', 'technology', 'technologies', 'office', 'group', 'company', 'companies', 'holdings',
  'partners', 'capital', 'management', 'national', 'union', 'savings', 'international', 'global', 'corporation', 'bank',
  'financial', 'health', 'university', 'college', 'commission', 'authority', 'agency', 'division',
  'public', 'american', 'united', 'association', 'insurance', 'solutions', 'systems', 'the', 'and', 'of', 'for']);
export function unconfirmedEmployer(db) {
  const rows = db.prepare(`
    SELECT p.id, p.title, g.name AS org_name FROM people p JOIN orgs g ON g.id = p.org_id
     WHERE p.notes LIKE 'Surfaced from %profile page%'
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = p.id
                        AND e.kind IN ('operator_profile', 'staff_listing', 'staff_bio'))
       AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.person_id = p.id AND v.verdict = 'write')
       AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.person_id = p.id)`).all();
  const out = new Set();
  for (const r of rows) {
    const words = String(r.org_name ?? '').toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !GENERIC_ORG_WORDS.has(w));
    const title = String(r.title ?? '').toLowerCase();
    // THE WHOLE NAME COUNTS EVEN WHEN EVERY WORD IS GENERIC (2026-11-09): a
    // headline "SVP ... at Union Savings Bank" names its firm, though "union",
    // "savings" and "bank" each name nothing alone.
    const full = String(r.org_name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
    if (full.includes(' ') && title.split(/[^a-z0-9]+/).filter(Boolean).join(' ').includes(full)) continue;
    if (!words.some((w) => new RegExp(`\\b${w}\\b`).test(title))) out.add(r.id);
  }
  return out;
}
