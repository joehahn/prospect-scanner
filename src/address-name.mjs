// The first name and surname an email address would be built from.
//
// Moved out of lead.mjs 2026-10-24 so it can be tested. A note to a partner at
// an investment firm whose surname began with "De" went to an address built
// from its last word alone, and it expired undelivered. A particle (de, van,
// von, la...) before the last word is part of the surname, and an address
// carries it joined: jdelaurentis@, jane.delaurentis@. Apostrophes are dropped
// (o'brien -> obrien) and accents folded (Núñez -> nunez, ß -> ss), since
// neither survives into an address.
//
// A particle is a guess about the name, not a fact about it. "Van" in a
// Vietnamese name is usually a middle name, and Minh Van Contoso's address is
// mcontoso@, not mvancontoso@. So when one is absorbed, `alt` carries the last
// word alone, and the caller shows both rather than silently choosing.
//
// A middle word is the same kind of guess. Usually it is a middle name and the
// address drops it, but a two-word given name keeps it: a note to a Singapore
// director named like "Wei Ming Fabrikam" went to wei.fabrikam@ and bounced, where
// weiming.fabrikam@ was the likelier reading. `altFirst` carries the joined given
// name, shown beside the guess, never chosen over it.

const fold = (s) => String(s ?? '').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'do', 'dos',
  'du', 'la', 'le', 'van', 'von', 'ter', 'ten', 'st', 'mac', 'bin', 'ibn', 'al', 'el']);

export function nameParts(name) {
  const bits = fold(name)
    .replace(/'/g, '')
    .replace(/[^a-z\s-]/g, ' ').replace(/\b(jr|sr|ii|iii|phd|cpa|mba)\b/g, '')
    .split(/\s+/).filter(Boolean);
  // HONORIFICS ARE STRIPPED FROM THE FRONT, not from anywhere. The suffix list
  // above ran everywhere and this one cannot: `dr` is also a surname, and
  // dropping it wherever it appeared would mangle a real one. It only ever
  // masquerades as a first name when it leads.
  //
  // An executive vice chancellor came through as "Dr. Jane Doe" — the
  // title had been captured into the name field upstream — and a first.last
  // pattern turned that into dr.reeves@, which is not an address anyone holds.
  // A wrong address is the worst failure this file can produce: it fails
  // SILENTLY, so the note reads as ignored rather than undelivered, and the
  // send lands in the denominator as evidence about a market it never reached.
  while (bits.length > 2 && /^(dr|mr|mrs|ms|miss|prof|professor|rev|sir|dame|hon|sgt|capt|col|gen|lt)$/
    .test(bits[0])) bits.shift();
  if (bits.length < 2) return null;
  // A SURNAME THAT IS ONLY AN INITIAL IS NO SURNAME. LinkedIn shows "Jane
  // N." outside your network, and first-initial-last-initial built jn@ from it,
  // which bounced (2026-10-27). With one letter there is nothing to build from,
  // so no guess, and the card asks for a real address instead.
  if (bits[bits.length - 1].length < 2) return null;
  // Particles are absorbed backwards from the last word, never into the first.
  let start = bits.length - 1;
  while (start > 1 && PARTICLES.has(bits[start - 1])) start -= 1;
  const last = bits.slice(start).join('');
  const alt = bits[bits.length - 1];
  const parts = alt === last ? { first: bits[0], last } : { first: bits[0], last, alt };
  if (start > 1) parts.altFirst = bits.slice(0, start).join('').replace(/-/g, '');
  return parts;
}
