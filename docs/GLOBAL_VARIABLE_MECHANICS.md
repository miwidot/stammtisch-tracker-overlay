# `GlobalVariableValue` task gates

Reference notes for the patch 1.1.0.0 condition that tarkov.dev serves as an
`otherRequirements` entry of `type: "globalVariable"`. It answers three
questions that repeatedly cause confusion:

- why the required `value` is a small number like 1–5,
- why the referenced ID resolves to a _group_ holding N child variable IDs
  rather than to a single value,
- and what a consumer actually needs in order to decide whether the gate is
  satisfied.

This is the mechanism-and-evidence side. For what the overlay actually ships —
the `progressionCounters` registry contract, its evidence standard, and the
evaluation rules `evaluateTaskProgression` follows — see
[global variables and progression counters](GLOBAL_VARIABLES.md).

## Short answer

A `GlobalVariableValue` condition is a **numeric-state comparison**, not a flag
check. What the number means depends entirely on what `target` resolves to, and the
two cases need different handling:

- **Group target** — the value is a counter. For the 27 group IDs tarkov.dev
  currently publishes, the best-supported reading is **"how many tasks you have
  completed for one trader at one loyalty tier"**, so the condition means
  **"complete N tasks from that trader's tier-M pool"**.
- **Plain scalar target** — the value is account or world state, not a task
  counter. The 73 such targets cannot be derived from any task list; a consumer
  must supply the resolved value or evaluate `unknown`. Looking for a pool
  derivation for these is a dead end (see
  [The second family](#the-second-family-plain-variables)).

Resolve the target first ([Resolution rule](#resolution-rule)); only then does the
counter interpretation below apply.

Treat that as an observed interpretation, not an established rule. It reproduces
the profile's value for 23 of the 27 groups and matches the pool size for 20 of
27; the groups it fails on are listed in [Caveats](#caveats) and are not
explained. An aggregate match cannot show which tasks contribute or by how much,
so the mapping is best effort rather than proven: the registry publishes the 23
consistent pools plus the Mechanic tier-3 and Ragman tier-1 faction-pair
derivations, and keeps the other 2 groups unresolved. See
[the registry contract](GLOBAL_VARIABLES.md#registry-contract) for the standard.

Under that reading the group's child variables would be individual per-task
completion markers for the pool — but that is the hypothesis, not a finding: 351 of
374 children have no declared writer, so what sets them is unknown (see
[Caveats](#caveats)). Child counts track pool sizes loosely rather than exactly:
20 of 27 groups match, and across the 42 groups in the client's `variable_group`
response the observed child counts are 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18 and
36, with 8 and 9 most common. So the count is at least not a fixed structural "8";
it varies with the size of the task set involved.

## The three pieces of data

The client combines three separate payloads. Only the first is public.

| Piece                | Source                                                                                           | Shape                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| The condition        | `/client/quest/list` → `conditions.AvailableForStart[]`; tarkov.dev → `task.otherRequirements[]` | `{ conditionType: "GlobalVariableValue", target, value, compareMethod }`        |
| The group definition | `/client/variable_group`                                                                         | `{ id, variables: string[] }` — parent ID plus child variable IDs, nothing else |
| The player's values  | profile → `Variables`                                                                            | flat `Record<variableId, number>`                                               |

Notable details:

- `variable_group` carries **no** names, scopes, or metadata — only `id` and
  `variables`. There is no locale entry for either a group ID or a child ID.
- The payload was byte-identical across `pve`, `pvp` and `pvp-season` in the
  captures inspected (same SHA-256). That is an observation about those snapshots,
  not proof that the definitions are globally shared or cannot diverge by mode.
  Keep group catalogues mode-scoped — as the `progressionCounters` registry
  deliberately is — and treat a mode you have not inspected as **unknown** rather
  than reusing another mode's catalogue for it.
- Group IDs never appear in `profile.Variables`. Only children do.

## Resolution rule

The condition's `target` is **not always a group**. Resolve it in this order:

1. If `target` matches a `variable_group` `id`, the compared value is the **sum
   of that group's children** as read from `profile.Variables`.
2. Otherwise `target` is a plain variable ID and the compared value is
   `profile.Variables[target]` directly.

Step 2 needs care without a **complete** `variable_group` catalog, which is not
public — only the condition payload is — so for most consumers a failed lookup
means "not in my catalog", not "not a group". Resolve the ambiguity with the
profile rather than by guessing, using the fact that group IDs never appear in
`profile.Variables`:

- `target` is a key in `profile.Variables` → it is a scalar. Use its value.
- `target` is absent and the catalog is known complete → it is a scalar that was
  never written. Use `0`.
- `target` is absent and the catalog may be incomplete → **unknown**. It may be a
  group you cannot expand, and reading it as a scalar would miss (group IDs are
  not profile keys) and then invent a zero.

Treating an absent value as `0` is therefore only ever valid against a complete
raw payload: an unwritten group child in step 1, or the second bullet above. It
must not be carried into `TaskUnlockState.globalVariables`, which holds
already-resolved effective values: a key missing from that map means **unknown**,
not zero. The distinction is load-bearing because `==` comparisons exist: all 168
conditions tarkov.dev currently publishes use `>=`, but 60 of the 300 in the
capture compare with `==`. Only **2** of those equality conditions compare with
zero; the other 58 compare with non-zero values. An invented `0` would satisfy
an `== 0` gate and report a task available with no account evidence. This matters
when reading client data or a future API publication that includes equality gates.
`evaluateTaskProgression` leaves the value unknown when neither an explicit
resolved account value nor an eligible verified registry derivation supplies it.
The numeric evaluator receives `undefined`, never an invented `0`. Missing raw
`profile.Variables` does not prevent the 25 verified mappings (23 distinct-task
pools and the Mechanic tier-3 and Ragman tier-1 faction-pair groupings) from deriving values when the
consumer supplies enough contributor history to settle every group.

In the 1.1 PVE reference, 109 distinct targets appear across 300
`GlobalVariableValue` conditions: **36 are group IDs and 73 are plain
variables**. Treating every target as a group — or every target as a scalar —
silently misreads roughly a third of the gates either way.

Also worth noting, because it changes evaluation semantics:

- Condition placement: 179 `AvailableForStart`, 92 `AvailableForFinish`,
  29 `Fail`. Only the first is an unlock gate; `Fail` conditions _fail_ a task
  when the counter reaches a value.
- `compareMethod` is not always `>=`: 236 `>=`, 60 `==`, 4 `>`; only 2 are `== 0`.
  Equality with zero tests current state, not whether an event ever happened.
  Reset behavior is unresolved. Replacing `== 0` with `>= 0` would make every
  non-negative value pass.

## Why the counter exists: trader tier pools

Every one of the 27 IDs tarkov.dev publishes corresponds to exactly one
(trader, loyalty tier) pair. Within a tier, the trader's tasks split into two
sets: some are open as soon as the tier is reached, and the rest are staggered
behind counter thresholds.

Mechanic tier 2 illustrates the consumer/contributor distinction: its registry
pool contains 12 tasks, 9 group-gated and 3 counter-free in the capture. The live
API lists 11 tasks gated by this group, including Corporate Perks and Shady
Contractor, which are not in that pool. A gate identifies a consumer, not a writer.
The thresholds and gated task names below are from the published data and can be
re-derived with the snippet under [Reproducing](#reproducing); children, pool size,
and counter-free pool membership come from the capture:

```text
group 6a3c0fefbea2d2ad581c090b  (Mechanic, trader level 2, 12 children)
  counter-free             3 registry-pool tasks (not listed by the API query)
  GlobalVariableValue >=1  5 tasks   (Ill-Wisher, Chemistry Closet,
                                      Corporate Perks, The Secret to
                                      Productivity, Shady Contractor)
  GlobalVariableValue >=3  3 tasks   (Scout, Surveillance, Gunsmith - OP-SKS)
  GlobalVariableValue >=5  3 tasks   (Playing the Market, Gunsmith - Model 870,
                                      Secrets of Polikhim)
```

Tier access itself is a separate, ordinary condition. In the reference the
per-task `tierAccessory` field and the `TraderLoyalty` condition never
disagree: where a tier-pool task carries `TraderLoyalty`, its value equals the
task's `tierAccessory` 2/3/4, and `tierAccessory` 1 carries no loyalty condition.
Tier 2–4 tasks do not always carry one, though. Counter-gated tasks usually
don't, and eight tier-2 tasks (four Prapor, four Jaeger) have an empty
`AvailableForStart`, so `tierAccessory` is their only loyalty gate and
tarkov.dev serves them with none. `src/overrides/tasks.json5` supplies that
gate as a `traderRequirements` level entry.

`tierAccessory` is also the trader task-list grouping in the client UI. Locale
keys `UI/Quests/TraderAccessoryGroup/Tier1`–`Tier4` render as "Loyalty Level
1"–"Loyalty Level 4", and `UI/Quests/TraderAccessoryGroup/Chain` renders as
"Essential Tasks" for `tierAccessory: 0`. Those tasks sit outside the tier
pools and are gated by ordinary conditions. Example: Wet Job - Part 1
(`5a27bb8386f7741c770d2d0a`) has `tierAccessory: 0` and a lone Peacekeeper
`TraderLoyalty` 2 start condition. A 1.2.5 PvP Seasonal client lists it under
"Essential Tasks" as locked, with "Loyalty level with Peacekeeper: 2" as its
only unlock requirement. A `TraderLoyalty` condition on a `tierAccessory: 0`
task does not place it in that trader's tier pool or counter group.

For counter-gated tier-pool tasks, the shape of the unlock is:

```text
(explicit TraderLoyalty condition, if the task has one)
  AND  |completed ∩ contributors(group)| >= N
```

Both conjuncts are narrower than they look, and the exact form is given in
[Forward](#forward-no-task-prerequisites-to-recover). Tier-1 tasks carry no
`TraderLoyalty` condition, so the first conjunct must not be applied to them.
And `contributors` is not interchangeable with the tier pool: for four groups the
counter reads below the completed pool count, so counting every completed pool
task would overshoot and report a task available too early. For the other 23 the
registry treats the pool as the contributor set on a best-effort basis.
Mechanic tier 3 instead counts four faction pairs once each plus eight singletons,
and Ragman tier 1 one pair plus seven singletons; the other two shortfall groups
remain unresolved.

### Evidence

Four independent checks support the reading above.

1. **Counter equals completed count.** Using a level-55 PVE profile, the
   group's summed children equal the number of completed tasks in that
   (trader, tier) pool for **23 of 27 groups**.
2. **Child count equals pool size** for **20 of 27** groups, exactly.
3. **Explicit writes.** Two Prapor tier-2 tasks (`Capturing Outposts`,
   `Glory to CPSU`) declare a `Success` reward of `type: "GlobalVariable"`
   whose `target` is a child of the Prapor tier-2 group. Where the write is
   declared, it lands in the tier group the model predicts. These two are the
   only evidence in this bullet: the other children have no declared writer, and
   that makes their producer **unknown** rather than an implicit
   completion-time write. Do not read undeclared children as confirmed
   task-completion contributors.
4. **Independent tier derivation.** Assigning each group a tier from the
   _published_ trader-level requirements of its gated tasks (tarkov.dev plus
   this repo's overlay) reproduces the reference's `tierAccessory` for every
   group, unanimously — each group's gated tasks all sit at one trader level.

## The 27 published trader-tier groups

Trader, tier, group ID and thresholds are derived from public data
(`json.tarkov.dev/pve/tasks` + `dist/overlay.json`). "Children" and "Pool" are
aggregate counts observed in the 1.1 PVE client capture, included because they
are the point of the question; no child variable IDs are reproduced here.
Threshold counts were refreshed from all three live modes on 2026-10-14 and
include consumers outside the registry pools. They are not contributor counts.

| Trader      | Tier | Group (`variableId`)       | Children | Pool | Thresholds (tasks gated) |
| ----------- | ---- | -------------------------- | -------- | ---- | ------------------------ |
| Jaeger      | 1    | `6a43a01ccc83aceedd35f09c` | 10       | 10   | ≥1 (3), ≥3 (5)           |
| Jaeger      | 2    | `6a43a095bfef0cd74c298963` | 11       | 11   | ≥2 (2), ≥5 (2)           |
| Jaeger      | 3    | `6a43a13633c97d216dfc85de` | 12       | 12   | ≥2 (3), ≥4 (4)           |
| Jaeger      | 4    | `6a43a16dde81644a7951f31b` | 6        | 6    | ≥1 (3)                   |
| Mechanic    | 1    | `6a3171c927ca9591bf4db1c4` | 9        | 9    | ≥1 (3), ≥3 (3)           |
| Mechanic    | 2    | `6a3c0fefbea2d2ad581c090b` | 12       | 12   | ≥1 (5), ≥3 (3), ≥5 (3)   |
| Mechanic    | 3    | `6a3cf95c6b35530c4a4f532e` | 12       | 16   | ≥1 (4), ≥3 (4), ≥5 (4)   |
| Mechanic    | 4    | `6a3d1c0990e9ffe15463e961` | 6        | 5    | ≥1 (2)                   |
| Peacekeeper | 1    | `6a5ba40fe5c4eaef5610f232` | 9        | 9    | ≥1 (3), ≥3 (3)           |
| Peacekeeper | 2    | `6a5ba450a7851e16ce0bde44` | 12       | 12   | ≥1 (3), ≥3 (3), ≥5 (3)   |
| Peacekeeper | 3    | `6a5ba48b8cfd0bddb3d4d2e1` | 8        | 8    | ≥2 (2), ≥4 (2)           |
| Peacekeeper | 4    | `6a5ba4c57cbb93b629051591` | 9        | 9    | ≥1 (3), ≥3 (4)           |
| Prapor      | 1    | `6a20540cf1b67a977cc5a088` | 11       | 11   | ≥1 (2), ≥3 (3), ≥5 (3)   |
| Prapor      | 2    | `6a2688488bba18e0b0187a04` | 18       | 13   | ≥3 (3), ≥5 (3)           |
| Prapor      | 3    | `6a32651a811905ed0cac0973` | 13       | 9    | ≥1 (3), ≥3 (4)           |
| Prapor      | 4    | `6a326525789ae12ecb0b2807` | 8        | 8    | ≥1 (3), ≥2 (2)           |
| Ragman      | 1    | `6a4b339f18db62e03b4f7ded` | 8        | 9    | ≥1 (3), ≥2 (3)           |
| Ragman      | 2    | `6a4b4e6a30dac4b01af220aa` | 10       | 10   | ≥1 (1), ≥2 (3), ≥4 (3)   |
| Ragman      | 3    | `6a4b9c9a60b56d421cceea18` | 10       | 7    | ≥1 (1), ≥2 (2), ≥4 (2)   |
| Skier       | 1    | `6a59f3ba06c8949abad30871` | 9        | 9    | ≥1 (2), ≥2 (2), ≥3 (4)   |
| Skier       | 2    | `6a5a111de1f417ac80a163e5` | 12       | 12   | ≥1 (4), ≥3 (3), ≥4 (2)   |
| Skier       | 3    | `6a5a115181116e807b55f258` | 8        | 8    | ≥1 (3), ≥3 (4)           |
| Skier       | 4    | `6a5a1192efde11cc7105b18f` | 5        | 4    | ≥1 (2)                   |
| Therapist   | 1    | `6a4e4ab3ecd1145894d00990` | 9        | 9    | ≥1 (2), ≥2 (2), ≥4 (2)   |
| Therapist   | 2    | `6a4e4aed3ded7a18126603f6` | 9        | 9    | ≥1 (2), ≥2 (2), ≥4 (2)   |
| Therapist   | 3    | `6a4e4b28629dc64c4001967c` | 8        | 8    | ≥1 (3), ≥3 (3)           |
| Therapist   | 4    | `6a56925b1c30ba5a77c7c518` | 3        | 3    | ≥1 (1)                   |

Only these seven traders use tier counters. Fence, Lightkeeper, BTR, Ref and
the 1.1 story traders gate through plain variables instead (next section).
Ragman has no tier-4 group; that tier holds a single task. Whether the one implies
the other is not established.

Children ≠ Pool is not by itself a contradiction. Surplus children (Prapor tier 2
and 3, Ragman tier 3, Skier tier 4) do not stop the counter from equalling the
completed pool count, and in every retained profile it does for these four, so
the registry publishes them on a best-effort basis. Four full-pool counts are
contradicted: Mechanic tier 3 and Ragman tier 1 (fewer children than tasks), and
Mechanic tier 4 and Prapor tier 4 (not fewer). Mechanic tier 3 and Ragman tier 1
now use faction-pair derivations that fit the retained aggregates; the other two
remain unresolved. See [Unreconciled groups](#unreconciled-groups).

## The second family: plain variables

The other 73 targets are ordinary scalars used as script state, not task
counters. They come from a general-purpose variable system that the dialogue
tree also drives:

- Dialogue nodes contain 4,038 `Actions` of `type: "SetVariable"`
  (`{ variableId, value, saveScope }`) over 308 distinct variable IDs, and
  4,394 `Trigger.Conditions` of `type: "VariableValue"`
  (`{ variableId, value, operator }`).
- `saveScope` is `Dialogue` (3,507), `Profile` (367) or `Session` (164). **Only
  `Profile` scope persists into `profile.Variables`**, which is why most
  dialogue writes never surface as a task-visible value.
- Quest rewards can also write them: `rewards.{Started,Success,Fail}[]` entries
  of `type: "GlobalVariable"` (19 in the PVE reference), where `target` is the
  variable ID.

These scalars behave like story-stage counters, typically holding 0–4. The scope
of some is **unresolved**: two of them read the same non-zero value (`3` and `1`)
in both a level-55 PVE profile and a level-5 seasonal profile. That is consistent
with world state, but two profiles cannot establish it — independent per-player
variables can share a default or coincidentally reach a low value. Treat the
scope as unknown until a producer or a `saveScope` definition shows the value is
shared, and do **not** cache such a value globally and apply it to another
account. Their IDs are capture-only — not among the 27 that tarkov.dev publishes
— so they are described rather than listed here.

Practical consequence: a plain-variable gate cannot be resolved from static
data. It is genuinely account/world state, and the honest evaluation result for
an unknown value is `unknown`, never `available`. This is what
`TaskUnlockState.globalVariables` in `src/lib/task-unlocks.ts` exists to
receive.

## What is missing to evaluate these gates

`src/lib/task-unlocks.ts` already models the condition
(`type: 'globalVariable'`, `variableId`, `compareMethod`, `value`) and accepts
`globalVariables: Record<string, number>`. The gap is that **nothing published
tells a consumer which tasks belong to which pool**, so the counter cannot be
computed from a task list plus completion history.

Attempting it from public data alone does not work. Defining the pool as
"tasks whose published trader-level requirement equals the tier" reproduces the
reference counter for only **7 of 27** groups, because tasks that are free
within their tier carry no trader-level requirement upstream and are therefore
missed, while some gated tasks carry a level that differs from their pool.

The 27 registry pools hold **248 tasks** (66 at tier 1, 79 at tier 2, 68 at tier 3,
35 at tier 4). In the retained PVE templates, **158 are group-gated** and 90 have
no tier-group gate; 11 of those 90 instead have a plain-scalar start gate.
The live API check on 2026-10-14 finds 168 group gates: 158 on registry-pool tasks
and 10 on tasks outside those pools, over the same 27 targets in every mode.
The former 164 figure described a public API snapshot, not the gated subset of
the 248-task pool. Consumer counts do not establish contributor membership.
All 248 tasks already exist in that endpoint — they just lack the pool annotation. Supplying
`(trader, tier)` membership per task makes a counter computable as:

```text
globalVariables[groupId] = |completed ∩ contributors(groupId)|
```

Throughout this document, **`contributors(groupId)`** means the set of tasks that
actually increment that counter. The captures cannot identify that set directly,
so the registry uses the pool as a best-effort stand-in where the evidence is
consistent:

- **Consistent (23 groups), published `verified`/`complete`.** The counter equals
  the number of completed pool tasks in every retained PMC profile. That is not
  proof: an aggregate can match while one task contributes nothing and another
  contributes twice, and the profiles say nothing about alternate producers,
  initial values or resets. It is the best available evidence, and nothing
  contradicts it.
- **Faction alternatives (Mechanic tier 3, Ragman tier 1), published
  `verified`/`complete` with `taskGroupCompletions`.** Counting each of four
  BEAR/USEC Gunsmith pairs once, plus the other eight tasks individually, fits the
  informative Mechanic tier-3 PvE and PvP aggregates. Counting Inventory Files and
  A Big Loss once, plus the other seven, fits Ragman tier 1. Current faction
  requirements support `anyOf` for all five pairs; shared writers and backfill
  behavior remain hypotheses. See
  [paired-count hypotheses](#mechanic-tier-3-and-ragman-tier-1-paired-count-hypotheses).
- **Contradicted (2 groups), kept `unresolved`/`partial`.** The counter reads below
  the completed pool count, so counting the pool can clear a threshold too early. The
  cause is unknown: some tasks may not contribute, or a reset may have lowered the
  counter after every pool task had contributed. See [Caveats](#caveats).

If a capture or user report contradicts a published mapping, move it to the
contradicted category and set it to `unresolved`/`partial`.

Ragman's single tier-4 task is **not** in these totals: it has no counter group,
which is why the table above has no Ragman tier-4 row. Do not add it as a
contributor to any pool.

The overlay already has the vehicle for that annotation: the
`progressionCounters` registry in `src/additions/progressionCounters.json5`,
published as `overlay.progressionCounters` and consumed by
`evaluateTaskProgression`. A `distinctTaskCompletions` derivation over a pool's
task IDs is exactly the shape above, and the registry now carries it for the 23
consistent groups. Mechanic tier 3 and Ragman tier 1 instead use
`taskGroupCompletions`, with `anyOf` faction pairs and singletons. See
[the registry contract](GLOBAL_VARIABLES.md#registry-contract) for the fields and
the best-effort standard.

## Building a progression model

The forward direction is structurally determined; the reverse direction is not an
edge list and cannot be made into one. That second point is a property of the
design, not a data gap.

### Forward: no task prerequisites to recover

Across all 248 tier-pool tasks, the captured `AvailableForStart` conditions are of
only two types — `TraderLoyalty` and `GlobalVariableValue` — with **no `Quest`
condition among them**. So there is no intra-pool "task X, Y, Z" prerequisite list
to recover from these gates.

Two populations of `GlobalVariableValue` live in these 248 pool templates:
158 target a tier group and 11 tier-1 tasks target a plain variable, giving
169 captured start conditions. The latter are **not** published — the live API
check carries no `globalVariable` requirement outside the 27 group targets.
Across the full captured quest list, including non-pool consumers, 162 start
conditions target those 27 groups. These are different populations from the
168 live public gates; neither total proves agreement or pool membership.

Read that as the scope it is: no recoverable `Quest` edge in the captured start
conditions of these pools. It is **not** a licence to strip `taskRequirements`.
Upstream asserts one for one of the 248 (see below), and `AGENTS.md` requires
preserving explicit `Quest` start conditions and their accepted statuses; an
absence here is not evidence against an edge established elsewhere.

The 158 group-gated pool tasks take the predicate below. It does **not** apply to
every tier-pool task: 11 tier-1 tasks are gated on a plain variable rather than
their tier counter, distributed across four traders (Mechanic and Ragman and
Therapist with 3 each, Skier with 2 — these are task counts per trader, all at
tier 1, not tier numbers). Reading `counter(trader, tier)` for those would inspect
the wrong state entirely — they are trader-intro/world scalars, they have no
threshold over a pool, and they stay
`unknown` without account state. Branch on the condition's `variableId`: a tier
group ID takes the predicate, anything else takes the plain-variable path in
[Resolution rule](#resolution-rule).

```text
# counter-gated tasks only
available(task) =
      (task has an explicit TraderLoyalty condition
         ? traderLoyalty(task.trader) >= that condition's value
         : true)
  AND counter(task.trader, task.tier) >= task.threshold
```

Apply the loyalty conjunct **only** when the task carries that condition. Tier-1
tasks do not (`tierAccessory` 1 pairs with no `TraderLoyalty` condition), so
requiring one there invents a gate the task definition does not have, and a
consumer that supplied no trader-level value would flip a valid tier-1 unlock to
`unknown` or unavailable.

`counter(...)` is `|completed ∩ contributors(groupId)|`, which is **not**
interchangeable with `|completed ∩ pool|`. For the 23 aggregate-reconciling groups
substituting the pool reproduces the observed value in the retained profiles,
which is why the model is plausible — but as noted above that match does
not establish the contributor set, so the substitution stays a hypothesis rather
than a licence. For the four groups in [Caveats](#caveats) the substitution is
contradicted: in each the counter read **below** the number of completed pool
tasks, so counting the whole pool **overshoots** — a consumer would clear the
threshold and report a task available too early. The reason is undetermined. A
shortfall in child count fits two of the four (Mechanic tier 3 and Ragman tier 1),
but for the other two the children are not fewer than the pool at all, and in any
of the four an unresolved reset could equally explain a low reading after every
member had contributed. Mechanic tier 3 and Ragman tier 1 now use best-effort
faction-pair derivations instead of the full-pool count. Treat Mechanic tier 4 and
Prapor tier 4 as `unknown` without an explicit account value.

Each pool has 1–7 tasks carrying no counter gate, and the staggered waves are
reachable from those tasks in all 27 pools — but only once those tasks are
themselves available, which is not established. A counter-free task is not
automatically an open seed: 11 tier-1 tasks are gated on a plain variable instead,
and because that mapping is not published, which pools lose seeds that way cannot
be determined from public data. In the worst case a pool's entire counter-free set
is scalar-gated and sits at `unknown` without account state. Read the no-deadlock
property as conditional on those scalar gates being satisfied, not as a guarantee.

For corroboration, upstream asserts `taskRequirements` for only 1 of the 248,
and this overlay already corrects that entry.

### Reverse: a cardinality constraint, not a dependency

Knowing a player has a task at threshold `N` over a group tells you
`|completed ∩ contributors| >= N` and nothing more. Because there are **zero
intra-pool task edges**, no individual member is ever forced, so no specific task
can be inferred as required. Where a contributor set is verified, the number of
minimal explanations is `C(|contributors|, N)` — large enough that enumerating them
is pointless. Taking `C(Pool, N)` for each group-gated task in the table, using its
own threshold `N` and its pool size, the median is 56 and the maximum is
`C(16,5) = 4368` at Mechanic tier 3. Both are reproducible from the table, but
treat them as illustrations of magnitude rather than counts of valid histories:
Mechanic tier 3 has 16 pool tasks but only 12 contributor groups under its
published faction-pair derivation.

This does **not** license picking an `N`-subset and recording it as completed
history. The gate supplies no identity evidence, so any such subset is invented:
it can contradict the player's real history and double-count when the actual
completions later arrive. Keep the cardinality constraint instead.

What the absence of branches does buy is safety when planning **forward**, for a
pool whose contributor set is verified. There, any `N` currently-available members
will clear the threshold, and no choice among them can strand the player, because
no member fails another member and the only `Fail` conditions on pool tasks are
5 `CounterCreator` and 3 `Quest` entries, none of which target a pool task. So a
route planner may choose freely by cost; a history reconstructor may not choose at
all.

For Mechanic tier 3 and Ragman tier 1, plan by contributor group: completing either
eligible faction variant earns the pair's point, and completing both must not add
another point.

That guarantee does **not** extend to the two unresolved groups. There an
available pool task may not advance the counter at all, so completing `N` of them
can leave the threshold unmet and a planner would report false progress. Restrict
route planning to verified contributors.

### Practical guidance

- Store the counter, not synthesized edges. Rendering these gates as
  prerequisite arrows invents structure the game does not have.
- Backfilling an unknown history: record the constraint `>= N of contributors`
  rather than marking specific tasks complete, and surface the shortfall
  (`N - have`).
- Planning a route to a task, **only for a group with a verified contributor
  set**: schedule `max(0, N - have)` further contributors, not `N` — counting from
  the threshold rather than the shortfall schedules work the player has already
  done. Any available contributors will do, so pick by cost; greedy selection is
  sufficient given the seed/wave structure. Count Mechanic tier-3 and Ragman tier-1
  faction pairs once each. For the two unresolved groups an
  available task may not advance the counter, so do not plan routes or report
  progress across them.
- A missing account value must evaluate to `unknown`, never `available`.

## Caveats

- **Four groups where the counter ≠ completed count** in the level-55 profile.
  The pairs below are the counter's value versus the number of completed pool
  tasks — not children versus pool size: Mechanic tier 3 (12 vs 16), Mechanic
  tier 4 (3 vs 4), Prapor tier 4 (6 vs 7), Ragman tier 1 (8 vs 9). In every case
  the counter reads lower, which is inconsistent with the pool being counted
  one-per-task. What the retained captures narrow down per group is in
  [Unreconciled groups](#unreconciled-groups). The published Mechanic tier-3 and
  Ragman tier-1 faction-pair derivations reconcile their aggregates; no individual writer is
  established for any of the four.
- **Seven groups where children ≠ pool size**, including Prapor tier 2
  (18 children vs 13 tasks) and Prapor tier 3 (13 vs 9). The surplus children are
  plausibly retired or mode-specific markers, which is unverified. For the four
  surplus groups whose counter matches the completed pool count in every retained
  profile, the mismatch does not contradict the count, so they are published.
- **351 of 374 child variables have no writer anywhere in the client payloads.**
  That makes their producer **unknown**, not confirmed: the write happens
  server-side, but nothing here shows it happens on task completion rather than at
  profile initialisation or on some other server event. Either way the child → task
  mapping is not statically derivable, and only the aggregate count is usable.
  Do not treat this as evidence for a contributor mapping.
- `TradersInfo` entries no longer carry `loyaltyLevel` (keys are `unlocked`,
  `disabled`, `salesSum`, `standing`, `dialogueAvailable`). Trader tier is not
  readable from the profile directly.
- Everything here is from 1.1 captures (client `1.1.0.1.46699` / `.46911`) plus
  a live tarkov.dev read. Group membership and thresholds are BSG data and can
  change between patches; re-verify after a task rework.

## Unreconciled groups

Evidence scope: the level-55 PVE profile, a level-42 PVP profile captured after
1.1, and two seasonal profiles, read against their own `quest_list`. The captures
are local and untracked; per the policy above, child variables are described by
count, never by ID. Every captured member has `side: Pmc`, but that field alone
does not establish faction eligibility: the current wiki describes eight Mechanic
tier-3 Gunsmith tasks as faction-exclusive (see below). Fail/restart flags do not
isolate the shortfalls: the only restartable members (Escort in Prapor tier 4, Psycho Sniper
in Mechanic tier 4) are not distinguished from restartable tasks that counted in
consistent groups (The Guide, Bullshit), and failed pool tasks elsewhere correctly
do not count.

**Common pattern.** The retained completion history is consistent with one point
per post-1.1 completion and shortfalls in how pre-1.1 history was credited.
These are profile snapshots, not isolated before/after observations of each
completion. They support a backfill explanation but do not establish the write
rule or show that fresh completions will reproduce the same shortfall.

### Mechanic tier 3 and Ragman tier 1: paired-count hypotheses

- **Mechanic tier 3.** 16 tasks, 12 children. PVE reads 12 for 16 completed; PVP
  reads 7 for 11 completed. Both are short by exactly 4. The 8 Gunsmith tasks in
  the pool unlock in pairs at the same threshold (free: AKM, M4A1; ≥1: AKS-74N,
  P226R; ≥3: AK-105, Vector 9x19; ≥5: MPX, AS VAL). If each pair is one point,
  the 8 other tasks plus 4 pairs give 12, matching the child count. The PVP
  profile has all 8 Gunsmith tasks plus 3 others completed (7 = 4 + 3). The 5
  extra tasks complete in PVE coincide with exactly 5 additional set children.
- **Ragman tier 1.** 9 tasks, 8 children. PVE reads 8 for 9; PVP reads 2 for 3.
  A seasonal profile has Make ULTRA Great Again and Fuel Crisis complete, with
  2 set children. The PVP profile's Make ULTRA Great Again, Inventory Files and
  A Big Loss coincide with only 2 set children. Inventory Files and A Big Loss
  (both ≥1) sharing a child, one not counting, or a backfill omission all fit.

Neither observed aggregate fits `distinctTaskCompletions` over the full pool.
A paired-count derivation fits both informative profiles, but is not the only
explanation. Mechanic tier 3 is published as a best-effort mapping: its four pairs
have independent faction-eligibility evidence, and each pair uses `anyOf`, so a
current player's single eligible variant can earn its point. The PvE aggregate is
8 singletons + 4 pairs = 12; the PvP aggregate is 3 singletons + 4 pairs = 7.
Those profiles completed both variants, so they do not isolate the current
single-variant write rule or prove that each pair shares a child. Seasonal
membership is extrapolated from the matching catalogue, as documented in
[the registry scope](GLOBAL_VARIABLES.md#what-ships-today). No retained aggregate
contradicts this mapping; re-check it with current-faction before/after captures.

Ragman tier 1 is published the same way. The [SPT quest config](https://github.com/SP-Tushonka/server-csharp/blob/794b0d5c6b/Libraries/SPTushonka.Server.Assets/SPT_Data/configs/quest.json) lists Inventory Files as
BEAR-only and A Big Loss as USEC-only. That gives the pair the faction-eligibility evidence it previously lacked,
so it uses `anyOf`: either variant earns the pair's point, and a legacy profile
that completed both earns one. The PvE aggregate is 7 singletons + 1 pair = 8;
the PvP aggregate is Make ULTRA Great Again + 1 pair = 2. A partly completed pair
has not been isolated, so a fresh single-variant completion is extrapolated, as
for Mechanic tier 3.

Other BEAR/USEC pairs in the same SPT list sit in pools with one child per task:
Justice/Trophy (Jaeger tier 1), the two Huntsman Path - Administrator variants
(Jaeger tier 3), Oil Run/Shaking Up the Teller (Prapor tier 1), and
Vitamins/Supplements and Debtor/House Arrest (Skier tier 2). Their counters
matched the full completed pool count in every retained profile, so they keep
`distinctTaskCompletions`.

### Prapor tier 4: one-point shortfall, cause unidentified

8 tasks, 8 children. PVE reads 6 for 7 completed (Escort is not completed), with 2
children unset. The PVP profile reads 4 for 4 completed (Regulated Materials,
Intimidator, Getting Some Air, Unique Experience), consistent with all four
counting, including two completed after 1.1. Under a stable one-point contributor
model, the missing contributor would be **Best Job in the World**, **The Art of
Explosion** or **Special Order**. A profile-specific backfill omission could also
affect one of the four that counted in PvP; the snapshots do not exclude that.

The Art of Explosion starts on Prapor LL4 alone, but so do Regulated Materials
and Getting Some Air, which fit the reconciling PvP total. Its captured tier,
side and start-condition shape do not isolate it as the missing contributor.
Neither completion order nor a counter-free start proves exclusion from the
counter. The retained evidence does not identify which completion was omitted.

### Mechanic tier 4: one-point shortfall, cause unidentified

5 tasks, 6 children. PVE reads 3 for 4 completed (Shooter Born in Heaven, Goals
and Means, Calibration, Psycho Sniper; Setting Priorities is not completed). No
profile isolates which of the four did not count.

### Cross-check against current wiki and API data

Checked on 2026-10-14 against the retained 1.1 captures, current source registry,
all three [live task endpoints](https://json.tarkov.dev/pve/tasks), and the wiki
pages' wikitext through `api.php`. Wiki requirements and rewards are useful
best-effort evidence, but a reward signature does not identify a counter writer.

- **Mechanic tier 3:** the wiki Requirements sections identify BEAR-only
  [AKM](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_AKM),
  [AKS-74N](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_AKS-74N),
  [AK-105](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_AK-105), and
  [AS VAL](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_AS_VAL), paired by
  captured threshold with USEC-only
  [M4A1](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_M4A1),
  [P226R](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_P226R),
  [Vector 9x19](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Vector_9x19), and
  [MPX](https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_MPX).
  Counting each pair once fits 12/16 in PVE and 7/11 in PvP. It does not distinguish
  a shared child from crediting only the player's faction variant during backfill.
  All eight were `factionName: "Any"` upstream at that check. On 2026-10-19,
  upstream serves BEAR for AKM and USEC for M4A1 in all three modes, so their
  faction overrides were retired in #506. The other six had no faction override.
  Current wiki eligibility is
  not proof of how older completed IDs were credited. The suggested lower-tier
  MP-133/Model 870 and AKS-74U/HK MP5 pairings are not supported by faction
  restrictions on their current wiki pages; MP-133 and Model 870 also occupy
  different tiers.
- **Ragman tier 1:** both Inventory Files and A Big Loss have independent
  `group >= 1` start gates, with no `Quest` prerequisite between them, in the
  capture and live API. Both have 3,000 EXP and +0.1 reputation there.
  [Inventory Files](https://escapefromtarkov.fandom.com/wiki/Inventory_Files)
  still lists 8,400 EXP and +0.03 reputation on the wiki, so that reward comparison
  is a source disagreement, not evidence of a non-contributing setup step.
  Counting the two tasks as one fits the observed totals. The [SPT quest config](https://github.com/SP-Tushonka/server-csharp/blob/794b0d5c6b/Libraries/SPTushonka.Server.Assets/SPT_Data/configs/quest.json) lists
  Inventory Files as BEAR-only and A Big Loss as USEC-only, so the registry counts
  them as an `anyOf` faction pair rather than a "payoff task only" rule.
- **Hot Delivery:** the [wiki](https://escapefromtarkov.fandom.com/wiki/Hot_Delivery)
  corroborates LL2 and the tier-2 reward signature. The capture and live API gate
  it on Ragman's **tier-2** group `6a4b4e6a30dac4b01af220aa >= 2`, not the
  tier-1 group at `>= 5`. It is already in the tier-2 registry pool, not tier 1.
  The proposed tier-2 ID `6a3cf76a51a600d97d1d6b05` is absent from both the
  retained group catalogue and live gates.
- **Mechanic tier 4:** the [Calibration wiki page](https://escapefromtarkov.fandom.com/wiki/Calibration)
  omits Mechanic reputation, but the capture and all live modes give +1.5.
  Calibration and Setting Priorities start on Mechanic LL4 alone, not on group
  thresholds `>= 1` and `>= 2`. The 3/4 aggregate therefore does not identify
  Calibration as the non-contributor or establish the proposed early-unlock
  scenario. [Hobby Club](https://escapefromtarkov.fandom.com/wiki/Hobby_Club)
  is LL4-gated but has captured `tierAccessory: 0`; loyalty alone does not place
  it in this pool.
- **Prapor tier 4:** the correct published group is
  `6a326525789ae12ecb0b2807`, with 8 children and 8 pool tasks, including
  [Unique Experience](https://escapefromtarkov.fandom.com/wiki/Unique_Experience).
  The proposed `6a3cfa44732fbff76561e307` appears in neither the retained group
  catalogue nor current public gates. PvP reads **4/4**, not 0/0. Escort is not
  completed in the informative PVE profile, and Intimidator is complete in the
  reconciling PvP profile; neither is supported as its missing contributor.
  Escort and Special Order require `>= 2`; Intimidator requires `>= 1`, not `>= 5`.

The shipped registry is `src/additions/progressionCounters.json5`, using
`derivation.taskIds` or `derivation.groups`; it has no `countPoolTasks` field. Counter resolution is
`resolveCounter` in `src/lib/task-progression.ts`, not `deriveCounterValue` in
`src/lib/globalVariables.ts`. There is no `npm run triage` command. A future pool
audit should distinguish consumers from producers and flag tier/reward
disagreements for investigation, rather than make them automatic inclusion or
exclusion rules. The grouped derivation has matching schema, types, runtime
validation, and unknown-history semantics; a simple `.some(completed)` alone
would turn missing history into an invented zero.

### Decisive tests

- Prapor tier 4: a 1.1 profile that completes The Art of Explosion (or Best Job in
  the World, or Special Order) as the only change between two captures.
- Mechanic tier 4: the same for each of its four completed tasks.
- Mechanic tier 3: isolate a current-faction Gunsmith completion between captures
  and check that it advances the counter by one. Repeat for both factions and all
  four pairs, across fresh and migrated histories. A current player cannot
  complete both faction variants to test the second completion in the same run.
- Ragman tier 1: isolate a current-faction Inventory Files (BEAR) or A Big Loss
  (USEC) completion between captures and check that it advances the counter by
  one. Repeat for both factions and fresh/migrated histories.

## Reproducing

All reference-side figures come from the gitignored local capture under
`data/reference/combined/<mode>/`, using `variable_group.json`, `quests.json`,
`dialogue.json` and `profile_list.json`. Public-side figures come from
`json.tarkov.dev/pve/tasks`, `json.tarkov.dev/pve/traders` and
`dist/overlay.json`.

The published condition can be listed without any local capture:

```bash
curl -s https://json.tarkov.dev/pve/tasks \
  | jq '[.data.tasks[].otherRequirements[]? | select(.type=="globalVariable")] | length'
# 168 conditions on 2026-10-14 (27 distinct variableIds, checked separately)
```

Every threshold in the table, and the gated task names for any one group, come
from the same endpoint. Names arrive as translation keys (`"<taskId> name"`), so
this resolves them through `tasks_en`; the output is the Mechanic tier-2 listing
shown earlier verbatim:

```bash
GROUP=6a3c0fefbea2d2ad581c090b
curl -s https://json.tarkov.dev/pve/tasks    -o /tmp/tasks.json
curl -s https://json.tarkov.dev/pve/tasks_en -o /tmp/tasks_en.json
jq -r -n --slurpfile t /tmp/tasks.json --slurpfile en /tmp/tasks_en.json --arg g "$GROUP" '
  ($en[0].data) as $L
  | [ $t[0].data.tasks[]
      | . as $task
      | (.otherRequirements[]? | select(.type=="globalVariable" and .variableId==$g))
      | { value, name: ($L[$task.name] // $task.name) } ]
  | group_by(.value)[]
  | ">=\(.[0].value) (\(length)): \(map(.name) | join(", "))"'
# >=1 (5): Ill-Wisher, Chemistry Closet, Corporate Perks, The Secret to Productivity, Shady Contractor
# >=3 (3): Scout, Surveillance, Gunsmith - OP-SKS
# >=5 (3): Playing the Market, Gunsmith - Model 870, Secrets of Polikhim
```

This repository's `fetchTasks` adapter (`src/lib/tarkov-api.ts`) performs the same
translation lookup, so a script can call it instead of resolving keys by hand.

### Why this document is tracked

It references capture evidence as `AGENTS.md` allows (reference cross-check
tooling): it describes what the capture shows, names tasks only by identifiers
tarkov.dev already publishes, and reproduces no raw capture contents or reference
field values.
