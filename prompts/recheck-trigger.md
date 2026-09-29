# Is this signal filed under the right trigger?

**Version 1, 2026-09-23.**

This signal is **live**. Nothing is wrong with it on its face. You are being
asked one narrower question: **is it filed under the trigger it belongs to?**

You are not judging the prospect, the firm's size, or whether anyone should
write to them. Gates elsewhere decide those. You are checking one label.

---

## Why this question is worth asking

Triggers in this project carry a `kind`, and the two do different jobs:

- **`kind: work`** names a piece of work. A dossier that says "no evidence names
  any work here" is saying no trigger of this kind fired.
- **`kind: urgency`** says something is in motion without saying what to build.
  It scores the firm and names no capability.

Every signal you are shown is `kind: urgency`, and it is the **only** live
signal at its firm. So every person at that firm currently reads "no evidence
names any work here" — which is correct if the label is right, and a data defect
if it is not.

Four cases of exactly this have already been found and corrected: a private
equity firm's platform acquisition filed as a generic capital event when
`new_portco` existed for it, and three integrator engagements filed as vendor
pilots. The label was wrong; the event was real.

---

## The two verdicts

### `filed_right`

The evidence says what this trigger's description says, and no other trigger
describes it better. Return this whenever it is true — it is the expected
answer, not a lesser one. An urgency event is not mislabelled merely because
labelling it `work` would be more useful to the operator.

### `wrong_trigger`

Another trigger's description fits this evidence better. Name it in
`should_be`, chosen only from the trigger ids given to you.

Be strict. The question is whether the evidence **meets the other trigger's
stated description**, not whether it is adjacent to it or could be argued into
it. If you find yourself reasoning that the event is "effectively" or
"arguably" the other thing, it is `filed_right`.

If the evidence describes something real that no existing trigger covers, say
so in `why` and leave `should_be` empty. A gap in the trigger set is a finding.
Inventing a trigger id is not.

---

## The two traps

**Do not relabel toward usefulness.** The temptation here is to find a `work`
trigger for everything, because that unblocks people. That is the same failure
as the re-judging pass this stage was built to audit, running the other way. A
firm with a genuine urgency event and no work event is correctly described as
having no work named.

**A firm's own product is not a pilot it bought.** A company launching,
expanding or demonstrating its own AI capability is describing what it sells.
That is not `vendor_led_pilot`, not `business_unit_shipped_its_own`, and not
evidence of buying anything.

## Register

`why` is one sentence, quoting the words in the evidence that decide it.
