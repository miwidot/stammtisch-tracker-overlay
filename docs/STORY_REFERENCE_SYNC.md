# Updating story coverage

The storyline uses a hash-locked primary capture plus optional hash-locked
supplemental captures. A newer login can contain fewer story templates because
the client returns subquests according to character progress. Replacing a broad
capture with a newer partial one would erase existing branches.

Supplemental references fill missing quest templates by their bare source ID.
The primary owns overlapping templates; supplements are considered in explicit
manifest order, with the first occurrence owning a previously missing template.
They do not overwrite existing objectives or change primary field authority.
When current in-game evidence contradicts an older capture's displayed requirement,
`scripts/story-chapter-meta.json` can declare `objectiveDescriptionCorrections`
keyed by stable objective ID, with a corrected `description` and its `evidence`.
Generation matches the capture text against the wiki to classify optional flags.
A correction can also supply `wikiMatchText` when a generic capture label such as
"Find the item in raid: PMC dogtag" fails to match its specific optional wiki
objective. The match text controls classification without replacing the displayed
description. Optional flags default to the wiki; evidenced `objectiveOptionalCorrections`
can override classification for specific stable IDs. Objective IDs and
source-subquest links stay capture-derived.

`parentObjectiveId` is generated from each optional condition's raw `parentId`,
after optional/main classification. It groups an optional under a main objective
in the same chapter and source subquest; several optionals can share a parent.
It is presentation metadata, not a completion dependency, shared counter, or
automatic completion rule. Visibility conditions and matching item/count pairs
are not used to guess parents. For example, Tour's dogtag collection belongs to
the Shoreline access step in the capture, even though those items can be handed
over to Prapor. The keycard and both Lab entrance options share the facility
access parent.

Generation reports link counts per chapter and warns about parent IDs that do
not resolve to a main objective. Those optionals remain ungrouped. The generator,
writer, source validator and overlay build reject invalid emitted references.
Every generation recomputes parents from the locked references, so a newly
selected capture can move, add or remove links without an ID mapping to maintain.
The existing primary/supplement ownership rules still apply: adding a newer
supplement does not replace a parent's definition in the primary capture.
Updating capture provenance does not remove evidenced description corrections;
review and retire those only when the new source actually supports the displayed
requirement. Parent grouping never rewrites quantities.

Tour's Lighthouse cash objectives use 8,000 USD based on a 1.2.0 Seasonal
in-game screenshot and a user confirmation covering all modes, superseding the
20,000 USD in older PvP/PvE captures. No mode-specific difference is reported.
Tour also records 250,000 RUB, 5 building materials or tools, 2 weapons, 3 Woods
targets and 5 PMC dogtags from the pinned quest conditions. Materials and weapons
must be found in raid for hand-in; the dogtag hand-in does not require that flag.
Curated `objectiveOrder` lists existing stable IDs in player-facing narrative order,
including access checks alongside the stages they introduce. Tour places each optional
collection immediately before its paired hand-in, refining wiki bullet order into a
logical progression without changing optional flags or quest prerequisites. Accidental
Witness follows its complete uniquely matched cached wiki sequence. Labyrinth moves
investigating the lab staff bodies before the locked office and tape, while preserving
obtain-before-read for the research report where cached wiki order is inconsistent. Unlisted future objectives
remain in capture order after the curated list; ordering never adds or removes an ID.
Generation warns when curated ordering, unlock or optionality IDs are unresolved in the
reference, allowing legitimate partial captures while making curation drift visible.
`objectiveUnlocks` places explicit stage rewards on the last required narrative objective.
These are stage-completion rewards, not rewards for that objective in isolation: notes
explain the multi-objective requirement. In-game stage rewards establish Ground Zero's
Therapist/Ragman/Interchange access, then Streets, Skier/Customs, Mechanic/Factory,
Prapor/Woods, Peacekeeper/Shoreline, Reserve, Lighthouse and The Lab. Factory represents
both daytime and nighttime access; it stays one chapter map entry. Chapter-level rewards
and unlock summaries remain available to consumers. Tour completion itself grants only the
Pathfinder achievement; trader and map rewards come from the preceding stages.

All five separate Interchange, Customs, Factory, Woods and Shoreline Visit counters are
optional alternatives with a count of 3: in-game conditions set `CounterCreator.value: 3`,
`isNecessary: false` and link `parentId`
to the corresponding survive/extract counter. Shoreline's optional display is also
corroborated by an in-game screenshot. Corrections name only those five stable IDs;
no general rule classifies other Visit objectives.

Only regular and PvE captures can supplement the shared storyline. Seasonal
captures can corroborate overlapping data but cannot define shared-mode content.

`scripts/story-reference.lock.json` records the primary capture's original hash
and coverage, each supplemental capture's hash and provenance, and
`combinedCoverage` for the merged quest templates. Capture inputs stay under the
gitignored `eft/` directory. The generation sidecar binds the entire lock to the
exact emitted payload before the writer can publish it.

To add or replace supplements in PowerShell 7.4 or newer (required for
byte-preserving native-command redirection):

```powershell
$env:STORY_REFERENCE_UPDATE_LOCK = '1'
$env:STORY_REFERENCE = 'eft/quest_list.rollinglatest.modified.json'
$env:STORY_REFERENCE_SUPPLEMENTS = '["eft/story-supplements/pve.quest_list.json","eft/story-supplements/regular.quest_list.json"]'
node --import tsx scripts/eft-story-wiki.ts
node --import tsx scripts/eft-story-generate.ts > data/eft/story-final.json
if ($LASTEXITCODE -ne 0) { throw 'Story generation failed' }
node --import tsx scripts/eft-story-write.ts
Remove-Item Env:STORY_REFERENCE_UPDATE_LOCK, Env:STORY_REFERENCE, Env:STORY_REFERENCE_SUPPLEMENTS
```

Keep the primary capture at the existing locked path, or explicitly select it
with `STORY_REFERENCE` when re-pinning. Without an explicit primary selection,
re-pinning uses the generator's coverage ranking. Passing `[]` as the supplement
list explicitly clears the supplements. Normal regeneration uses the complete
committed manifest and refuses missing or hash-mismatched inputs.

Before publishing, compare objective IDs, texts, optional flags, exclusions and
per-chapter coverage against the previous output. A missing template in a partial
capture is not evidence that an existing objective was removed. Run validation,
tests and a second generation to confirm deterministic data and lock output.
