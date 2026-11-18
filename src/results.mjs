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

import { sends, rates, matureRequests, channelScores, weekly, inboundDaily, SEGMENTS, CHANNELS, MATURE_DAYS, MIN_GROUP } from './outcomes.mjs';

export const NEW_DAYS = 14;
export const UNSEEN_FOLD = 30;
export const UNSEEN_RETIRE = 60;
const HALF_LIFE = 30;

/** The briefs, as approved by the operator on 2026-11-18. Inserted once; the table is the record after that. */
export const BRIEFS = [
  ['inbound', 'How many new cards reach the board each day, how many rate 4 or 5, and did a missed or failed run cause a dip?', 'Where to fix or widen discovery.'],
  ['weekly', 'Is outreach volume holding, and is anything coming back?', 'How much to send each week.'],
  ['channels', 'Which channel deserves the next send?', 'Connection request, message, InMail or email.'],
  ['segments', 'Which industries and offers accept connection requests?', 'Where discovery looks, and which offer leads.'],
  ['roles', 'Which seats accept, by function and level?', 'Who to aim at.'],
  ['rating', 'Do people the judge rates higher accept more often?', 'Whether 3s are worth sending.'],
  ['replies', 'Who answered, and how?', 'What the replies have in common.'],
];

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
    marker:{size:11, color: groups.map((g) => g.group === 1 ? pal[1] : pal[0])},
    error_x:{type:'data', symmetric:false, array: groups.map((g) => g.range[1] - g.rate),
      arrayminus: groups.map((g) => g.rate - g.range[0]), color: dark ? '#8f8e88' : '#a3a29c', thickness:1.5, width:0},
    hovertemplate:'%{y}<br>%{x:.0%}<extra></extra>' }],
    layoutFor({ margin:{l:10, r:24, t:10, b:44}, showlegend:false,
      xaxis:{tickformat:'.0%', range:[0, Math.min(1, Math.max(...groups.map((g) => g.range[1])) + 0.05)], gridcolor:grid, title:{text:xTitle}},
      yaxis:{autorange:'reversed', automargin:true, gridcolor:'rgba(0,0,0,0)'},
      shapes: overall == null ? [] : [{type:'line', x0:overall, x1:overall, yref:'paper', y0:0, y1:1, line:{dash:'dash', width:1.5, color: dark ? '#c3c2b7' : '#52514e'}}] }), cfgP);
}`;

/** {html, script} for the page. `offerLabel(id)` names an offer from config. */
export function resultsPage(db, { offerLabel = (id) => id, topGoal = null, server = '' } = {}) {
  seedBriefs(db);
  const placed = placeBriefs(db);
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
    const missed = ib.marks.filter((m) => m.kind !== 'weekly').length;
    const per3 = (ib.threes.reduce((a, b) => a + b, 0) / ib.days.length).toFixed(1);
    panels.inbound = {
      title: 'New cards per day',
      caption: `People rated 3 or more on the day they were judged. Colored bars are the 4s and 5s, by where they were found; the pale band on top is the 3s. Over ${ib.days.length} days, ${per} a day rated 4 or 5${topGoal ? ` against a goal of ${topGoal}` : ''}, and ${per3} rated 3. Gray triangles are the weekly searches and agenda loads; red marks are runs that failed or never started (${missed} here).`,
      height: 320,
    };
    scripts.push(`{ const days = ${J(ib.days)}, series = ${J(ib.series)}, marks = ${J(ib.marks)}, threes = ${J(ib.threes)};
  const top = Math.max(1, ...days.map((_, i) => series.reduce((a, s) => a + s.counts[i], 0) + threes[i]), ${topGoal ?? 0});
  const kinds = {weekly:{sym:'triangle-up', color: dark ? '#8f8e88' : '#a3a29c', name:'weekly job'},
                 failed:{sym:'x', color:'#c0392b', name:'run failed'}, missed:{sym:'x', color:'#c0392b', name:'run never started'}};
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
      caption: `Bars are sends, by channel. The line is how many of that week's connection requests were accepted; dots are replies from people. The last four full weeks averaged ${avg} sends; the last bar is this week so far.`,
      height: 320,
    };
    scripts.push(`{ const wk = ${J(wk)}, chans = ${J(chans)}, names = ${J(CHANNELS)};
  const x = wk.map((w) => w.week);
  const traces = chans.map((c, i) => ({ type:'bar', name:names[c], x, y: wk.map((w) => w.byChannel[c] ?? 0), marker:{color:pal[i]},
    hovertemplate:'week of %{x}<br>' + names[c] + ': %{y}<extra></extra>' }));
  traces.push({ type:'scatter', mode:'lines+markers', name:'accepted', x, y: wk.map((w) => w.accepted), line:{width:2.5, color: dark ? '#e8e6dc' : '#1f1e1c'}, marker:{size:6},
    hovertemplate:'week of %{x}<br>accepted: %{y}<extra></extra>' });
  traces.push({ type:'scatter', mode:'markers', name:'replied', x, y: wk.map((w) => w.replied || null), marker:{size:12, symbol:'star', color:'#c0392b'},
    hovertemplate:'week of %{x}<br>replied: %{y}<extra></extra>' });
  Plotly.newPlot('c-weekly', traces, layoutFor({ barmode:'stack', margin:{l:44, r:16, t:10, b:40}, legend:legendTop, bargap:0.2,
    yaxis:{gridcolor:grid, rangemode:'tozero', title:{text:'sends'}}, xaxis:{gridcolor:'rgba(0,0,0,0)', title:{text:'week starting'}} }), cfgP); }`);
  }

  // 3. Channels.
  {
    const cs = channelScores(rows).filter((c) => c.sent >= 5);
    const groups = [];
    for (const c of cs) {
      groups.push({ label: `${c.label}: any reply`, k: c.replied, n: c.mature, rate: c.mature ? c.replied / c.mature : 0, range: c.replyRange, group: 0 });
    }
    const cr = cs.find((c) => c.channel === 'linkedin_connect_note');
    if (cr) groups.unshift({ label: 'Connection request: accepted', k: cr.accepted, n: cr.mature, rate: cr.mature ? cr.accepted / cr.mature : 0, range: cr.acceptRange, group: 1 });
    const bounced = cs.filter((c) => c.bounced).map((c) => `${c.bounced} of ${c.sent} ${c.label.toLowerCase()}s bounced`).join('; ');
    panels.channels = {
      title: 'Reply rate by channel',
      caption: `Share of sends at least ${MATURE_DAYS} days old that got a reply from the person; bars are the 90% range. The orange dot is connection requests accepted. ${bounced ? `${bounced[0].toUpperCase()}${bounced.slice(1)}, and are left out.` : ''}`,
      height: 60 + 34 * groups.length,
    };
    scripts.push(`rateDots('c-channels', ${J(groups)}, null, 'share of sends');`);
  }

  // 4. Industries and offers.
  {
    const seg = rates(reqs, (r) => r.segment, (r) => r.accepted, { label: (k) => SEGMENTS[k] ?? 'Other' }).map((g) => ({ ...g, group: 0 }));
    const off = rates(reqs, (r) => r.offer, (r) => r.accepted, { label: (k) => offerLabel(k) })
      .map((g) => ({ ...g, label: `Offer: ${g.label}`, group: 1 }));
    panels.segments = {
      title: 'Connection requests accepted, by industry and by offer',
      caption: `Blue rows are the firm's industry, orange rows the offer the note made. The dashed line is all requests, ${overall == null ? 'none yet' : pct(overall)}. Groups under ${MIN_GROUP} requests are folded into Other. Requests count once they are ${MATURE_DAYS} days old.`,
      height: 60 + 34 * (seg.length + off.length),
    };
    scripts.push(`rateDots('c-segments', ${J([...seg, ...off])}, ${overall}, 'accepted');`);
  }

  // 5. Roles.
  {
    const fn = rates(reqs, (r) => r.func, (r) => r.accepted).map((g) => ({ ...g, group: 0 }));
    const lv = rates(reqs, (r) => r.level, (r) => r.accepted).map((g) => ({ ...g, label: `Level: ${g.label}`, group: 1 }));
    panels.roles = {
      title: 'Connection requests accepted, by function and level',
      caption: `Blue rows are the function in the title, orange rows the level, both read from the title in code. The dashed line is all requests. Groups under ${MIN_GROUP} are folded into Other.`,
      height: 60 + 34 * (fn.length + lv.length),
    };
    scripts.push(`rateDots('c-roles', ${J([...fn, ...lv])}, ${overall}, 'accepted');`);
  }

  // 6. Rating at send.
  {
    const rt = rates(reqs, (r) => (r.rating == null ? null : String(r.rating)), (r) => r.accepted, { min: 5, label: (k) => `Rated ${k}` })
      .sort((a, b) => (b.key ?? '0').localeCompare(a.key ?? '0')).map((g) => ({ ...g, label: g.key == null ? 'Unrated or 1 to 2' : g.label, group: 0 }));
    panels.rating = {
      title: 'Connection requests accepted, by rating when sent',
      caption: `The judge's rating on the day each request went. The dashed line is all requests. If 3s accept about as often as 4s, sending them costs little.`,
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
    panels.replies = {
      title: 'Replies from people',
      caption: `Everyone who replied, newest first: ${reps.length} people from ${rows.length} sends. Too few to turn into a rate per group, so they are listed.`,
      table: `<table><thead><tr><th>replied</th><th>who</th><th>firm</th><th>channel</th><th>industry</th><th>how</th></tr></thead><tbody>
${reps.map((r) => `<tr><td style="white-space:nowrap">${esc(r.at)}${r.dated ? '' : '<div class="dim">sent</div>'}</td><td>${esc(r.name ?? '')}<div class="dim">${esc(r.title ?? '')}</div></td><td>${esc(r.org_name ?? '')}</td>
<td>${esc(CHANNELS[r.channel] ?? r.channel)}${r.warm ? ' <span class="dim">(warm)</span>' : ''}</td><td>${esc(SEGMENTS[r.segment] ?? '')}</td>
<td>${esc(r.reply_sentiment ?? '')}${r.reply_note ? `<div class="dim">${esc(String(r.reply_note).length > 140 ? `${String(r.reply_note).slice(0, 137)}...` : r.reply_note)}</div>` : ''}</td></tr>`).join('')}</tbody></table>`,
    };
  }

  const section = (b) => {
    const p = panels[b.id];
    if (!p) return '';
    // A FIXED NUMBER PER PANEL (2026-11-18, the operator: "add plot numbers to
    // each plot"). Fixed rather than by position, since the order moves with
    // use and "Figure 3" has to mean the same panel next week.
    const n = BRIEFS.findIndex(([id]) => id === b.id) + 1;
    return `<section class="panel chart" data-brief="${esc(b.id)}" title="${esc(b.question)}">
<h2>${n ? `Figure ${n}. ` : ''}${esc(p.title)}</h2>
${p.table ?? `<div id="c-${esc(b.id)}" style="height:${p.height}px"></div>`}
<p class="cap">${esc(p.caption)}</p></section>`;
  };
  const shown = placed.filter((b) => b.place !== 'folded');
  const folded = placed.filter((b) => b.place === 'folded');
  const retired = db.prepare(`SELECT id, question, retired_why FROM chart_briefs WHERE status = 'retired'`).all();
  const html = `<style>
.chart .cap{color:var(--text2);font-size:13.5px;line-height:1.45;margin:.5rem 0 0;max-width:46rem}
.folded summary,.retired summary{cursor:pointer;color:var(--text2)}
</style>
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
  return { html: fill(html), script: fill(`${PLOT_HEAD}\n${scripts.join('\n')}\n${beacon}\n${folds}`), placed };
}
