// Lever postings API. Public, unauthenticated, one board token per request.
//   https://api.lever.co/v0/postings/{token}?mode=json
// api.lever.co publishes Crawl-delay: 1, which http.mjs picks up automatically.
import { getJson } from './http.mjs';

export const id = 'lever';
export const boardUrl = (token) => `https://jobs.lever.co/${encodeURIComponent(token)}`;

export async function fetchBoard(token) {
  const res = await getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
  if (!res.ok) return { ok: false, ...res };

  const jobs = Array.isArray(res.json) ? res.json : [];
  return {
    ok: true,
    org_name: null,           // Lever's postings API does not return the company name
    board_url: boardUrl(token),
    postings: jobs.map((j) => ({
      external_id: String(j.id),
      title: j.text ?? '',
      department: j.categories?.department ?? null,
      team: j.categories?.team ?? null,
      location: j.categories?.location ?? j.categories?.allLocations?.join(', ') ?? null,
      url: j.hostedUrl ?? `${boardUrl(token)}/${j.id}`,
      // createdAt is epoch milliseconds.
      posted_at: Number.isFinite(j.createdAt) ? new Date(j.createdAt).toISOString() : null,
    })),
  };
}
