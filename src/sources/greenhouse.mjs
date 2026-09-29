// Greenhouse job board API. Public, unauthenticated, one board token per request.
//   https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
import { getJson } from './http.mjs';

export const id = 'greenhouse';
export const boardUrl = (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;

export async function fetchBoard(token) {
  const res = await getJson(`${boardUrl(token)}/jobs?content=true`);
  if (!res.ok) return { ok: false, ...res };

  const jobs = res.json?.jobs ?? [];
  return {
    ok: true,
    org_name: jobs.find((j) => j.company_name)?.company_name ?? null,
    board_url: `https://job-boards.greenhouse.io/${token}`,
    postings: jobs.map((j) => ({
      external_id: String(j.id),
      title: j.title ?? '',
      department: j.departments?.map((d) => d.name).filter(Boolean).join(', ') || null,
      team: null,
      location: j.location?.name ?? j.offices?.map((o) => o.name).join(', ') ?? null,
      url: j.absolute_url ?? `https://job-boards.greenhouse.io/${token}/jobs/${j.id}`,
      // first_published is when the req went live; updated_at moves on every edit,
      // so the age of a req is measured from first_published where present.
      posted_at: j.first_published ?? j.updated_at ?? null,
    })),
  };
}
