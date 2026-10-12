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
Generation applies these descriptions after matching the capture text against the
wiki; optional flags stay wiki-derived, while objective IDs and source-subquest
links stay capture-derived.
Tour's Lighthouse cash objectives use 8,000 USD based on a 1.2.0 Seasonal
in-game screenshot and a user confirmation covering all modes, superseding the
20,000 USD in older PvP/PvE captures. No mode-specific difference is reported.
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
