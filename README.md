# tarkov-data-overlay

Community-maintained data overlay for [tarkov.dev](https://tarkov.dev) API corrections and additions.

## Why?

The tarkov.dev API is an excellent resource, but game updates sometimes outpace data updates. This overlay provides:

- **Corrections**: Fix incorrect data (task levels, map requirements, etc.)
- **Additions**: New data types not in tarkov.dev (game editions, etc.)

## Usage

Fetch the overlay from jsDelivr CDN:

```text
https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json
```

The `@main` URL tracks the rolling repository state. Pin an immutable release tag or commit when
using the overlay in production; the embedded digest detects corruption or stale data but does not
prove the CDN response's authenticity.

Then merge it with tarkov.dev responses. See [Integration Guide](docs/INTEGRATION.md) for details.
For accurate task visibility and unlock-state tracking, see
[Task availability and unlock tracking](docs/TASK_AVAILABILITY.md).
Use `evaluateTaskProgression` for verified progress-based counters and explicit
unknown results; see the [counter data contract](docs/GLOBAL_VARIABLES.md).

## Monitor

Browse the hosted monitor at [monitor.nivmizz7.dev](https://monitor.nivmizz7.dev), or run it locally with:

```bash
npm run monitor
```

The monitor is read-only by default. To enable its local “Update overlay” action,
explicitly opt in with a rebuild token when starting it:

```bash
ALLOW_REBUILD=true REBUILD_TOKEN='choose-a-local-secret' npm run monitor
```

The server binds to `127.0.0.1` by default. Set `HOST` only when a trusted
reverse proxy or network boundary is configured; a non-empty token is always
required for rebuilds, and callers must pass it in an `Authorization: Bearer …`
header. When `HOST` is not loopback, set `TRUSTED_HTTPS_PROXY=true` only when
HTTPS is terminated by a trusted reverse proxy; otherwise rebuilds remain
disabled. In that mode the monitor also uses the first valid `X-Forwarded-For`
address for per-client SSE quotas, so the proxy must overwrite that header.
Without the trusted-proxy setting, quotas use the direct socket address.
Rebuilds target the default `dist/overlay.json` output; custom local and HTTP(S)
overlay targets remain read-only.

The monitor compares task, item, map, hideout and trader corrections with each
mode's upstream snapshot. Addition rows distinguish upstream adoption from field
differences; a differing value needs correction evidence. Missing or failed
snapshots display `unverified`. Values that match upstream but cancel a different
shared patch display `mode guard` so they are not mistaken for removable patches.
The CLI also preserves these guards. Shared task corrections are removable only
after checking their effective behavior in every supported mode, including
corrections masked by mode-specific patches.

## Maintenance

The overlay is compared against current `json.tarkov.dev` data in each supported mode:

```bash
npm run check-overrides
```

This command reports upstream comparison results and the limits of each check:

- ⚠️ Values that differ from upstream and require supporting correction evidence
- 🔄 Corrections that have been fixed upstream (can be removed)
- 🗑️ Tasks that have been removed from the API (can be deleted)
- ⚠️ Upstream data-quality regressions (reported for escalation, not actionable here)

Every supplied field is reported, including nested objects, array members,
unknown extensions and unavailable upstream values. Items and crafts retain the
upstream field format; task additions retain the existing adapted overlay
contract for consumer compatibility. Format and reference checks validate item,
task, trader, map, station and perk references against the applicable mode and
its additions. Additions are reference targets, never evidence for their own
format or values. Unknown raw seasonal filter IDs remain unverified because the
upstream item catalog does not establish all game template identities.

Task additions match canonical IDs before wiki links or names. An adopted ID
flags a duplicate addition independently of its values. Full retirement requires
all supplied values to match; differing or unavailable values require review and
only proven corrections should become overrides. Array comparisons preserve
membership and cardinality, align unique IDs, and reject ambiguous identity
matches. Maps include
extract additions and effective shared/mode patches. Seasonal supplements check
perk IDs and raw effects when upstream exposes them; progression counters check
task references and exposed variable references. Counter pool membership,
unexposed raw effects, editions and story data are explicitly reported as not
comparable, rather than verified. Endpoint discovery flags potential new upstream
edition/story sources for review without gating unrelated PRs.

Item adoption checks include the mode's items, quest items and usable item-name
entries in both English translation dictionaries. Dictionary-only identities must
be item IDs, excluding generic labels and known task IDs. Incomplete item sources or
malformed translations fail validation; unresolved translation placeholders do
not establish field values. Empty task snapshots also fail validation. Missing
objective lists and unexposed disabled flags remain unverified, and disabling a
task does not skip its other field comparisons.
Comparison snapshots preserve raw evidence separately from display fallbacks:
filtered malformed collections and unresolved or blank translations cannot prove
an empty list or matching text. Task status aliases and equivalent trader merge
identities retain their existing semantics while checking all supplied nested
names and extension fields. Shared corrections retire only when every mode is
covered by upstream data or a task mode correction that remains independently needed;
identical shared/mode values cannot be retired together. Stale counts include
matching nested leaves within corrections that still differ elsewhere. Shared
map/entity fields and additions require evidence in every applicable mode, and
stale counts identify physical source units instead of counting each mode again. Supplied
typed task requirements enforce their conditional contract fields.

The monitor publishes each upstream refresh independently, so a slow or failing
entity endpoint does not hold back task comparisons. Crafts, localized fields
and Seasonal perk metadata/effects have mode-scoped upstream snapshots and
field diagnostics. Locale checks include quest items and dictionary-only item
identities; missing translations and incomplete objective lists remain
unverified. Seasonal perk snapshots are available only in `pvp-season`; other
modes display this limitation explicitly. Only configured locales are fetched;
new overlay locale keys trigger locale refreshes without waiting for the API poll
or restarting unrelated entity reads. Overlay failures are reported separately
from upstream failures. Counter checks reuse the main
audit's task snapshots; standalone checks fetch independent modes concurrently.

A difference alone does not establish that the overlay is correct. Missing local
reference evidence is reported as `UNVERIFIED`; numeric objective contradictions
with an applicable reference count toward `--strict`. API failures, malformed
responses, unhandled source files and unhandled task fields fail validation, so
new published data cannot silently bypass comparison. Internal `NEEDED` statuses
mean "not redundant", not "independently proven correct".

Run this periodically to keep the overlay lean and accurate.

By default the command only reports. CI enables `--strict --fail-on-stale`;
upstream data-quality regressions remain separately opt-in. Each gate is opt-in:

| Flag                 | Fails on                                          | Exit code |
| -------------------- | ------------------------------------------------- | --------- |
| `--strict`           | Overlay inconsistency, or data served incorrectly | 2         |
| `--fail-on-stale`    | Overlay carries data tarkov.dev now supplies      | 3         |
| `--fail-on-upstream` | Upstream data-quality regression                  | 4         |

Exit `0` means no enabled gate found a problem; exit `1` is a script or network
error. `--fail-on-upstream` is intentionally excluded from CI: those problems
originate in tarkov.dev's data, so no change in this repository can clear one and
gating pull requests on it would block every merge until upstream recovered. The
diagnostic is printed either way. When several gates would fail, every summary is
printed and the most specific code wins (4, then 2, then 3).

For local checks:

```bash
npm run validate
npm run typecheck
npm test
```

## Contributing

Found incorrect data? See [Contributing Guide](docs/CONTRIBUTING.md).
For issue requirements and maintainer triage, see the [Issue Triage Guide](docs/TRIAGE.md).

## Data Governance

- This is **community-maintained, best-effort** data
- All corrections require proof (wiki links, screenshots)
- Not a replacement for tarkov.dev - a bridge during data gaps
- Transparent history via Git

## License

This repository is dual-licensed:

- **Code** (`scripts/`, `src/lib/`, `src/schemas/`, `examples/`, `monitor/`, `tests/`, and
  tooling): [MIT](LICENSE).
- **Data** (`src/overrides/`, `src/additions/`, `src/divergences/`, `src/suppressions/`, and the
  built `dist/overlay.json`): [CC BY-NC 4.0](LICENSE-DATA).

Using the data requires visible attribution, for example:

> Data corrections from [tarkov-data-overlay](https://github.com/tarkovtracker-org/tarkov-data-overlay)
> by TarkovTracker.org, licensed under CC BY-NC 4.0.

Commercial use of the data needs written permission from TarkovTracker.org. Open an issue to ask.

Data published before this change remains available under the MIT terms it was released with.
