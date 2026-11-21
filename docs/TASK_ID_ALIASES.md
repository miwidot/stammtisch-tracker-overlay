# Task and objective identity migration

`taskIdAliases` is a permanent, versioned identity ledger. Schema version 1 contains
explicit `regular`, `pve`, and `pvp-season` maps; there is no cross-mode fallback.
Each mode has `tasks` (placeholder task ID to real task ID) and `objectives`
(placeholder objective ID to `{ id, taskId }`, identifying the real objective and
its real parent task). IDs must be proven, not inferred from list order. Targets
are unique within each mode and objective parents must match a task alias.

The first release deliberately contains empty maps. The known Honest Review and
Uninvited Guests – Part 1 pairs from [the ledger](https://github.com/tarkovtracker-org/tarkov-data-overlay/issues/507#issuecomment-6546607131)
live in `tests/fixtures/task-id-aliases.json`. Honest Review has PvP and Seasonal
evidence; Uninvited Guests has Seasonal evidence. No PvE mapping is assumed.
These fixtures do not activate or replace any published quest.

## Activation sequence

1. Release the schema and immutable shared reconciliation package.
2. Deploy Tracker, API and atomic database merge support; prove migration parity
   in all modes, including offline clients, cached catalogs and backup imports.
3. Add proven aliases and publish their real task/objective definitions together.
   Rewrite catalog references in that same release. Do not expose both identities
   as separate tasks. Consumers must use aliases from the matching catalog revision.
4. Verify completion, failure, counts, explicit unchecks, reset epochs, task
   availability, pinned/hidden tasks, team and public views. Retain all unmapped
   records. Never resolve ambiguous identity by dropping a saved mark.

Aliases are never removed after activation: old devices and backups can return at
any time. Reconciliation is idempotent and preserves edit timestamps. A migration
is not a new player action. Newer explicit edits and resets outrank old completion;
equal/unknown clocks prefer an existing canonical-ID record. Counts are neither
added nor maximized over a newer explicit correction.

Database persistence must canonicalize both stored and incoming records under the
existing lock. A client-only rename or a bulk backfill cannot prevent an older
client from recreating the old key. Backfills are separately reviewed, optional
cleanup after compatibility is established, never part of schema deployment.

Implementation tracking: [Tracker #1302](https://github.com/tarkovtracker-org/TarkovTracker/issues/1302).
