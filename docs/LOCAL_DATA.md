# Local reference data

Keep private captures and historical evidence under the gitignored `data/` root.
Historical snapshots remain useful when newer captures have less coverage; never
replace an older snapshot just because a newer one exists.

- `data/reference/`: decoded captures (including original wire bodies), enriched
  quests, and story supplements. A separate raw tree is unnecessary when its
  payload and noncredential metadata are already represented in decoded
  captures. Preserve capture and mode distinctions. `npm run eft:import` files a
  decoded session under `decoded/<session>/`; `npm run eft:remote` saves live
  remote-session quest lists under `remote/<mode>/`, written only when their
  quest definitions change.
- `data/cache/`: current API and wiki tool caches.
- `data/eft/` and `data/task-availability/`: current derived tool outputs.
- `data/history.zip`: historical API/wiki snapshots, comparisons, research notes,
  and supporting analysis. Consolidate retained evidence here; discard obsolete
  development/CI housekeeping and synthetic review fixtures.
- `data/catalog.json`: private inventory of every original path, its surviving
  path, SHA-256, size, and original modification time. `duplicateOf` identifies
  the surviving byte-identical copy when an extra copy was removed.

The catalog is local evidence, not a public artifact: it can contain private
capture filenames. Keep it and all captures out of commits, issues, and PRs.
For a catalog entry with `storage: zip`, read `member` inside the ZIP at `path`.
For `storage: represented-by-decoded`, `path` points to the richer decoded file.
Its byte hash is `representationSha256`; `sha256` records the removed original.
`originalFields` identifies the equivalent projection and `semanticSha256`
verifies it after excluding Cookie, Authorization, and Set-Cookie headers.
Decoded captures already redact those credentials; transport bodies and all
other original fields must match exactly before a raw copy can be removed.
For `storage: decoded-response`, read `response[responseField]` in the decoded
file at `path`. `representationSha256` verifies that file; `semanticSha256`
verifies the full JSON response with object keys normalized and array order
preserved. `gameMode` must match the capture independently; equal payloads from
another mode do not establish coverage. The old combined path remains in
`originalPath`/`previousPath`, so historical lookups retain their context.
For ordinary files, read `duplicateOf ?? path`. Entries marked
`storage: removed-housekeeping` record a deliberate removal and its reason.
Do not assume a former path still exists. Archived scripts and notes can retain
old path references; consult the catalog to locate those inputs.

The ZIP opens in Windows File Explorer. You can also read a cataloged historical
file without extracting an archive tree, using Python's standard library:

```python
from pathlib import Path
from zipfile import ZipFile
import json

root = Path.cwd()
catalog = json.loads((root / 'data/catalog.json').read_text(encoding='utf-8'))
entries = [entry for entry in catalog['files'] if entry.get('storage') == 'zip']
entry = next(entry for entry in entries if 'Collector.wiki.json' in entry['originalPath'])
with ZipFile(root / entry['path']) as history:
    text = history.read(entry['member']).decode('utf-8-sig')
```

Housekeeping cleanup must never remove a raw capture, a unique API/wiki snapshot,
or a research result just because it is historical. Move unmatched historical
captures into `history.zip` with their original bytes rather than discarding them. Check catalog aliases and
protected references before removing a file. Verify every retained ZIP member's
SHA-256 against its catalog entry before deleting loose copies.

Prove duplicate bytes or a documented exact JSON representation before removing
a copy. Combined datasets can be removed only when their complete response,
including all fields and array order, matches a decoded capture of the same mode.
Preserve combined-only historical values or annotations if any fail that check.
Preserve pinned story references, selected mode references, live cache/output
paths, envelopes, localization, versions, modes, and incomplete captures. Equal
entity IDs across snapshots do not make the snapshots interchangeable; a merged
dataset cannot replace its source evidence.

`data/` is the only active local data root. Capture tools default to
`data/reference/`; there is no fallback to top-level `eft/`. Keep derived outputs
in `data/eft/` — that nested directory is still active and is not a capture store.
Explicit capture-directory CLI arguments must also stay under `data/reference/`,
including their resolved symlink targets. Use a subdirectory there to select a
specific capture or mode; other input roots are rejected.

Story locks name primary and supplemental files under `data/reference/`.
Moving a pinned capture changes its lock path, not its hash, version, mode,
timestamp or coverage. Every normal read and re-pin verifies physical containment
in the project's `data/reference/`, including symlink targets. Explicit
`STORY_REFERENCE` can select a moved or renamed copy within that directory;
its bytes must still match the pin unless a deliberate re-pin is requested.
