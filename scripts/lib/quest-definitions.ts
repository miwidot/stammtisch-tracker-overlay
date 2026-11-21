/**
 * Quest template comparison helpers shared by eft:diff and eft:remote.
 *
 * A `client/quest/list` response mixes quest definitions with the requesting
 * account's progress. Definitions are what the overlay tracks, so comparisons
 * drop the per-account fields first; two references with equal definitions
 * describe the same game data even when their progress differs.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/** Quest-root fields that carry the requesting account's progress, not the definition. */
const ACCOUNT_FIELDS = new Set([
  'status',
  'statusTimers',
  'completedConditions',
  'availableAfter',
  'startTime',
  'sptStatus',
]);

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A reference id the enriched variant wrapped as `[<id>]` or `[<id> name] ...`. */
const WRAPPED_ID = /^\[([0-9a-f]{24})(?:\]| [^\]]*\])/;

/** Replace every wrapped id string (quest, condition, target, trader, item ids) with the bare id. */
function unwrapIds(value: unknown): unknown {
  if (typeof value === 'string') return WRAPPED_ID.exec(value)?.[1] ?? value;
  if (Array.isArray(value)) return value.map(unwrapIds);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrapIds(entry)]));
  }
  return value;
}

/**
 * The definition part of one quest template. Wrapped ids are unwrapped
 * throughout, so enriched and plain references of the same quest align.
 */
export function questDefinition(quest: unknown): unknown {
  if (!isRecord(quest)) return quest;
  const definition = Object.fromEntries(
    Object.entries(quest).filter(([key]) => !ACCOUNT_FIELDS.has(key))
  );
  if (typeof definition._id === 'string') definition._id = canonicalQuestId(definition._id);
  return unwrapIds(definition);
}

/** The bare 24-hex id of a possibly-wrapped reference id (`[<id> name] ...`). */
export function canonicalQuestId(value: string): string {
  return /[0-9a-f]{24}/.exec(value)?.[0] ?? value;
}

/** Stable JSON with sorted object keys (array order is preserved). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  // A missing key or array slot is not the same as an explicit null.
  if (value === undefined) return '\u0000absent';
  return JSON.stringify(value);
}

/** Hash of every quest definition, independent of quest order and account progress. */
export function definitionsHash(quests: readonly unknown[]): string {
  const entries = quests.map((quest) => canonicalJson(questDefinition(quest))).sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export interface ValueChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Arrays of objects with unique `id`s align by id, so a reorder or insert is not a cascade. */
function idIndex(values: unknown[]): Map<string, unknown> | null {
  const index = new Map<string, unknown>();
  for (const value of values) {
    const id = isRecord(value) ? value.id : undefined;
    if (typeof id !== 'string' || index.has(id)) return null;
    index.set(id, value);
  }
  return index;
}

/** Ids of `values` that also exist in `keep`, in `values` order. */
function sharedIdOrder(values: unknown[], keep: Map<string, unknown>): unknown[] {
  return values.map((value) => (value as JsonRecord).id).filter((id) => keep.has(id as string));
}

/** Diff two id-aligned arrays by id, then report a reorder of the shared ids. */
function diffById(
  before: unknown[],
  after: unknown[],
  left: Map<string, unknown>,
  right: Map<string, unknown>,
  path: string,
  out: ValueChange[]
): void {
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    diffValues(left.get(id), right.get(id), `${path}[${id}]`, out);
  }
  const beforeOrder = sharedIdOrder(before, right);
  const afterOrder = sharedIdOrder(after, left);
  if (canonicalJson(beforeOrder) !== canonicalJson(afterOrder)) {
    out.push({ path: `${path} (order)`, before: beforeOrder, after: afterOrder });
  }
}

function diffArrays(before: unknown[], after: unknown[], path: string, out: ValueChange[]): void {
  const left = idIndex(before);
  const right = idIndex(after);
  if (left && right) {
    diffById(before, after, left, right, path, out);
    return;
  }
  for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
    diffValues(before[i], after[i], `${path}/${i}`, out);
  }
}

/** Collect leaf-level changes between two JSON values as JSON-Pointer-like paths. */
export function diffValues(
  before: unknown,
  after: unknown,
  path = '',
  out: ValueChange[] = []
): ValueChange[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, path, out);
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffValues(before[key], after[key], `${path}/${key}`, out);
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    out.push({ path: path || '/', before, after });
  }
  return out;
}

/**
 * Load `client/locale/en` from a reference's capture directory, when present.
 * Older captures (and story sub-quests) carry no per-quest localization block.
 */
export function loadSiblingLocale(referenceFile: string): JsonRecord {
  const dir = dirname(referenceFile);
  const file = readdirSync(dir).find((name) => /(?<!menu)_locale_en\.json$/i.test(name));
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as JsonRecord;
    const response = isRecord(raw.response) ? raw.response : {};
    const body = isRecord(response.body_response)
      ? response.body_response
      : isRecord(response.decoded_response)
        ? response.decoded_response
        : raw;
    return isRecord(body.data) ? body.data : {};
  } catch {
    return {};
  }
}

/** English string lookup for a quest: its own localization block, else the locale file. */
export function questText(
  quest: unknown,
  locale: JsonRecord = {}
): (key: string) => string | undefined {
  const localization = isRecord(quest) && isRecord(quest.localization) ? quest.localization : {};
  const own = isRecord(localization.en) ? localization.en : {};
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  return (key) => text(own[key]) ?? text(locale[key]);
}
