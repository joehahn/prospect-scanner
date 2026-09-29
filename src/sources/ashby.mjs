// Ashby job board API. Public, unauthenticated, one board token per request.
//   https://api.ashbyhq.com/posting-api/job-board/{token}
import { getJson } from './http.mjs';

export const id = 'ashby';
export const boardUrl = (token) => `https://jobs.ashbyhq.com/${encodeURIComponent(token)}`;

export async function fetchBoard(token) {
  const res = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
  if (!res.ok) return { ok: false, ...res };

  const jobs = res.json?.jobs ?? [];
  // Ashby answers 200 with an empty list for a token that does not exist, so an
  // empty board is indistinguishable from a missing one. Report it as such.
  return {
    ok: true,
    org_name: null,           // Ashby's posting API does not return the company name
    board_url: boardUrl(token),
    postings: jobs.filter((j) => j.isListed !== false).map((j) => ({
      external_id: String(j.id),
      title: (j.title ?? '').trim(),
      department: j.department ?? null,
      team: j.team ?? null,
      location: j.location ?? null,
      url: j.jobUrl ?? `${boardUrl(token)}/${j.id}`,
      posted_at: j.publishedAt ?? null,
    })),
  };
}
