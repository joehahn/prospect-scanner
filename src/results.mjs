// THE RESULTS PAGE (2026-11-18): how well outreach and discovery are doing,
// at a glance. Numbers from outcomes.mjs; rules for every panel in
// docs/dataviz.md.
//
// Each panel is a brief in `chart_briefs` (the question it answers, the
// decision it informs); only approved briefs are drawn. The page records which
// panels the operator actually looks at (`chart_views`, through the form
// server), and orders them by it: looked at often rises, rarely sinks, unseen
// for UNSEEN_FOLD days folds into a strip at the bottom, unseen for
// UNSEEN_RETIRE days is retired, and one click brings a retired one back. A
// new panel stays on top for its first NEW_DAYS days so it gets a fair look.

import { sends, rates, matureRequests, channelScores, paths, weekly, inboundDaily, workDaily, routeYield, personTargets, targetCards, targetWeekly, industryYield, SEGMENTS, CHANNELS, MATURE_DAYS, MIN_GROUP } from './outcomes.mjs';

export const NEW_DAYS = 14;
export const UNSEEN_FOLD = 30;
export const UNSEEN_RETIRE = 60;
const HALF_LIFE = 30;

/** The briefs, as approved by the operator on 2026-11-18. Inserted once; the table is the record after that. */
// In pipeline order (the operator, 2026-11-18: replies to the bottom, daily
// work near the top): what came in, what got worked, what went out, what
// came back, and who answered.
export const BRIEFS = [
  ['inbound', 'How many new cards reach the board each day, how many rate 4 or 5, and did a missed or failed run cause a dip?', 'Where to fix or widen discovery.'],
  ['work', 'Where is work piling up: pasting, drafting or sending?', 'Which step to speed up.'],
  ['weekly', 'Is outreach volume holding, and is anything coming back?', 'How much to send each week.'],
  ['channels', 'Which channel is the best place to start a conversation?', 'Connection request, message, InMail or email.'],
  ['segments', 'Which industries accept connection requests?', 'Where discovery looks.'],
  ['offers', 'Which offers accept connection requests?', 'Which offer leads.'],
  ['roles', 'Which functions accept?', 'Which seats to aim at.'],
  ['levels', 'Which levels of seniority accept?', 'How senior to aim.'],
  ['rating', 'Do people the judge rates higher accept more often?', 'Whether 3s are worth sending.'],
  // Moved up 2026-11-20 (the operator: "in discovery tab move fig 3 above 2"),
  // so on Inbound it is Figure 2, ahead of the routes.
  ['targetcards', 'How many new cards does each target get?', 'Which targets discovery under- or over-feeds.'],
  ['sources', 'Which discovery routes lead to accepts and replies?', 'Where discovery spends.'],
  ['replies', 'Who answered, and how?', 'What the replies have in common.'],
  // Added 2026-11-19 (the operator: "add the charts to the results tab"), at
  // the end so the fixed figure numbers above keep their panels.
  ['targets', 'Which targets accept connection requests?', 'Where discovery spends, by target.'],
  ['industryyield', 'In which industries do judged firms turn into cards?', 'Which industries discovery spends judging on for little.'],
  ['targetweeks', 'Is each target getting more new cards week by week?', 'Whether a change to discovery reached the targets it was meant for.'],
  // Added 2026-11-24 (the operator: where cards are based, "europe vs middle
  // east vs US/texas/austin metro/other", and which regions accept), one panel
  // per tab, from the location on each person's pasted profile.
  ['regioncards', 'Where are the people on the board based?', 'Which regions discovery reaches into.'],
  ['regions', 'Which regions accept connection requests?', 'Whether to keep reaching into Europe and the Gulf.'],
];

// TWO TABS (2026-11-20, the operator: "split results into 2 tabs", after asking
// whether the panels should run inbound then outbound). What discovery brings
// in decides where to look; what outreach gets back decides what to send and
// to whom. One page of 15 panels mixed the two, with the first discovery panel
// on top and the other four at the bottom. Each tab numbers its own figures.
export const INBOUND = new Set(['inbound', 'targetcards', 'targetweeks', 'industryyield', 'sources', 'regioncards']);
export const sideOf = (id) => (INBOUND.has(id) ? 'inbound' : 'outbound');

export function seedBriefs(db) {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO chart_briefs (id, question, decision, status, created_at, approved_at)
    VALUES (?, ?, ?, 'approved', ?, ?)`);
  for (const [id, q, d] of BRIEFS) ins.run(id, q, d, now, now);
}

/**
 * Briefs in page order, with how they were placed: 'new' (pinned on top),
 * 'live' (by recent views), 'folded' (unseen for UNSEEN_FOLD days). Retires
 * any unseen for UNSEEN_RETIRE days, and says so in the row.
 */
export function placeBriefs(db, now = Date.now()) {
  const day = 86_400_000;
  const briefs = db.prepare(`SELECT * FROM chart_briefs WHERE status = 'approved'`).all();
  const views = db.prepare('SELECT brief_id, at FROM chart_views').all();
  const out = [];
  for (const b of briefs) {
    const vs = views.filter((v) => v.brief_id === b.id).map((v) => new Date(v.at).getTime());
    const since = Math.max(new Date(b.approved_at ?? b.created_at).getTime(), ...vs);
    const unseenDays = (now - since) / day;
    const ageDays = (now - new Date(b.approved_at ?? b.created_at).getTime()) / day;
    const weight = vs.reduce((a, t) => a + 0.5 ** ((now - t) / day / HALF_LIFE), 0);
    if (unseenDays >= UNSEEN_RETIRE) {
      db.prepare(`UPDATE chart_briefs SET status = 'retired', retired_at = ?, retired_why = ? WHERE id = ?`)
        .run(new Date(now).toISOString(), `not looked at in ${UNSEEN_RETIRE} days`, b.id);
      continue;
    }
    const place = ageDays < NEW_DAYS ? 'new' : unseenDays >= UNSEEN_FOLD ? 'folded' : 'live';
    out.push({ ...b, place, weight, views: vs.length });
  }
  const rank = { new: 0, live: 1, folded: 2 };
  const order = BRIEFS.map(([id]) => id);
  // New panels keep their figure order: their first weeks are for a fair look,
  // so views do not move them until the window ends.
  out.sort((a, b) => rank[a.place] - rank[b.place]
    || (a.place === 'new' ? 0 : b.weight - a.weight) || order.indexOf(a.id) - order.indexOf(b.id));
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => `${Math.round(100 * x)}%`;
const J = JSON.stringify;

// Shared plot pieces, written into the page script. `dark` and `layoutFor`
// come from the page layout.
const PLOT_HEAD = `
const pal = dark ? ['#6f8cdb','#e0954f','#5bbf8c','#e07a85','#a98bd4','#8f8e88']
                 : ['#3b5ba9','#c46a1f','#2f8a5c','#b13f4c','#7553a3','#a3a29c'];
const grid = dark ? '#33322f' : '#e6e5e1';
const legendTop = {orientation:'h', y:1.02, yanchor:'bottom', x:0, font:{color: dark ? '#c3c2b7' : '#52514e'}};
const cfgP = {displayModeBar:false, responsive:true};
// A rate per group: a dot at the rate, a bar for the 90% range, the count in the label.
function rateDots(id, groups, overall, xTitle) {
  const y = groups.map((g) => g.label + '  (' + g.k + ' of ' + g.n + ')');
  Plotly.newPlot(id, [{ type:'scatter', mode:'markers', orientation:'h', y, x: groups.map((g) => g.rate),
    // A row may name its own palette color (\`color\`) and marker (\`symbol\`);
    // otherwise blue for group 0, orange for group 1.
    marker:{size:11, color: groups.map((g) => pal[g.color ?? (g.group === 1 ? 1 : 0)]),
      symbol: groups.map((g) => g.symbol ?? 'circle'), line:{width:2, color: groups.map((g) => pal[g.color ?? (g.group === 1 ? 1 : 0)])}},
    error_x:{type:'data', symmetric:false, array: groups.map((g) => g.range[1] - g.rate),
      arrayminus: groups.map((g) => g.rate - g.range[0]), color: dark ? '#8f8e88' : '#a3a29c', thickness:1.5, width:0},
    hovertemplate:'%{y}<br>%{x:.0%}<extra></extra>' }],
    layoutFor({ margin:{l:10, r:24, t:10, b:44}, showlegend:false,
      xaxis:{tickformat:'.0%', range:[0, Math.min(1, Math.max(...groups.map((g) => g.range[1])) + 0.05)], gridcolor:grid, title:{text:xTitle}},
      yaxis:{autorange:'reversed', automargin:true, gridcolor:'rgba(0,0,0,0)'},
      shapes: overall == null ? [] : [{type:'line', x0:overall, x1:overall, yref:'paper', y0:0, y1:1, line:{dash:'dash', width:1.5, color: dark ? '#c3c2b7' : '#52514e'}}] }), cfgP);
}`;

// Rows high to low within their color: blue rows first, then orange (the
// operator, 2026-11-18). Other sorts with the rest; its label says what it is.
const byRate = (gs) => [...gs].sort((a, b) => b.rate - a.rate || b.n - a.n);

/** {html, script} for the page. `offerLabel(id)` names an offer from config. */
export function resultsPage(db, { offerLabel = (id) => id, targetLabel = (name) => name, targetKind = () => null, regionOf = null, regionLabel = (k) => k ?? 'No location on file', topGoal = null, sendGoal = null, server = '', side = null } = {}) {
  seedBriefs(db);
  const onSide = (id) => !side || sideOf(id) === side;
  const placed = placeBriefs(db).filter((b) => onSide(b.id));
  const rows = sends(db);
  const reqs = matureRequests(rows);
  const accepted = reqs.filter((r) => r.accepted).length;
  const overall = reqs.length ? accepted / reqs.length : null;
  const panels = {};
  const scripts = [];

  // 1. Daily inbound, with what ran and what failed marked under it.
  {
    const ib = inboundDaily(db, 45);
    const total = ib.series.reduce((a, s) => a + s.counts.reduce((x, y) => x + y, 0), 0);
    const per = (total / ib.days.length).toFixed(1);
    const missed = ib.marks.filter((m) => m.kind === 'failed' || m.kind === 'missed').length;
    const judges = ib.marks.filter((m) => m.kind === 'judge').map((m) => `${m.what} on ${m.day.slice(5)}`);
    const per3 = (ib.threes.reduce((a, b) => a + b, 0) / ib.days.length).toFixed(1);
    panels.inbound = {
      title: 'New cards per day',
      caption: `People rated 3 or more on the day they were judged, at the rating they got that day; a later re-judge does not move a past bar. Colored bars are the 4s and 5s, by where they were found; the pale band on top is the 3s. Over ${ib.days.length} days, ${per} a day rated 4 or 5${topGoal ? ` against a goal of ${topGoal}` : ''}, and ${per3} rated 3. Gray triangles are the weekly searches and agenda loads; red marks are runs that failed or never started (${missed} here)${judges.length ? `; blue diamonds are changes to the judge (${judges.join(', ')}), after which ratings follow different rules` : ''}.`,
      height: 320,
    };
    scripts.push(`{ const days = ${J(ib.days)}, series = ${J(ib.series)}, marks = ${J(ib.marks)}, threes = ${J(ib.threes)};
  const top = Math.max(1, ...days.map((_, i) => series.reduce((a, s) => a + s.counts[i], 0) + threes[i]), ${topGoal ?? 0});
  const kinds = {weekly:{sym:'triangle-up', color: dark ? '#8f8e88' : '#a3a29c', name:'weekly job'},
                 failed:{sym:'x', color:'#c0392b', name:'run failed'}, missed:{sym:'x', color:'#c0392b', name:'run never started'},
                 judge:{sym:'diamond', color: pal[0], name:'judge changed'}};
  const traces = series.map((s, i) => ({ type:'bar', name:s.source, x:days, y:s.counts, marker:{color: i === series.length - 1 ? pal[5] : pal[i]},
    hovertemplate:'%{x}<br>' + s.source + ': %{y}<extra></extra>' }));
  traces.push({ type:'bar', name:'rated 3', x:days, y:threes, marker:{color: dark ? 'rgba(200,198,190,0.28)' : 'rgba(120,118,110,0.22)'},
    hovertemplate:'%{x}<br>rated 3: %{y}<extra></extra>' });
  for (const [k, v] of Object.entries(kinds)) {
    const ms = marks.filter((m) => m.kind === k);
    if (ms.length) traces.push({ type:'scatter', mode:'markers', name:v.name, x: ms.map((m) => m.day), y: ms.map(() => -top * 0.08),
      text: ms.map((m) => m.what), marker:{symbol:v.sym, size:9, color:v.color}, hovertemplate:'%{x}<br>%{text}<extra></extra>' });
  }
  ${topGoal ? `traces.push({ type:'scatter', mode:'lines', name:'goal', x:[days[0], days.at(-1)], y:[${topGoal}, ${topGoal}], line:{dash:'dot', width:1.5, color: dark ? '#c3c2b7' : '#52514e'}, hoverinfo:'skip' });` : ''}
  Plotly.newPlot('c-inbound', traces, layoutFor({ barmode:'stack', margin:{l:44, r:16, t:10, b:40}, legend:legendTop, bargap:0.15,
    yaxis:{range:[-top * 0.15, top * 1.1], gridcolor:grid, title:{text:'people'}}, xaxis:{gridcolor:'rgba(0,0,0,0)'} }), cfgP); }`);
  }

  // 2. Outreach by week.
  {
    const wk = weekly(rows);
    const chans = Object.keys(CHANNELS).filter((c) => wk.some((w) => w.byChannel[c]));
    const last4 = wk.slice(-5, -1);
    const avg = last4.length ? (last4.reduce((a, w) => a + w.sent, 0) / last4.length).toFixed(0) : '0';
    panels.weekly = {
      title: 'Sends per week, and what came back',
      caption: `Bars are sends, by channel. The line is how many of that week's connection requests were accepted; dots are replies from people. The last four full weeks averaged ${avg} sends${sendGoal ? `, against a goal of ${sendGoal * 5} a week (dashed)` : ''}; the last bar is this week so far.`,
      height: 320,
    };
    scripts.push(`{ const wk = ${J(wk)}, chans = ${J(chans)}, names = ${J(CHANNELS)};
  const x = wk.map((w) => w.week);
  const traces = chans.map((c, i) => ({ type:'bar', name:names[c], x, y: wk.map((w) => w.byChannel[c] ?? 0), marker:{color:pal[i]},
    hovertemplate:'week of %{x}<br>' + names[c] + ': %{y}<extra></extra>' }));
  traces.push({ type:'scatter', mode:'lines+markers', name:'accepted', x, y: wk.map((w) => w.accepted), line:{width:2.5, color: dark ? '#e8e6dc' : '#1f1e1c'}, marker:{size:6},
    hovertemplate:'week of %{x}<br>accepted: %{y}<extra></extra>' });
  ${sendGoal ? `traces.push({ type:'scatter', mode:'lines', name:'goal', x:[x[0], x.at(-1)], y:[${sendGoal * 5}, ${sendGoal * 5}], line:{dash:'dash', width:2.5, color: dark ? '#f2f0e6' : '#1f1e1c'}, hoverinfo:'skip' });` : ''}
  traces.push({ type:'scatter', mode:'markers', name:'replied', x, y: wk.map((w) => w.replied || null), marker:{size:12, symbol:'star', color:'#c0392b'},
    hovertemplate:'week of %{x}<br>replied: %{y}<extra></extra>' });
  Plotly.newPlot('c-weekly', traces, layoutFor({ barmode:'stack', margin:{l:44, r:16, t:10, b:40}, legend:legendTop, bargap:0.2,
    yaxis:{gridcolor:grid, rangemode:'tozero', title:{text:'sends'}}, xaxis:{gridcolor:'rgba(0,0,0,0)', title:{text:'week starting'}} }), cfgP); }`);
  }

  // 3. Channels, by the channel a conversation started on (outcomes.mjs paths).
  {
    const cs = paths(rows).filter((c) => c.people >= 5);
    const groups = [];
    const rate = (k, n) => (n ? k / n : 0);
    for (const c of cs) {
      const request = c.channel === 'linkedin_connect_note';
      // Color is the platform (LinkedIn blue, email red, as in Figure 2);
      // the open circle marks the one row that counts accepts, not replies.
      const color = c.channel === 'email' ? 3 : 0;
      if (request) groups.push({ label: 'Connection request: accepted', k: c.accepted, n: c.mature, rate: rate(c.accepted, c.mature), range: c.acceptRange, color, symbol: 'circle-open' });
      // A first message on LinkedIn goes to someone already connected, mostly
      // people the operator knows: say so, or the row reads as a cold channel.
      const label = request ? 'Connection request: accepted, then replied'
        : c.channel === 'linkedin_message' ? 'Message to an existing connection: replied' : `${c.label}: replied`;
      groups.push({ label,
        k: c.replied, n: c.mature, rate: rate(c.replied, c.mature), range: c.replyRange, color });
    }
    groups.sort((a, b) => b.rate - a.rate);
    const cr = cs.find((c) => c.channel === 'linkedin_connect_note');
    const step = cr && cr.accepted ? ` ${cr.replied} of the ${cr.accepted} who accepted went on to reply (${pct(cr.replied / cr.accepted)}).` : ' none accepted yet.';
    const bounced = cs.filter((c) => c.bounced).map((c) => `${c.bounced} people whose first ${c.label.toLowerCase()} bounced`).join('; ');
    panels.channels = {
      title: 'Reply rate by the channel a conversation started on',
      caption: `People whose first send is at least ${MATURE_DAYS} days old, by the channel it went on (blue LinkedIn, red email), and how many ever wrote back, including to later follow-ups. The open circle is connection requests accepted;${step} Bars show where the true rate likely lies (90% range, computed from the counts). ${bounced ? `${bounced[0].toUpperCase()}${bounced.slice(1)} are left out.` : ''}`,
      height: 60 + 34 * groups.length,
    };
    scripts.push(`rateDots('c-channels', ${J(groups)}, null, 'share of people');`);
  }

  // 4. Industry, and 5. offer: two panels, independent splits like function
  // and level (the operator, 2026-11-18).
  {
    const seg = byRate(rates(reqs, (r) => r.segment, (r) => r.accepted, { label: (k) => SEGMENTS[k] ?? 'Other' }));
    panels.segments = {
      title: 'Connection requests accepted, by industry',
      caption: `The industry of each person's firm. The dashed line is all requests, ${overall == null ? 'none yet' : pct(overall)}, and groups under ${MIN_GROUP} are folded into Other. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * seg.length,
    };
    scripts.push(`rateDots('c-segments', ${J(seg)}, ${overall}, 'accepted');`);
    const off = byRate(rates(reqs, (r) => r.offer, (r) => r.accepted, { label: (k) => offerLabel(k) }));
    panels.offers = {
      title: 'Connection requests accepted, by offer',
      caption: `The offer each request's note made. The dashed line is all requests, and offers with under ${MIN_GROUP} requests are folded into Other. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * off.length,
    };
    scripts.push(`rateDots('c-offers', ${J(off)}, ${overall}, 'accepted');`);
  }

  // 5. Function, and 6. level: two panels, since they are independent
  // splits and one chart invited comparing a function row with a level row
  // (the operator, 2026-11-18).
  {
    const fn = byRate(rates(reqs, (r) => r.func, (r) => r.accepted));
    panels.roles = {
      title: 'Connection requests accepted, by function',
      caption: `The function in each person's title, read in code. The dashed line is all requests, and groups under ${MIN_GROUP} are folded into Other. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * fn.length,
    };
    scripts.push(`rateDots('c-roles', ${J(fn)}, ${overall}, 'accepted');`);
    const lv = byRate(rates(reqs, (r) => r.level, (r) => r.accepted));
    panels.levels = {
      title: 'Connection requests accepted, by level',
      caption: `The seniority in each person's title, read in code. The dashed line is all requests, and groups under ${MIN_GROUP} are folded into Other. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * lv.length,
    };
    scripts.push(`rateDots('c-levels', ${J(lv)}, ${overall}, 'accepted');`);
  }

  // 6. Rating at send.
  {
    const rt = rates(reqs, (r) => (r.rating == null ? null : String(r.rating)), (r) => r.accepted, { min: 5, label: (k) => `Rated ${k}` })
      .sort((a, b) => (b.key ?? '0').localeCompare(a.key ?? '0')).map((g) => ({ ...g, label: g.key == null ? 'Unrated or 1 to 2' : g.label, group: 0 }));
    panels.rating = {
      title: 'Connection requests accepted, by rating when sent',
      caption: `The judge's rating on the day each request went. The dashed line is all requests. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * rt.length,
    };
    scripts.push(`rateDots('c-rating', ${J(rt)}, ${overall}, 'accepted');`);
  }

  // 7. Replies.
  {
    // One row per person, their latest reply; a reply recorded only as a
    // status (no response row) is dated by its send.
    const byPerson = new Map();
    for (const r of rows.filter((x) => x.replied)) {
      const at = r.replied_at ?? r.sent_at;
      const k = r.person_id ?? `o${r.id}`;
      const cur = byPerson.get(k);
      // A dated reply, with what was said, wins over one known only from a status.
      if (!cur || (!!r.replied_at > cur.dated) || (!!r.replied_at === cur.dated && at > cur.at)) byPerson.set(k, { ...r, at, dated: !!r.replied_at });
    }
    const reps = [...byPerson.values()].sort((a, b) => b.at.localeCompare(a.at));
    // WHAT HAPPENED AFTER (2026-11-18, the operator, on a call that was held
    // and then went quiet: the row "should indicate that we met but no
    // followup steps after that"). Sends to the person after their latest
    // reply, and whether any was answered.
    const since = (r) => {
      // Same day counts: a thank-you after a call goes out the day of the call.
      const later = rows.filter((x) => x.person_id === r.person_id && x.sent_at >= r.at.slice(0, 10) && x.id !== r.id);
      if (!later.length) return 'nothing sent since';
      const answered = later.some((x) => x.replied && (x.replied_at ?? '') > r.at);
      return `${later.length} sent since (${later.map((x) => x.sent_at.slice(5)).join(', ')}), ${answered ? 'answered' : 'no reply'}`;
    };
    panels.replies = {
      title: 'Replies from people',
      caption: `Everyone who replied, newest first, with their latest reply and what has been sent to them since: ${reps.length} people from ${rows.length} sends. Too few to turn into a rate per group, so they are listed.`,
      table: `<table><thead><tr><th>replied</th><th>who</th><th>firm</th><th>channel</th><th>industry</th><th>their latest reply</th><th>since</th></tr></thead><tbody>
${reps.map((r) => `<tr><td style="white-space:nowrap">${esc(r.at)}${r.dated ? '' : '<div class="dim">sent</div>'}</td><td>${esc(r.name ?? '')}<div class="dim">${esc(r.title ?? '')}</div></td><td>${esc(r.org_name ?? '')}</td>
<td>${esc(CHANNELS[r.channel] ?? r.channel)}${r.warm ? ' <span class="dim">(warm)</span>' : ''}</td><td>${esc(SEGMENTS[r.segment] ?? '')}</td>
<td>${esc(r.reply_sentiment ?? '')}${r.reply_note ? `<div class="dim">${esc(String(r.reply_note).length > 140 ? `${String(r.reply_note).slice(0, 137)}...` : r.reply_note)}</div>` : ''}</td>
<td>${esc(since(r))}</td></tr>`).join('')}</tbody></table>`,
    };
  }

  // 10. Pasted, drafted, sent per day (replaces the Funnel page's stage table).
  {
    const w = workDaily(db, 30);
    const tot = (a) => a.reduce((x, y) => x + y, 0);
    panels.work = {
      title: 'Profiles pasted, drafted and sent, per day',
      caption: `People whose profile was first pasted, first drafted to, and first sent a note, each day. Over ${w.days.length} days: ${tot(w.pasted)} pasted, ${tot(w.drafted)} drafted, ${tot(w.sent)} sent. Pasted runs above drafted because a paste often shows someone is not worth a note; when drafted runs above sent, notes are waiting on you.`,
      height: 300,
    };
    scripts.push(`{ const w = ${J(w)};
  const tr = [['pasted', w.pasted, pal[2]], ['drafted', w.drafted, pal[1]], ['sent', w.sent, pal[0]]].map(([n, y, c]) => ({ type:'scatter', mode:'lines+markers', name:n, x:w.days, y,
    line:{width:2, color:c}, marker:{size:5}, hovertemplate:'%{x}<br>' + n + ': %{y}<extra></extra>' }));
  Plotly.newPlot('c-work', tr, layoutFor({ margin:{l:44, r:16, t:10, b:40}, legend:legendTop, hovermode:'x',
    yaxis:{gridcolor:grid, rangemode:'tozero', title:{text:'people'}}, xaxis:{gridcolor:'rgba(0,0,0,0)'} }), cfgP); }`);
  }

  // 11. Where each discovery route's people end up (replaces the Funnel page's
  // source table, now crediting people to how their firm was found).
  {
    // BY CARDS RATED 3+ (2026-11-20, the operator's call): what each route puts
    // on the board is the route's own output; sends and accepts depend on whom
    // he writes to, and accepts are too few to rank by. Found breaks ties.
    const src = routeYield(db, 60).filter((r) => r.found >= 5 || r.sent).sort((a, b) => b.strong - a.strong || b.found - a.found);
    const pc = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : '');
    panels.sources = {
      title: "Where each discovery route's people end up",
      caption: 'People first found in the last 60 days, by the route that found them: a conference speaker or a person added by hand is found as a person; anyone else is credited to how their firm was found. Sorted by how many each route put on the board rated 3 or more. Beside accepted, the share of those sent (2026-11-20, the operator); it runs low, because sends from the last two weeks have not had time to be accepted and an email or InMail is never accepted. Beside replied, the share of those accepted; a reply to an email counts without an accept, so it can pass 100%.',
      table: `<table><thead><tr><th>route</th><th class="num">found</th><th class="num">rated 3+</th><th class="num">sent</th><th class="num">accepted</th><th class="num">replied</th></tr></thead><tbody>
${src.map((r) => `<tr><td>${esc(r.route)}</td><td class="num">${r.found}</td><td class="num">${r.strong} <span class="dim">${pc(r.strong, r.found)}</span></td><td class="num">${r.sent}</td><td class="num"><b>${r.accepted}</b> <span class="dim">${pc(r.accepted, r.sent)}</span></td><td class="num">${r.replied} <span class="dim">${pc(r.replied, r.accepted)}</span></td></tr>`).join('')}</tbody></table>`,
    };
  }

  // 12. New cards per target, and 13. requests accepted per target. The target
  // is the one the judge named in each person's latest judgment; known for
  // every judged person, unlike the industry, which is labelled per firm.
  {
    const CARD_DAYS = 30;
    // BUYERS, THEN SITUATIONS (2026-11-19, the operator: "is fig 13 mixing
    // apples and oranges?"). A buyer target says who the person is; a situation
    // says what is happening at the firm, in any industry. Each person is filed
    // under one, so a PE partner at a firm with manual work may sit under
    // either: the rows are one split, but not one kind of category. Buyers come
    // first, situations after, in italics; unfiled last.
    const sit = (t) => t != null && targetKind(t) === 'situation';
    const rank = (t) => (t == null ? 2 : sit(t) ? 1 : 0);
    const tc = targetCards(db, CARD_DAYS).sort((a, b) => rank(a.target) - rank(b.target));
    const lab = (t) => (t == null ? 'No target named' : sit(t) ? `<i>${esc(targetLabel(t))}</i>` : esc(targetLabel(t)));
    const y = tc.map((g) => `${lab(g.target)}  (${g.top + g.threes})`);
    const total = tc.reduce((a, g) => a + g.top + g.threes, 0);
    const none = tc.find((g) => g.target == null);
    panels.targetcards = {
      title: `New cards per target, last ${CARD_DAYS} days`,
      caption: `People first judged in the last ${CARD_DAYS} days who are rated 3 or more now, by the target the judge filed them under: buyer targets first, then situation targets in italics. Blue is rated 4 or 5, orange rated 3. ${total} cards in all${none ? `, ${none.top + none.threes} of them under no target` : ''}.`,
      height: 70 + 30 * tc.length,
    };
    scripts.push(`{ const y = ${J(y)};
  Plotly.newPlot('c-targetcards', [
    { type:'bar', orientation:'h', name:'rated 4 or 5', y, x:${J(tc.map((g) => g.top))}, marker:{color:pal[0]}, hovertemplate:'%{y}<br>%{x} rated 4 or 5<extra></extra>' },
    { type:'bar', orientation:'h', name:'rated 3', y, x:${J(tc.map((g) => g.threes))}, marker:{color:pal[1]}, hovertemplate:'%{y}<br>%{x} rated 3<extra></extra>' }],
    layoutFor({ barmode:'stack', margin:{l:10, r:24, t:10, b:44}, legend:{...legendTop, traceorder:'normal'},
      xaxis:{gridcolor:grid, title:{text:'cards'}}, yaxis:{autorange:'reversed', automargin:true, gridcolor:'rgba(0,0,0,0)'} }), cfgP); }`);

    const tOf = personTargets(db);
    // Blue buyers, then orange situations, each high to low (D14); Other gray, last.
    const tg = byRate(rates(reqs, (r) => tOf.get(r.person_id)?.target ?? null, (r) => r.accepted, { label: (k) => targetLabel(k) }))
      .map((g) => ({ ...g, group: g.label === 'Other' ? 2 : sit(g.key) ? 1 : 0, ...(g.label === 'Other' ? { color: 5 } : {}) }))
      .sort((a, b) => a.group - b.group || b.rate - a.rate);
    panels.targets = {
      title: 'Connection requests accepted, by target',
      caption: `The target the judge filed each person under: blue is a buyer target (who the person is), orange a situation target (what is happening at the firm). The dashed line is all requests, ${overall == null ? 'none yet' : pct(overall)}, and targets with under ${MIN_GROUP} requests are folded into Other, with people the judge filed under no target. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * tg.length,
    };
    scripts.push(`rateDots('c-targets', ${J(tg)}, ${overall}, 'accepted');`);

    // 15. Inbound Figure 2 over time (the operator, 2026-11-20). A table, not lines:
    // ten targets is more series than the palette has colors, and a week's
    // count per target is small enough to read as a number. Same row order and
    // italics as Inbound Figure 2. The current week is partial, and marked so.
    const tw = targetWeekly(db, 8);
    tw.rows.sort((a, b) => rank(a.target) - rank(b.target));
    const cell = (c) => (c.all ? `${c.all}${c.top ? ` <span class="dim">(${c.top})</span>` : ''}` : '<span class="dim">·</span>');
    const wk = (d, i) => `${new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${i === tw.weeks.length - 1 ? '*' : ''}`;
    const sums = tw.weeks.map((_, i) => tw.rows.reduce((a, r) => ({ all: a.all + r.cells[i].all, top: a.top + r.cells[i].top }), { all: 0, top: 0 }));
    panels.targetweeks = {
      title: 'New cards per target, by week',
      caption: 'People first judged each week who are rated 3 or more now, by target; in brackets, how many of them are rated 4 or 5. Weeks start Monday, and the starred week is still under way. Buyer targets first, then situation targets in italics, as in Figure 2.',
      table: `<table><thead><tr><th>target</th>${tw.weeks.map((d, i) => `<th class="num">${wk(d, i)}</th>`).join('')}</tr></thead><tbody>
${tw.rows.map((r) => `<tr><td>${r.target == null ? 'No target named' : lab(r.target)}</td>${r.cells.map((c) => `<td class="num">${cell(c)}</td>`).join('')}</tr>`).join('')}
<tr><td><b>all targets</b></td>${sums.map((c) => `<td class="num"><b>${c.all}</b>${c.top ? ` <span class="dim">(${c.top})</span>` : ''}</td>`).join('')}</tr></tbody></table>`,
    };
  }

  // 16. Where cards are based, and 17. which regions accept. The region comes
  // from the person's own location (a pasted profile fills it), never the
  // firm's HQ. Gray is no location on file, which mostly means no paste yet.
  if (regionOf) {
    const where = new Map(db.prepare('SELECT id, location, country FROM people').all()
      .map((p) => [p.id, regionOf({ location: p.location, country: p.country })]));
    const by = new Map();
    for (const [id, p] of personTargets(db)) {
      if (!(p.rating >= 3)) continue;
      const k = where.get(id) ?? null;
      const g = by.get(k) ?? { key: k, top: 0, threes: 0 };
      if (p.rating >= 4) g.top++; else g.threes++;
      by.set(k, g);
    }
    const rc = [...by.values()].sort((a, b) => (a.key == null) - (b.key == null) || (b.top + b.threes) - (a.top + a.threes));
    const total = rc.reduce((a, g) => a + g.top + g.threes, 0);
    const none = rc.find((g) => g.key == null);
    const y = rc.map((g) => `${esc(regionLabel(g.key))}  (${g.top + g.threes})`);
    panels.regioncards = {
      title: 'Cards by region',
      caption: `Everyone rated 3 or more now, by where their profile says they are. Blue is rated 4 or 5, orange rated 3; the gray row has no location on file, mostly people whose profile has not been pasted yet. ${total} cards${none ? `, ${none.top + none.threes} of them with no location` : ''}.`,
      height: 70 + 30 * rc.length,
    };
    scripts.push(`{ const y = ${J(y)}, none = ${J(rc.map((g) => g.key == null))};
  Plotly.newPlot('c-regioncards', [
    { type:'bar', orientation:'h', name:'rated 4 or 5', y, x:${J(rc.map((g) => g.top))}, marker:{color: none.map((n) => n ? pal[5] : pal[0])}, hovertemplate:'%{y}<br>%{x} rated 4 or 5<extra></extra>' },
    { type:'bar', orientation:'h', name:'rated 3', y, x:${J(rc.map((g) => g.threes))}, marker:{color: none.map((n) => n ? (dark ? '#5a5955' : '#cfcec9') : pal[1])}, hovertemplate:'%{y}<br>%{x} rated 3<extra></extra>' }],
    layoutFor({ barmode:'stack', margin:{l:10, r:24, t:10, b:44}, legend:{...legendTop, traceorder:'normal'},
      xaxis:{gridcolor:grid, title:{text:'cards'}}, yaxis:{autorange:'reversed', automargin:true, gridcolor:'rgba(0,0,0,0)'} }), cfgP); }`);

    // Unknown is its own row when it is big enough, so the regions are
    // compared with what is missing in view; Other folds the small ones (D5).
    const rg = byRate(rates(reqs, (r) => where.get(r.person_id) ?? 'none', (r) => r.accepted,
      { label: (k) => regionLabel(k === 'none' ? null : k) }))
      .map((g) => ({ ...g, group: g.label === 'Other' || g.key === 'none' ? 2 : 0, ...(g.label === 'Other' || g.key === 'none' ? { color: 5 } : {}) }))
      .sort((a, b) => a.group - b.group || b.rate - a.rate);
    panels.regions = {
      title: 'Connection requests accepted, by region',
      caption: `Where each person's profile says they are. The dashed line is all requests, ${overall == null ? 'none yet' : pct(overall)}; regions with under ${MIN_GROUP} requests are folded into Other, and gray rows are Other and people with no location on file. Bars show where the true rate likely lies (90% range, computed from the counts).`,
      height: 60 + 34 * rg.length,
    };
    scripts.push(`rateDots('c-regions', ${J(rg)}, ${overall}, 'accepted');`);
  }

  // 14. Judged firms that turn into cards, by industry: where judging is spent
  // for little. A table, since the point is the counts side by side.
  {
    const iy = industryYield(db);
    const all = iy.reduce((a, g) => ({ firms: a.firms + g.firms, card: a.card + g.card }), { firms: 0, card: 0 });
    const pc = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : '');
    panels.industryyield = {
      title: 'Judged firms with a card, by industry',
      caption: `Every firm the judge has rated anyone at, by its industry, and how many have someone rated 3 or more now. ${all.card} of ${all.firms} judged firms have a card (${pc(all.card, all.firms)}). Sorted by firms judged.`,
      table: `<table><thead><tr><th>industry</th><th class="num">firms judged</th><th class="num">with a card</th><th class="num">share</th><th class="num">with a 4 or 5</th></tr></thead><tbody>
${iy.map((g) => `<tr><td>${esc(g.segment == null ? 'Not labelled yet' : SEGMENTS[g.segment] ?? g.segment)}</td><td class="num">${g.firms}</td><td class="num">${g.card}</td><td class="num"><b>${pc(g.card, g.firms)}</b></td><td class="num">${g.top}</td></tr>`).join('')}</tbody></table>`,
    };
  }

  const section = (b) => {
    const p = panels[b.id];
    if (!p) return '';
    // A FIXED NUMBER PER PANEL (2026-11-18, the operator: "add plot numbers to
    // each plot"). Fixed rather than by position, since the order moves with
    // use and "Figure 3" has to mean the same panel next week.
    // NUMBERED PER TAB (2026-11-20, the operator: "renumber inbound & outbound
    // figures"): 1 to 5 on Inbound, 1 to 10 on Outbound, in BRIEFS order within
    // each tab. A new panel is appended to BRIEFS, so it takes the next number
    // on its own tab and moves none of the others.
    const n = BRIEFS.filter(([id]) => !side || sideOf(id) === sideOf(b.id)).findIndex(([id]) => id === b.id) + 1;
    return `<section class="panel chart" data-brief="${esc(b.id)}" title="${esc(b.question)}">
<h2>${n ? `Figure ${n}. ` : ''}${esc(p.title)}</h2>
${p.table ?? `<div id="c-${esc(b.id)}" style="height:${p.height}px"></div>`}
<p class="cap">${esc(p.caption)}</p></section>`;
  };
  const shown = placed.filter((b) => b.place !== 'folded');
  const folded = placed.filter((b) => b.place === 'folded');
  const retired = db.prepare(`SELECT id, question, retired_why FROM chart_briefs WHERE status = 'retired'`).all().filter((r) => onSide(r.id));
  const intro = !side ? '' : side === 'inbound'
    ? '<p class="lead">What discovery brings in: new cards, by target, route and industry. Where to look next. The Outbound tab has what came back.</p>'
    : '<p class="lead">What outreach gets back: sends, accepts and replies. What to send, and to whom. The Inbound tab has what discovery brings in.</p>';
  // Each chart's script draws into its own c-<id>; a panel on the other tab has none.
  const off = BRIEFS.map(([id]) => id).filter((id) => !onSide(id));
  const mine = scripts.filter((s) => !off.some((id) => s.includes(`'c-${id}'`)));
  const html = `<style>
.chart .cap{color:var(--text2);font-size:13.5px;line-height:1.45;margin:.5rem 0 0;max-width:46rem}
.folded summary,.retired summary{cursor:pointer;color:var(--text2)}
</style>
${intro}
${shown.map(section).join('\n')}
${folded.length ? `<details class="folded panel"><summary>Not looked at in ${UNSEEN_FOLD} days: ${folded.length}</summary>${folded.map(section).join('\n')}</details>` : ''}
${retired.length ? `<details class="retired panel"><summary>Retired panels: ${retired.length}</summary><ul>${retired.map((r) => `<li>${esc(r.question)} <span class="dim">${esc(r.retired_why ?? '')}</span>
<form method="post" action="SERVER/chart-revive" style="display:inline"><input type="hidden" name="id" value="${esc(r.id)}"><button>Bring back</button></form></li>`).join('')}</ul></details>` : ''}`;

  // A panel counts as looked at once at least half of it has been on screen
  // for three seconds; opening the folded strip counts for what it shows.
  const beacon = `
(() => {
  const seen = new Set();
  const send = (id, ms, how) => { if (seen.has(id)) return; seen.add(id);
    fetch('SERVER/chart-view', { method:'POST', mode:'no-cors', headers:{'content-type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ id, ms: String(ms), how }) }).catch(() => {}); };
  const timers = new Map();
  const io = new IntersectionObserver((es) => { for (const e of es) {
    const id = e.target.dataset.brief;
    if (e.isIntersecting) timers.set(id, [Date.now(), setTimeout(() => send(id, 3000, 'seen'), 3000)]);
    else if (timers.has(id)) { clearTimeout(timers.get(id)[1]); timers.delete(id); } } }, { threshold: 0.5 });
  document.querySelectorAll('[data-brief]').forEach((el) => io.observe(el));
})();`;

  // A chart drawn inside the closed strip has no width; size it when opened,
  // and count opening it as looking at what it holds.
  const folds = `
document.querySelectorAll('details.folded').forEach((d) => d.addEventListener('toggle', () => {
  if (!d.open) return;
  d.querySelectorAll('[data-brief]').forEach((el) => {
    el.querySelectorAll('.js-plotly-plot').forEach((g) => Plotly.Plots.resize(g));
    fetch('SERVER/chart-view', { method:'POST', mode:'no-cors', headers:{'content-type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ id: el.dataset.brief, ms: '0', how: 'opened' }) }).catch(() => {});
  });
}));`;
  const fill = (s) => s.replaceAll('SERVER', server);
  return { html: fill(html), script: fill(`${PLOT_HEAD}\n${mine.join('\n')}\n${beacon}\n${folds}`), placed };
}
