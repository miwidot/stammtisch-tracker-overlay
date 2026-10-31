# Repository Guidelines

## Project Overview

Community-maintained data overlay for tarkov.dev API corrections and additions. Provides a JSON overlay file that consumers merge with tarkov.dev API responses to fix incorrect data or add missing data types (like game editions).

## Evidence Standard

The overlay is **best effort**, not a proof system. Ship a correction or addition
when the best available evidence supports it and nothing known contradicts it.
Record the evidence and its scope (which modes, captures or sources it covers) in
comments, docs or PR text so the next contributor can judge it. When a capture,
public data or a user report contradicts a shipped value, correct it or flip it
back; that is the normal feedback loop, not a failure.

- Hold data back only when concrete evidence contradicts it, not because the
  underlying game mechanism is unproven.
- The field-authority rules below (`taskRequirements`, `minPlayerLevel`,
  `traderRequirements`) stay binding: each one exists because getting it wrong
  shipped a regression.
- Reviewers, human or bot: report contradictions, unsourced values, rule
  violations and overstated evidence scope. Do not block a change solely because
  a best-effort value lacks mechanism-level proof.

## Project Structure & Module Organization

`src/overrides/` holds JSON5 corrections keyed by tarkov.dev IDs, while `src/additions/` contains new data types (for example game editions). `src/schemas/` stores JSON Schemas, and `src/lib/` houses shared TypeScript utilities used by scripts in `scripts/`. Built output lands in `dist/overlay.json`. Tests live in `tests/`, with docs in `docs/`. The gitignored `data/` directory holds local references, historical evidence, caches, and validation results; see `docs/LOCAL_DATA.md`.

## Architecture

### Shared Library (src/lib/)

Scripts share utilities via `src/lib/index.ts`:

- `file-loader.ts` - JSON5/JSON loading, project paths, directory scanning
- `script-utils.ts` - CLI entry-point detection (`isDirectExecution`) and `sleep`
- `tarkov-api.ts` - json.tarkov.dev adapter that fetches the static per-mode JSON endpoints (tasks/items/maps/traders plus `_en` translations) and adapts them into the `TaskData[]` shape
- `task-validator.ts` - Override validation logic against API data
- `terminal.ts` - Console output formatting (colors, icons, progress, summary sections)
- `types.ts` - Shared TypeScript interfaces and schema configs

The wiki comparison tool is modular: `scripts/wiki-compare.ts` is a thin entry point re-exporting the public/test API, with the implementation in `scripts/wiki-compare/` (`types`, `cache`, `overlay`, `normalize`, `api`, `wiki`, `compare`, `cli`). Shared reference-file parsing (`findReferenceFile`, `parseEftTasks`, `detectReferenceMode`, `parseModeArgs`, `requireMatchingReferenceMode`) lives in `scripts/eft-compare.ts` and is imported by the other `eft:*` scripts.

### Build Pipeline

1. `scripts/validate.ts` - Validates JSON5 source files against schemas using AJV
2. `scripts/build.ts` - Compiles JSON5 sources into single `dist/overlay.json` with metadata
3. `.github/workflows/release.yml` - After CI passes on `main`, verifies the CI-built overlay against sources (`build:check`) and commits it as `chore: build overlay [skip ci]`. It is the only writer of `dist/overlay.json`; PR CI rejects changes to that file so merges never conflict on generated output.

### Output Structure

The built `dist/overlay.json` contains entity sections keyed by tarkov.dev IDs (tasks, items, etc.) plus a `$meta` object with version, generated timestamp, and SHA256 hash.

### Game Modes

Two mode lists live in `src/lib/types.ts`:

- `SUPPORTED_GAME_MODES` (`regular`, `pve`, `pvp-season`) — the modes tarkov.dev
  serves upstream, as reported by `json.tarkov.dev/endpoints` (`gameModes`).
  `pvp-season` is BSG's Seasonal Character (patch 1.1.0.0) and is served like any
  other mode (`/{mode}/tasks`, `items`, `maps`, `traders`, `hideout`, ...).
  Everything that fetches/compares against tarkov.dev iterates this list, and
  `build.ts`/`validate.ts` iterate it for `src/overrides/modes/<mode>/` sections.
- `DIVERGENCE_MODES` aliases `SUPPORTED_GAME_MODES`, so divergence validation
  can adjudicate `regular`, `pve`, and `pvp-season`. Registry fields may omit a
  mode until its true value is independently verified; omission must not be
  interpreted as equality with another mode.

Seasonal perk metadata is served at `pvp-season/season`, with translations at
`pvp-season/season_en`. `src/additions/seasonalPerks.json5` (schema
`seasonal-perk.schema.json`) supplements only raw effects missing upstream,
keyed by BSG perk id. Keep metadata upstream and omit empty or stub effects.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run validate` validates JSON5 sources against schemas (run before opening a PR).
- `npm run build` generates `dist/overlay.json` from sources.
- `npm run check-overrides` compares overrides to the live tarkov.dev API.
- `npm run typecheck` runs `tsc --noEmit` (also run in CI).
- `npm test` runs the Vitest suite (also run in CI); `npm run test:watch` keeps it running.
- `npm run format` / `npm run format:check` run Prettier over the TypeScript, JSON/JSON5, and Markdown sources (`format:check` also runs in CI).
- Example single test: `npx vitest run tests/file-loader.test.ts`.
- `pwsh scripts/ci-local.ps1 -Branch <branch>` runs the `ci.yml` validation steps locally on the PR merge commit of the pushed branch; add `-Local` to test committed but unpushed fixes (see `docs/CONTRIBUTING.md`). Use it as CI evidence when hosted and self-hosted runners are unavailable, and with `-Local` before pushing review fixes.

### Reference cross-check tooling (local-only)

The `eft:*` scripts cross-check the overlay against a local quest reference -
values verified in-game and kept out of the repo - which is the authority for
numeric quest fields (experience, minPlayerLevel, objective counts). The
reference lives only in `data/reference/` and all derived output in `data/` — gitignored. Top-level `eft/` is retired; there is no fallback to it. The nested `data/eft/` directory remains the output location for the `eft:*` tools.
Versioned captures go in subdirectories (`data/reference/<capture>/`); `findReferenceFile`
scans recursively and auto-detects the most recently captured `quest_list`
reference, so a fresh dump supersedes an older one without touching the tooling
call sites (pass an explicit `eftDir` to pin a specific capture).
Keep the raw reference (captures, dumps) and the tools' field-by-field diff
output out of the repo; they stay in the gitignored `data/`. Captures
and dumps are provided anonymously and privately to update the data — naming
that a value comes from an in-game capture or dump is fine. Beyond that,
capture evidence may be referenced openly: comments, PR and issue text, and
docs can say a value was verified against an in-game capture and describe the
game data it shows (conditions, rewards, quest/item/recipe ids, client version,
game mode). Keep public proof links alongside it where they exist.

Protect the provider, not the game data. Never expose specifics of a capture
itself or of the person who made it: no local filesystem paths, exact capture
dates or timestamps, session or file names, account/profile/character
identifiers, server hosts, or other PII or sensitive details. Refer to a
capture generically instead (for example "a 1.1 PvE capture").

- `npm run eft:normalize` distills the local reference into a clean
  tarkov.dev-shaped `data/eft/quests.<mode>.json`.
- `npm run eft:compare` lists where the reference disagrees with the live API.
- `npm run eft:wiki` cross-references those reference-vs-API discrepancies
  against the EFT wiki, showing whether the wiki backs the reference, the API,
  or neither (minPlayerLevel and experience only).
- `npm run eft:audit` is the three-way `reference -> API -> overrides` check.
  Per field it reports GAP (API wrong, no override — add one), STALE (API fixed
  upstream, override redundant — remove it), CONFLICT (override disagrees with
  the reference — fix it), or OK (override correct and still needed). It covers
  `experience`, `minPlayerLevel`, objective counts, and `taskRequirements`. The
  reference is mode-specific; the audit auto-detects its mode and refuses a
  mismatched `--mode` to avoid false positives.

  Field authority differs, and getting this wrong has shipped regressions.
  Patch 1.1.0.0 expresses most trader-loyalty gates as `GlobalVariableValue`
  start conditions against opaque per-tier variables rather than as
  `TraderLoyalty` conditions, and tarkov.dev serves those as
  `otherRequirements` `globalVariable` entries. A `GlobalVariableValue` is a
  numeric state gate, though — not automatically a loyalty condition or a task
  prerequisite list. See `docs/GLOBAL_VARIABLES.md` for the counter evidence
  standard. That distinction drives all three rules below:
  - `taskRequirements` — preserve explicit `Quest` start conditions and their
    accepted statuses. The wiki's infobox `previous` field is narrative order,
    **not** proof of an unlock edge. Distinguish a present template carrying no
    `Quest` condition from a task missing from the capture entirely; only the
    former licenses `taskRequirements: []`.
  - `minPlayerLevel` — absence of an explicit `Level` condition does **not**
    authorize `0`. Template status values alone do not prove capture
    completeness, so treat the explicit-gate list as a floor on what exists
    rather than a closed set. Upstream also _derives_ `minPlayerLevel` from the
    loyalty tier's `requiredPlayerLevel` when a task is loyalty-gated, so a
    missing `Level` condition means "no explicit gate", not "no gate", and
    zeroing those would discard a correct derived floor. Check trader and
    predecessor-derived floors plus the wiki Requirements section, and only
    correct the field when upstream's value matches none of them.
  - `traderRequirements` — **not** auditable against the reference, which is why
    `eft:audit` deliberately does not cover it. Because the gate lives in a
    global variable, the client shows no `TraderLoyalty` condition even for tasks
    that do have a loyalty gate; treating absence as "no gate" would falsely
    condemn 150+ correct overrides. Use explicit loyalty conditions and the
    corroborated wiki Requirements section. A candidate cohort tier must not
    automatically become an extra runtime gate.

- `npm run eft:coverage` is the full check of what consumers see against the
  reference. It covers every reference quest, not only those tarkov.dev serves:
  each is classified as upstream (compared after applying effective overrides),
  addition, placeholder (matched by name and trader, printing the placeholder ->
  real id and objective mapping for issue #507), story, hidden helper, or
  missing. Per quest it compares name, trader, map, experience, explicit Level,
  Quest prerequisites and statuses, availability delay, explicit TraderLoyalty
  and GlobalVariableValue gates, objective presence/counts/text, and finish
  rewards (weapon presets compared by base item). The field-authority rules
  above still apply: absent Level/TraderLoyalty conditions are never flagged,
  and prerequisite targets tarkov.dev cannot represent are info, not edges to
  add. A quest absent from the reference proves nothing (quest lists are
  account-scoped). Check the reference's client version before acting on rows
  from an older capture.
- `npm run eft:diff -- --mode <mode>` compares the quest definitions of the two
  newest references for a mode (or two given files), ignoring per-account
  progress: added/removed quests and changed fields, localization summarized
  unless `--text`. Quest lists are account-scoped, so an added or removed quest
  may only mean the two accounts could see different quests; compare captures
  from the same account before treating it as a game change.
- `npm run eft:import -- <decoded-session-dir>` files a decoded capture's
  `pve`/`pvp`/`pvp-season` folders under `data/reference/decoded/<session>/`
  without overwriting different files.
- `npm run eft:remote -- --mode regular|pvp-season` saves the remote session's
  live quest list (RemoteSession LAN API, `REMOTE_SESSION_URL` or `--url`) to
  `data/reference/remote/<mode>/` as a reference the other tools read. It makes
  one paced game request, skips writing when definitions are unchanged, and
  stores no host, session or account identifiers. Never commit the URL.

- `npm run eft:story` regenerates `src/additions/storyChapters.json5` from the
  reference. Story quests are entirely absent from tarkov.dev, so unlike the
  numeric `eft:*` tools this one produces committed additions, not a gitignored
  diff. It takes objective text/order/ids from the local reference for structure
  and the optional/required flags plus proof from the EFT wiki, merges curated
  chapter metadata from `scripts/story-chapter-meta.json`, and derives The
  Ticket's branch model (chapter-level `endings` with the real
  `client/ending_list` ids, plus per-chapter `referenceCoverage`) from the
  capture rather than from curated slugs. The reference itself stays gitignored;
  only the generated JSON5 is committed. The pipeline is pure TypeScript
  (`eft-story-wiki.ts` -> `eft-story-generate.ts` -> `eft-story-write.ts`);
  fuzzy optional-matching uses a faithful difflib `SequenceMatcher.ratio()`
  port in `scripts/lib/sequence-matcher.ts`.

  Generation is local-only and cannot run in CI or for a contributor without the
  capture. What keeps the committed output auditable is
  `scripts/story-reference.lock.json`, a committed provenance lock. It is the one
  committed place that records capture provenance: relative filename, SHA-256,
  byte size, client version, game mode, capture timestamp, and how much of the
  storyline that capture resolved (quest count, chapter quests, objective
  texts). Keep the filename relative (never absolute or user-specific local
  paths) and never include account/profile/character identifiers, server hosts,
  or other provider PII. It reproduces
  no field values — no experience, no level gates, no objective text, no ids.
  The generator refuses to guess: it uses the locked capture and fails if the
  hash no longer matches, and `STORY_REFERENCE_UPDATE_LOCK=1` is the only way to
  re-pin, so switching source captures always lands as a reviewable lock diff
  next to the regenerated data. `STORY_REFERENCE=<file>` only relaxes the _path_
  (a moved or renamed copy within `data/reference/`); its hash must still match, so
  it cannot swap in a different capture. The generator stages a sidecar binding
  the capture to the exact payload it emits, and `eft-story-write.ts` refuses to
  replace the artifact without one - so an edited or unrelated
  `data/eft/story-final.json` cannot be published under the committed lock.
  Where another run already staged a binding for the same payload, staging is
  exclusive: an identical binding is idempotent, a binding for a different
  capture is refused rather than clobbered, so overlapping runs cannot promote
  each other's pin. Note the pinned capture is not
  necessarily the newest one: the client returns a story sub-quest template only
  once the player has reached it, so an older capture from an advanced character
  resolves more of the storyline than a fresh one from an early character, and
  the lock's `clientVersion` may therefore predate the current patch. Check it
  before assuming the storyline data reflects the latest build.

## Coding Style & Naming Conventions

TypeScript uses 2-space indentation, semicolons, and ESM imports (see `"type": "module"`). Data files are JSON5 and may include comments. Use tarkov.dev entity IDs as keys and field names that match the tarkov.dev API exactly (camelCase). Every correction must include: entity name comment, proof link, and inline “Was:” value. For nested patches (like task objectives), use ID-keyed objects rather than arrays. To drop an objective tarkov.dev serves but the game lacks, list its upstream ID in `objectivesRemove` (shared and mode removals union); back it with proof that the objective is absent (an in-game capture or other proof, as for any correction) and a `Was:` comment. Empty override files are valid and skipped during build. When adding a new entity type, add its schema to `SCHEMA_CONFIGS` in `src/lib/types.ts`.

## Testing Guidelines

Vitest is the only test framework. Tests should be named `*.test.ts` under `tests/`. There is no explicit coverage gate, but add or update tests when you change shared library behavior or validation logic.

## Static Analysis Findings

Fix fallow findings at their root whenever the code can be safely consolidated, simplified, removed, or covered by tests. Do not add `fallow-ignore` suppressions for resolvable findings; suppressions must be reserved for genuinely unavoidable tool false positives or external/runtime constraints, include a specific reason, and receive explicit reviewer approval.

`npm run fallow:security` reports candidates rather than confirmed vulnerabilities and
exits 0; CI checks only newly introduced ones (`--gate new --changed-since <base>`), and
because `main` is not branch-protected a red result reports rather than blocks. The remaining
candidates were triaged and are all tool false positives. Re-check a
category only if the guard named below stops holding, and prefer fixing a guard over
suppressing an item:

- **Path traversal** (`scripts/wiki-compare/overlay.ts`, `cache.ts`). Fixed paths
  use `path.resolve` with literal segments, relative to the working directory. The variable mode
  segment in `taskOverlayFiles` is either a member of the module-local `WIKI_COMPARE_MODES`
  constant or a `SuppressionScope` argument threaded down from a caller. That type is a
  compile-time bound only, so the guard that matters is at the input boundary: the sole
  external source is the `--gameMode`/`-g` flag, and `cli.ts` accepts it only when it equals
  `regular`, `pve`, or `both`, discarding anything else so the `'both'` default applies. A new
  entry point that reaches these helpers without passing through that check needs its own
  validation. User-derived cache stems go through `assertSafeCacheFileStem`
  (`/^[A-Za-z0-9_-]{1,128}$/`). `resolveOutputFilePath` returns the operator's own `--output`
  argument, which is intended CLI behaviour.
- **Dynamic regular expression, 11 items** (`normalize.ts`, `wiki.ts`). Every
  interpolation is wrapped in `escapeRegExp`, so wiki text cannot inject metacharacters.
  The two that are not (`normalize.ts` around the count-word replacements) interpolate
  module-local word lists, not input.
- **SSRF** (`src/lib/tarkov-api.ts`). Server-side calls append to a hardcoded
  `https://json.tarkov.dev` base, so callers cannot select the requested host.
  Native fetch redirects retain the upstream service's existing behavior.
- **SSRF** (`scripts/eft-remote.ts`). The remote-session URL is the operator's
  own `--url`/`REMOTE_SESSION_URL`, which is intended local CLI behaviour. The
  guard is `lanOrigin`: an IP literal must be loopback, private or link-local; a
  hostname must look local and every address it resolves to must be a LAN
  address. The path is fixed to `/api/<mode>/tasks`. The request is made with
  `node:http(s)` through `lanOnlyLookup`, which pins the socket to an address
  that passed `isLanAddress` (a changed DNS answer cannot redirect it), and no
  redirects are followed. Fallow supports only a file-level suppression for this
  sink type, so the file carries a reviewer-approved
  `fallow-ignore-file security-sink`; re-review any new outbound request added to
  that file by hand.

CodeQL alerts dismissed as false positives should state the reason that actually holds. For
wiki-derived text the operative reason is that `eft-story-generate.ts` consumes the scraped
file only through `sequenceRatio()` as a fuzzy-match key and never copies the text itself.
Two nearby claims are _not_ supportable: `eft-story-wiki.ts` does persist that text, to the
gitignored `data/eft/story-wiki-objectives.json`, and the wiki does influence committed
output — `matchOptional` returns a coerced `boolean` that becomes an objective's
optional/required marker in `src/additions/storyChapters.json5`. A boolean cannot carry
markup, which is why the sanitization argument survives; free-form wiki text reaching the
overlay would not.

## Commit & Pull Request Guidelines

Recent history favors Conventional Commit prefixes like `feat:`, `chore:`, and `refactor:`; build commits use `chore: build overlay [skip ci]`. PRs should include proof links for data changes and the commands you ran (at least `npm run validate`), plus the checked commit, worktree state, checks, and any missing review evidence. Never commit `dist/overlay.json` in a PR: the release workflow is its only writer and commits it after each merge, and CI rejects PRs that change it.

### PR review bots

Automatic Codex reviews are intended to be off, but the checked-in repository
files do not establish the current dashboard or integration settings. Push-triggered
reviews depend on those settings; do not assume a push will or will not trigger a
review.

Repo overrides to the global review rules:

- A substantial follow-up needs a manual `@coderabbitai review` before merge
  unless recorded local or independent review evidence covers the final changes.
- Use `@codex review` only as an exceptional fallback when both CodeRabbit review
  channels (CLI and PR) are limited, or for a final review of a risky change. Do
  not run Codex reviews locally.
- Auth, billing, migrations and concurrency changes require an independent review
  before merge; use CodeRabbit or another independent reviewer and record the
  evidence.
- Merge class: dependency bumps that keep `npm run validate` and CI green, docs,
  tests, and proof-backed data corrections are low risk and may merge once checks
  pass. Confirm before merging changes to workflows or release automation, the
  overlay output schema or `dist/` contract consumers rely on, secrets, or any
  weakened security control.
- Dependencies: Dependabot npm version updates wait out a cooldown (major 30
  days, minor 7, patch 3) and GitHub Actions updates wait 7 days; security
  updates open immediately. Socket's pull request
  alerts and `npm run audit:dependencies` findings must be resolved or reviewed before merge.

A `CHANGES_REQUESTED` review stays attached to the commit it was written against,
so it survives the push that fixes it and leaves `reviewDecision` misleading. It
does not block merging here: `main` is not branch-protected, and GitHub has
reported `mergeStateStatus: CLEAN` alongside a stale `CHANGES_REQUESTED`. Dismiss
such a review only after confirming its findings are genuinely fixed, its threads
are resolved, and you hold permission to dismiss; cite the fixing commit and the
replacement review evidence in the dismissal message. If branch protection is ever
enabled and requires approval of the most recent push, dismissal alone will not
satisfy that rule and a fresh approving review will be needed.

## Data Contribution Quick Checklist

- Edit the correct JSON5 file in `src/overrides/` or `src/additions/`.
- Provide proof (wiki link, screenshot, or patch notes).
- For map and trader references, look the ID up in `TARKOV_MAP_NAMES_BY_ID` /
  `TARKOV_TRADER_NAMES_BY_ID` (`src/lib/types.ts`) rather than copying a nearby
  entry. Consumers resolve these by `id`, so a correct `name` beside the wrong
  `id` silently points at another map or trader;
  `tests/entity-references.test.ts` enforces the pairing.
- Run `npm run validate` and `npm run build` before submitting; leave `dist/overlay.json` out of the PR.

## Issue Triage

Use [docs/TRIAGE.md](docs/TRIAGE.md) when reviewing GitHub issues. Verify
reports against the latest `main`, the applicable live tarkov.dev mode(s), and
the field-appropriate proof before marking them confirmed, fixed, duplicate,
or won't fix. Fail closed: missing or conflicting evidence gets
`status:needs-info` or `status:needs-investigation`, not a guessed verdict.
Record the checked commit, modes, evidence, and next action in the triage
comment. Keep only one lifecycle label and use the `type:*` / `status:*`
taxonomy defined in the guide.

## Fetching Wiki Data

The EFT Fandom wiki serves rendered HTML page paths (`https://escapefromtarkov.fandom.com/wiki/...`) behind a Cloudflare managed challenge. Non-browser clients (curl, agent fetch tools, scripts) get `HTTP 403` with a `cf-mitigated: challenge` header instead of content, regardless of User-Agent. Do not scrape `/wiki/` HTML.

Use the MediaWiki API instead — it is not challenged and returns full content (no User-Agent required):

- Wikitext: `https://escapefromtarkov.fandom.com/api.php?action=parse&page=<Title>&prop=wikitext&format=json`
- Rendered HTML fragment: `...&prop=text`
- Plain-text extract: `action=query&prop=extracts&...`

The wiki-compare tool (run via `npm run wiki:compare`) already uses `api.php` (`WIKI_API_URL` in `scripts/wiki-compare/wiki.ts`); follow that pattern for any new wiki access. The `{{Historical content}}` / `{{Event content}}` templates at the top of a page's wikitext indicate expired/event content (verify before adding or for removing stale event additions).
