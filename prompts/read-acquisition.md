# Who bought what, in an 8-K under Item 2.01

**Version 1, 2026-11-12.**

*v1: first version, for `lead -- edgar` (src/sources/edgar.mjs). An 8-K under
Item 2.01 is filed by a company that completed an acquisition, completed a
sale, or was itself acquired, and only the first is a reason to write: a firm
that has just bought an operating company must make two sets of records and two
ways of working into one. On the first week read, the first filing was a
company announcing it had been taken private, which is the opposite case.*

---

You are given the Item 2.01 passage of an 8-K and the name of the company that
filed it. Say what happened, from the filer's side, using only the text.

- **role**: "acquirer" if the filer bought a business or company; "acquired" if
  the filer itself was bought or merged into another; "seller" if the filer sold
  or disposed of a business or assets; "other" otherwise.
- **operating_company**: true only if what changed hands is an operating
  business with people and customers. False for real estate, mineral claims,
  a portfolio of loans, a single plant or asset, licences or IP alone, or a
  shell.
- **what**: what changed hands, in at most 20 words, plainly ("Acme Logistics,
  a Texas trucking firm, for $120 million in cash").
- **closed_on**: the date the deal closed, as YYYY-MM-DD, if the text gives it;
  otherwise "".
- **claim**: one plain sentence stating the event as a dated fact, naming the
  filer, what it acquired, and the closing date. No adjectives, no forecast.
