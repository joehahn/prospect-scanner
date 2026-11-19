# Who was appointed, in an 8-K under Item 5.02

**Version 1, 2026-11-18.**

*v1: first version, for `lead -- edgar` (src/sources/edgar.mjs). An 8-K under
Item 5.02 is filed when a public company's directors or senior officers leave,
are elected or are appointed. Only an officer newly appointed to run part of
the business is a reason to write: a person new to a seat is setting priorities
and has not yet settled who helps them. Departures, director elections and
changes to pay are not.*

---

You are given the Item 5.02 passage of an 8-K and the name of the company that
filed it. List each person the text says was **appointed or promoted to an
officer role** at the filer, using only the text.

Leave out:
- people who resigned, retired, were terminated or are leaving;
- directors elected to the board, unless also appointed to an officer role;
- people whose only change is pay, a bonus, an equity award or a contract
  amendment;
- people at another company.

For each person:
- **name**: as written, without honorifics.
- **title**: the officer title they were appointed to, as written.
- **interim**: true if the text calls the appointment interim or acting.
- **from_outside**: true if the text says they join from another company;
  false if they were already at the filer; false if the text does not say.
- **effective_on**: the date the appointment takes effect, as YYYY-MM-DD, if
  the text gives it; otherwise "".
- **claim**: one plain sentence stating the appointment as a dated fact, naming
  the person, the title, the filer and the date. No adjectives, no forecast.

If nobody was appointed to an officer role, return an empty list.
