# Global variables and progression counters

A global-variable requirement compares a number with a threshold. `variableId`
identifies the value; `id` identifies the condition. Neither ID describes task
order. Preserve the comparison operator, including equality: `== 0` means the
current value equals zero, not that an event could never have occurred.

Some targets refer to groups of child variables. Others represent individual
flags or stage values. Group membership alone does not establish how tasks
contribute, how values aggregate, or whether they reset. Trader loyalty is a
separate condition. Do not infer an additional loyalty gate from cohort metadata.

For target resolution, the observations behind the registry pools, and the
remaining uncertainties, see
[`GlobalVariableValue` task gates](GLOBAL_VARIABLE_MECHANICS.md).

## What ships today

The `progressionCounters` registry maps each of the 27 published trader-tier groups
to its pool (248 tasks). It is best effort, under the standard in
[registry contract](#registry-contract):

- **23 groups are `verified`/`complete` with `distinctTaskCompletions`.** In every retained 1.1 PMC profile (one
  PVE, two PvP, two seasonal) the group's counter equals the number of completed
  pool tasks, and no capture contradicts the pool.
- **Mechanic tier 3 is `verified`/`complete` with `taskGroupCompletions`.** Four
  BEAR/USEC Gunsmith pairs each earn one point when either variant is complete;
  eight other tasks each earn one point. This fits the informative PvE and PvP
  aggregates and the current faction requirements. Shared writers and historical
  backfill rules remain hypotheses, and fresh single-variant completions have not
  been isolated in before/after captures. See
  [paired-count hypotheses](GLOBAL_VARIABLE_MECHANICS.md#mechanic-tier-3-and-ragman-tier-1-paired-count-hypotheses).
- **3 groups are `unresolved`/`partial`:** Mechanic tier 4, Prapor tier 4 and
  Ragman tier 1. Their counter reads below the completed pool count in at least one
  profile, so counting the pool can clear a threshold too early. See
  [Caveats](GLOBAL_VARIABLE_MECHANICS.md#caveats).

The `regular`, `pve` and `pvp-season` blocks use the same catalogue as a best-effort
cross-mode mapping: the `variable_group` payload is identical in the
PVE, PvP and seasonal captures. The 2026-10-14 live check serves the same 168 gates
over the same 27 variables in each mode, with every pool task present in each
mode's task list. Pool membership was observed only as far as each capture reaches:
the PVE capture contains all 248 pool tasks, the PvP capture 226 and the seasonal
capture 12, and every observed task sits in the same trader tier as in PVE.
Unobserved PvP and seasonal pool membership is extrapolated from the matching
catalogues, not independently verified by them.

These are consumers, not contributor counts: 158 live gates are on the 248
registry-pool tasks, and 10 are outside the pools. The earlier 164 count was an
API snapshot and must not be used to infer membership. Current wiki faction
requirements support the Mechanic tier-3 paired-count hypothesis, but do not
identify shared writers; reward-based exclusions and the claimed Ragman quest
chain conflict with capture/API data. See the
[current-source cross-check](GLOBAL_VARIABLE_MECHANICS.md#cross-check-against-current-wiki-and-api-data).

Existing `otherRequirements` and `taskRequirements` remain unchanged, so consumers that do
not use the registry can continue their current integration.

`evaluateTaskProgression` computes a value only when a mapping is verified,
complete, and matches the selected mode and revision. Otherwise a global-variable
requirement needs an explicit resolved account value or evaluates to `unknown`.
See the [integration example](TASK_AVAILABILITY.md#evaluate-user-progress).

## Registry contract

Entries are indexed by mode, then by the requirement's `variableId`. This example
uses fictional IDs and illustrates a verified rule; it is not game data:

```json
{
  "pve": {
    "example-variable": {
      "revision": "example-rules-v1",
      "verification": "verified",
      "coverage": "complete",
      "derivation": {
        "type": "distinctTaskCompletions",
        "taskIds": ["example-task-a", "example-task-b", "example-task-c"]
      },
      "proof": ["https://example.com/verified-progression-rule"]
    }
  }
}
```

The registry belongs in `src/additions/progressionCounters.json5`; build output
publishes it as `overlay.progressionCounters`. The JSON schema rejects unsupported
modes, derivations, duplicate contributor IDs, and missing proof links;
`npm run validate` also rejects a task listed in two groups. Runtime
validation also fails closed when a consumer bypasses source validation.

- `pool` (optional): `{ traderId, loyaltyLevel }` identifies the trader and LL1–LL4 task
  pool for player-facing explanations. Trader IDs use `TARKOV_TRADER_NAMES_BY_ID`. All 27 published
  pools in each mode include this identity, including the three unresolved pools. It does not add
  a trader-loyalty requirement, identify proven contributors, or change counting eligibility.
  Consumers may display unresolved candidates with an explicit caveat, but must not derive their
  progress from this description.
- `revision`: a maintainer-assigned identifier for the applicable game rules.
  It is not automatically the overlay version. Consumers must deliberately select
  the same identifier; omitted or mismatched revisions cannot derive a value.
- `verification`: `verified` means the mapping meets the best-effort standard
  below. `unresolved` entries are informational candidates.
- `coverage`: `complete` means the listed tasks are the whole pool as far as the
  evidence shows. `partial` mappings never produce an inferred value, even if
  marked verified.
- `distinctTaskCompletions`: each listed task contributes exactly one when
  complete in the current progression run. Duplicate events do not add points.
  This derivation is unsuitable for counters with repeat contributions, resets
  independent of task progress, shared markers, or non-task producers.
- `taskGroupCompletions`: `groups` is a nonempty list of groups, and no task may
  appear in two groups. A task-ID list contributes exactly one once **every**
  member is complete. An `{ "anyOf": [...] }` group with at least two unique task
  IDs contributes exactly one once **any** member is complete. A single task is a
  one-member list. Mechanic tier 3 uses `anyOf` for all four faction pairs;
  completing both variants in a legacy profile still earns only one point.
  No multi-task all-members group is currently published as verified.
- `proof`: public evidence links for the rule and its scope. These are review
  evidence, not a guarantee that a supplied mapping is true.

### Consumer rollout for pool descriptions

Deploy consumer support before publishing registry entries with `pool`: older strict validators
reject extra entry fields, including when evaluating otherwise verified derivations. The updated
schema and evaluator accept entries both with and without the optional identity. TarkovTracker
projects it separately from usable counters, preserves existing in-game confirmation signatures,
and presents instructions such as "Complete at least 3 LL2 tasks for Mechanic" with contributor
links. Refresh its precomputed payloads after the overlay release and verify the served overlay
identity before claiming those descriptions are live. Pool identities do not change the `1.1.0`
counting revision, derivations, verification, or coverage.

### Evidence standard

The registry is best effort, like the rest of the overlay. It does not need
proof of the server-side mechanism. Mark an entry `verified`/`complete` when:

- the counter equals the derivation's value in every retained profile for which
  the comparison is informative (a counter of 0 with no completed pool tasks
  counts as consistent, not as support), and
- no capture, public data or user report contradicts the mapping. Record the
  evidence for grouping alternatives, not just the pool membership.

Keep an entry `unresolved`/`partial` while any observation contradicts it, for
example a counter reading below the proposed derivation's value. When new evidence
contradicts a `verified` entry, flip it back rather than waiting for a full
explanation. Re-check after a progression rework. Keep raw captures and derived
research in gitignored local directories and follow the capture-evidence rules
in `AGENTS.md`.

## Evaluation rules

An explicit finite `state.globalVariables[variableId]` takes precedence over a
computed value. It must already be the effective value for the condition target.
Raw child values are not automatically summed. An invalid explicit value yields
unknown rather than falling back to a potentially contradictory inferred value.

Without an explicit value, the evaluator requires a complete verified mapping and
enough contributor statuses to settle every group. A contributor is unknown when
its own status is missing, empty, or invalid, or when its status list mixes complete
and non-complete entries. A task-ID-list group is settled at zero by any incomplete
member and scores one when every member is complete. An `anyOf` group is settled
at one by any complete member and scores zero when every member is incomplete.
A group that unknown members could still decide makes the whole counter unknown.
Incomplete history is not silently treated as zero.

`result.counters[variableId]` explains the source and includes the computed value
when known. For verified derivations it also lists completed, incomplete, and unknown
contributor task IDs, per task rather than per group. The original condition in `result.all` retains the operator and
threshold, so consumers can explain a known shortfall. Do not label every incomplete
contributor available: evaluate that task's own gates before suggesting it.

## Backward progress inference

Explicit predecessor requirements retain their accepted statuses and alternatives.
An `active OR complete` edge cannot justify marking a predecessor complete. Likewise,
a verified requirement of three distinct completions does not identify which three
occurred. Candidate sets must themselves have reachable histories; arbitrary subsets
are not valid backfills.

The evaluator reads progress and does not mutate it or implement a historical solver.
Keep confirmed task history separate from inferred constraints. Past unlocks concern
past state under the applicable rules, not necessarily a variable's current value.
Unresolved variable producers remain a boundary in backward tracing. They must not be
converted into invented prerequisite edges.
