# Language-neutral overlay contract

The release publishes `overlay-neutral.json` beside `overlay.json`. Both are built
from the same validated sources. `overlay-neutral.json` has `schemaVersion: 1` and
contains the same gameplay sections, with display text replaced by stable string
keys. `overlay.json` continues to serve consumers using the localized patch format.

## String keys and tables

Keys begin with `@tt:overlay:/` and contain JSON-pointer-escaped path segments.
For example, the name of addition `quest` uses `@tt:overlay:/tasks/quest/name`.
`tasksAdd` and `itemsAdd` share their entity sections' namespaces, and `craftsAdd`
uses `crafts`. Mode-specific values include `modes/<mode>/` in the path. Arrays
use the entry's string `id` when present, so objective reordering preserves keys.

The compiler extracts `name`, `shortName`, `description`, `wikiLink`, `title`,
`note`, `notes`, `summary`, and `targetNames` entries within display-bearing entity
sections. IDs, normalized names, image URLs,
mechanical extract names, registries, and gameplay values retain their values.
Localized wiki links travel through the same table as text and resolve before a
link is rendered or validated as a URL.

`$strings.en` holds English defaults from shared and mode-specific corrections and
additions. Other `$strings[language]` tables contain sparse locale overrides.
English locale corrections override the corresponding English defaults.
The compiler rejects locale leaves outside the supported string fields, including
non-string corrections, so a source schema extension requires an explicit contract
update before the producer can publish it.

`$localeTargets` maps each locale correction key to its entity path as a string
array, for example `['tasks', 'quest', 'objectives', 'step', 'description']`.
These bindings also cover fields absent from shared overlay sources. The consumer
binds the key to the existing neutral field, preserving that field as its fallback.
It resolves requested-language strings, English overlay strings, and finally the
original upstream field in that order. A missing English overlay string leaves
the upstream English fallback available. The consumer includes keys referenced by
its adapted catalogs in the language bundle.

## Integrity and release order

`$meta` identifies this artifact. Its SHA256 is calculated using the existing
overlay convention, deleting `$meta.sha256` and hashing `JSON.stringify(value,
null, 2)`. `$source` copies the legacy artifact's `$meta`, including its SHA256,
to bind both artifacts to the same release data. Consumers verify each artifact's
own digest and use `$source` when comparing neutral catalogs with English import
snapshots. The release validates, commits, tags, and uploads both files together.

1. Release this producer while existing consumers continue reading `overlay.json`.
2. Release a Tracker precompute producer that understands `schemaVersion: 1`.
3. Seed and verify the new versioned neutral catalog and language keys, checking
   source identity against the intended release.
4. Promote the Tracker consumer after that verification succeeds.

## Adding a correction

Edit the existing ID-keyed JSON5 files. Add English canonical text to the relevant
shared or mode override or addition. Add language-specific corrections to
`src/overrides/locales/<language>.json5`, including localized `wikiLink` fields.
Keep the entity name, evidence link, and previous value in comments as required by
the contribution guidelines. The compiler generates the keys and target bindings.

Run `npm run validate`, `npm test`, `npm run typecheck`, and `npm run build`.
Check both generated artifacts locally. Submit source changes and leave `dist/`
to the release workflow.
