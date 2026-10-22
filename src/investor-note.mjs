// Who buys, when the person works at an investor.
//
// Added 2026-10-22. An operating partner advising the IT functions of a large
// fund's portfolio companies was ruled out for the hourly-hands offer because
// "no AI staff are named at" the fund: the staffing question was asked of the
// fund's own people. She does not buy for the fund. She routes work to
// portfolio companies, and theirs are the IT teams that are short of hands.
// The read and the drafter are told so, in the same words.

/** Lines for a prompt about a person at an investor; '' for any other kind of firm. */
export function investorNote(org) {
  if (org?.kind !== 'investor') return '';
  return [
    `${org.name} is an investor. The buyer is one of its portfolio companies, not the fund:`,
    `this person routes work to them. Judge every offer's "Best for", and any staffing`,
    `precondition, against the portfolio companies this person serves. The fund's own`,
    `staff, and a gate that found no AI staff at the fund, say nothing about theirs.`,
    `Where nothing on file says whether a portfolio company has AI or IT staff, that is`,
    `unknown, which rules no offer out.`,
  ].join('\n');
}
