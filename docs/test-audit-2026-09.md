# Test audit 2026-09: evidence

Evidence for the test-reduction branch (plan approved via /autoplan). Sections are added by the commit they support.

## B8 pre-spend estimate (recorded 2026-09-29, before any B8 paid run)

Source: latest weekly periodic artifacts (runs 36385945043 = 09-28, 35567915613 = 09-21), per-shard eval JSON cost_usd.
Price ratio from test/helpers/pricing.ts: claude-fable-5-1 (default capture, lib/eval-model.ts) $10/$50 per MTok in/out;
claude-opus-4-7 $15/$75 (ratio 0.667 on both); claude-sonnet-4-6 $3/$15 (ratio 3.33 on both).

| Files | Old pin | Weekly $ (09-28) | Est. weekly $ on default | Delta |
|---|---|---:|---:|---:|
| plan, design, plan-prosons, plan-format, qa-bugs, retro, office-hours-phase4 | opus-4-7 | 15.78 | 10.52 | −5.26 |
| office-hours, office-hours-brain-writeback | sonnet-4-6 | 0.91 | 3.03 | +2.12 |
| auq-matrix, workflow | opus-4-7 | no result in the retained artifacts | — | ≤ 0 (ratio 0.667) |
| **B8 total** | | 16.69 | 13.55 | **−3.14** |

Assumes the same token volume per case (a verbosity change moves this; the ratio applies to input and output alike).
Wall clock: unchanged shard walls (budgets do not depend on model). Drop threshold, fixed now: B8 is dropped from this PR
if its estimated net weekly dollars after C and B5 savings are above zero. Estimated net: −3.14 (B8) − C savings
(five retired evals) − B5 savings (18 hollow shards, 23 census judges) < 0 → B8 proceeds to its one paid run.
Fallback check: `git log -S claude-sonnet-4-6` on skill-e2e-office-hours and -brain-writeback shows only 636175d / #2264
(infra hardening), no cost rationale → both re-pinned.
