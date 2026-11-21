/**
 * Normalisation and structural diffing for the tarkovtracker.org parity check.
 *
 * Only fields that legitimately differ between two otherwise identical releases are removed, and
 * every removal is reported, so a normalised "identical" verdict always lists what was ignored.
 */

import { gunzipSync } from 'node:zlib';

/**
 * Fields that legitimately differ between two otherwise identical releases, by cause. A trailing
 * `[]` on a segment walks every element of that array.
 *
 * - build: identifies the overlay build, not its content. `generated`/`sha256` change on every
 *   build, `sourceUrl` is wherever the overlay was served from. `version` and `status` are
 *   deliberately NOT here so a different overlay release shows up as a difference.
 * - runtime: cache bookkeeping the app adds while serving (`fetchedAt`, `cacheAgeMs`), and the
 *   time a task-import snapshot was stored.
 * - market: live tarkov.dev market data that moves between two producer runs by nature
 *   (prices, offer counts, restock amounts and trader restock times). Everything else in `items`
 *   and `traders` is still compared.
 */
export const VOLATILE_CLASSES = {
  build: ['dataOverlay.generated', 'dataOverlay.sha256', 'dataOverlay.sourceUrl'],
  runtime: ['dataOverlay.fetchedAt', 'dataOverlay.cacheAgeMs', 'storedAt'],
  market: [
    'data.traders[].resetTime',
    'data.items[].updated',
    'data.items[].lastScan',
    'data.items[].lastLowPrice',
    'data.items[].lastOfferCount',
    'data.items[].avg24hPrice',
    'data.items[].low24hPrice',
    'data.items[].high24hPrice',
    'data.items[].changeLast48h',
    'data.items[].changeLast48hPercent',
    'data.items[].buyFromTrader[].restockAmount',
  ],
} as const;

export const VOLATILE_PATHS: readonly string[] = [
  ...VOLATILE_CLASSES.build,
  ...VOLATILE_CLASSES.runtime,
  ...VOLATILE_CLASSES.market,
];

/** Extra paths for the extract-requirements endpoint, whose `dataOverlay` we synthesise locally. */
export const SYNTHESISED_META_PATHS = [
  'dataOverlay.status',
  'dataOverlay.unconsumedSections',
] as const;

/**
 * Arrays whose element order is not stable at the source: tarkov.dev returned the same two
 * trader offers in a different order between two runs. These are compared as sorted lists, and
 * every use is reported as class `ordering`.
 */
export const ORDER_INSENSITIVE_PATHS: readonly string[] = ['data.items[].buyFromTrader[]'];

export function volatileClass(path: string): string {
  if (ORDER_INSENSITIVE_PATHS.includes(path)) return 'ordering';
  for (const [name, paths] of Object.entries(VOLATILE_CLASSES)) {
    if ((paths as readonly string[]).includes(path)) return name;
  }
  return 'endpoint-specific';
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Normalized {
  value: Json;
  /** Volatile paths that were present and removed. */
  applied: string[];
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Decodes a stored or fetched body, transparently handling gzip. */
export function decodeBody(bytes: Buffer): Buffer {
  return bytes.length > 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
    ? gunzipSync(bytes)
    : bytes;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removePath(node: Json | undefined, parts: string[]): boolean {
  const [head, ...rest] = parts;
  if (head === undefined || !isObject(node)) return false;
  const each = head.endsWith('[]');
  const key = each ? head.slice(0, -2) : head;
  if (!Object.hasOwn(node, key)) return false;
  if (rest.length === 0) {
    if (each) return false;
    delete node[key];
    return true;
  }
  const child = node[key];
  if (!each) return removePath(child, rest);
  if (!Array.isArray(child)) return false;
  return child.map((element) => removePath(element, rest)).some(Boolean);
}

const canonical = (value: Json): string => JSON.stringify(value);

/** Sorts the array that `parts` ends in (`...key[]`); returns whether anything was reordered. */
function sortPath(node: Json | undefined, parts: string[]): boolean {
  const [head, ...rest] = parts;
  if (head === undefined || !isObject(node)) return false;
  const each = head.endsWith('[]');
  const key = each ? head.slice(0, -2) : head;
  if (!Object.hasOwn(node, key)) return false;
  const child = node[key];
  if (rest.length === 0) return each && Array.isArray(child) && sortInPlace(child);
  if (!each) return sortPath(child, rest);
  if (!Array.isArray(child)) return false;
  return child.map((element) => sortPath(element, rest)).some(Boolean);
}

function sortInPlace(list: Json[]): boolean {
  const before = list.map(canonical);
  list.sort((a, b) => {
    const left = canonical(a);
    const right = canonical(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return before.some((entry, index) => entry !== canonical(list[index]!));
}

/**
 * Returns a deep copy without the given dotted paths, with `orderPaths` arrays sorted. Never
 * mutates the input. `applied` lists removals that happened and sorts that changed the order.
 */
export function normalize(
  value: Json,
  paths: readonly string[] = VOLATILE_PATHS,
  orderPaths: readonly string[] = ORDER_INSENSITIVE_PATHS
): Normalized {
  const copy = structuredClone(value);
  const applied: string[] = [];
  for (const path of paths) {
    const parts = path.split('.');
    if (parts.some((part) => FORBIDDEN_KEYS.has(part.replace(/\[\]$/, '')))) {
      throw new Error(`Unsafe path "${path}"`);
    }
    if (removePath(copy, parts)) applied.push(path);
  }
  // Sorting runs after removal so volatile fields can never decide the order.
  for (const path of orderPaths) {
    const parts = path.split('.');
    if (parts.some((part) => FORBIDDEN_KEYS.has(part.replace(/\[\]$/, '')))) {
      throw new Error(`Unsafe path "${path}"`);
    }
    if (sortPath(copy, parts)) applied.push(path);
  }
  return { value: copy, applied };
}

export interface Difference {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'order';
  left?: string;
  right?: string;
}

export interface DiffResult {
  differences: Difference[];
  /** Total number of differences found, including ones beyond the recorded limit. */
  total: number;
}

const PREVIEW_LENGTH = 120;

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
}

function idOf(item: unknown): string | undefined {
  return isObject(item) && typeof item.id === 'string' ? item.id : undefined;
}

/** Arrays of id-carrying objects with unique ids are matched by id, everything else by index. */
function keyedById(list: Json[]): Map<string, Json> | null {
  const map = new Map<string, Json>();
  for (const item of list) {
    const id = idOf(item);
    if (id === undefined || map.has(id)) return null;
    map.set(id, item);
  }
  return map;
}

class Collector {
  readonly differences: Difference[] = [];
  total = 0;
  constructor(private readonly limit: number) {}
  add(difference: Difference): void {
    this.total += 1;
    if (this.differences.length < this.limit) this.differences.push(difference);
  }
}

function diffArrays(left: Json[], right: Json[], path: string, out: Collector): void {
  const leftIds = keyedById(left);
  const rightIds = keyedById(right);
  if (leftIds && rightIds) {
    for (const [id, item] of leftIds) {
      const other = rightIds.get(id);
      if (other === undefined) out.add({ path: `${path}[id=${id}]`, kind: 'removed' });
      else walk(item, other, `${path}[id=${id}]`, out);
    }
    for (const id of rightIds.keys()) {
      if (!leftIds.has(id)) out.add({ path: `${path}[id=${id}]`, kind: 'added' });
    }
    const common = [...leftIds.keys()].filter((id) => rightIds.has(id));
    const rightOrder = [...rightIds.keys()].filter((id) => leftIds.has(id));
    if (common.some((id, index) => id !== rightOrder[index])) out.add({ path, kind: 'order' });
    return;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (index >= left.length) out.add({ path: `${path}[${index}]`, kind: 'added' });
    else if (index >= right.length) out.add({ path: `${path}[${index}]`, kind: 'removed' });
    else walk(left[index]!, right[index]!, `${path}[${index}]`, out);
  }
}

function diffObjects(
  left: { [key: string]: Json },
  right: { [key: string]: Json },
  path: string,
  out: Collector
): void {
  for (const key of Object.keys(left)) {
    const child = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(right, key)) out.add({ path: child, kind: 'removed' });
    else walk(left[key]!, right[key]!, child, out);
  }
  for (const key of Object.keys(right)) {
    if (!Object.hasOwn(left, key)) out.add({ path: path ? `${path}.${key}` : key, kind: 'added' });
  }
}

function walk(left: Json, right: Json, path: string, out: Collector): void {
  if (Array.isArray(left) && Array.isArray(right)) return diffArrays(left, right, path, out);
  if (isObject(left) && isObject(right)) return diffObjects(left, right, path, out);
  if (!Object.is(left, right)) {
    out.add({ path, kind: 'changed', left: preview(left), right: preview(right) });
  }
}

/**
 * Structural diff. `left` is the reference (tarkovtracker.org), `right` is ours:
 * "removed" means we lack something the reference has, "added" means we have something extra.
 */
export function diffJson(left: Json, right: Json, limit = 200): DiffResult {
  const out = new Collector(limit);
  walk(left, right, '', out);
  return { differences: out.differences, total: out.total };
}
