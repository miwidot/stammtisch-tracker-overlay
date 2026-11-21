import { createHash } from 'node:crypto';
import {
  decodeBody,
  diffJson,
  normalize,
  VOLATILE_PATHS,
  type Difference,
  type Json,
  type DiffResult,
} from './normalize.js';

export const MODES = ['regular', 'pve', 'pvp-season'] as const;
export const LANGS = ['en', 'de'] as const;
/** Catalog datasets served per game mode (language-neutral). */
export const MODE_DATASETS = [
  'bootstrap',
  'tasks-core',
  'tasks-objectives',
  'tasks-objectives?view=counts',
  'tasks-rewards',
  'hideout',
  'items-lite',
  'items',
  'prestige',
  'editions',
  'map-spawns',
  'tasks-import',
] as const;

export type Verdict = 'IDENTICAL' | 'IDENTICAL_NORMALIZED' | 'DIFFERENT' | 'MISSING';

export interface IdSetDelta {
  key: string;
  live: number;
  ours: number;
  onlyLive: string[];
  onlyOurs: string[];
}

export interface EndpointResult {
  label: string;
  verdict: Verdict;
  bytesEqual: boolean;
  normalized: string[];
  total: number;
  differences: Difference[];
  idSets: IdSetDelta[];
  note?: string;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const SAMPLE = 10;

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects `data.<key>` arrays of id-bearing objects and `data.strings` key sets. */
export function idSets(body: Json): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  const data = isObject(body) ? body.data : undefined;
  if (!isObject(data)) return sets;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      const ids = value.map((item) => (isObject(item) ? item.id : undefined));
      if (ids.length > 0 && ids.every((id) => typeof id === 'string')) {
        sets.set(key, new Set(ids as string[]));
      }
    } else if (key === 'strings' && isObject(value)) {
      sets.set(key, new Set(Object.keys(value)));
    }
  }
  return sets;
}

function deltaOf(key: string, live: Set<string>, ours: Set<string>): IdSetDelta {
  const onlyLive = [...live].filter((id) => !ours.has(id));
  const onlyOurs = [...ours].filter((id) => !live.has(id));
  return {
    key,
    live: live.size,
    ours: ours.size,
    onlyLive: onlyLive.slice(0, SAMPLE),
    onlyOurs: onlyOurs.slice(0, SAMPLE),
  };
}

export function compareIdSets(live: Json, ours: Json): IdSetDelta[] {
  const liveSets = idSets(live);
  const oursSets = idSets(ours);
  const keys = new Set([...liveSets.keys(), ...oursSets.keys()]);
  return [...keys]
    .sort()
    .map((key) => deltaOf(key, liveSets.get(key) ?? new Set(), oursSets.get(key) ?? new Set()));
}

function parse(bytes: Buffer): Json {
  return JSON.parse(decodeBody(bytes).toString('utf8')) as Json;
}

/** Compares one endpoint. `live` is the reference; either side may be missing. */
export function compareEndpoint(
  label: string,
  live: Buffer | undefined,
  ours: Buffer | undefined,
  limit = 200,
  paths: readonly string[] = VOLATILE_PATHS
): EndpointResult {
  const empty = { bytesEqual: false, normalized: [], total: 0, differences: [], idSets: [] };
  if (!live || !ours) {
    const note = !live ? 'missing on tarkovtracker.org side' : 'missing on our side';
    return { label, verdict: 'MISSING', note, ...empty };
  }
  const liveBytes = decodeBody(live);
  const oursBytes = decodeBody(ours);
  if (sha(liveBytes) === sha(oursBytes)) {
    return { label, verdict: 'IDENTICAL', ...empty, bytesEqual: true };
  }
  const liveJson = parse(live);
  const oursJson = parse(ours);
  const left = normalize(liveJson, paths);
  const right = normalize(oursJson, paths);
  const diff: DiffResult = diffJson(left.value, right.value, limit);
  const applied = [...new Set([...left.applied, ...right.applied])].sort();
  return {
    label,
    verdict: diff.total === 0 ? 'IDENTICAL_NORMALIZED' : 'DIFFERENT',
    bytesEqual: false,
    normalized: applied,
    total: diff.total,
    differences: diff.differences,
    idSets: compareIdSets(left.value, right.value),
  };
}

/** Resolves `@tt:` references through a strings table; unknown references stay as they are. */
export function resolveName(ref: unknown, strings: Record<string, string>): unknown {
  return typeof ref === 'string' && Object.hasOwn(strings, ref) ? strings[ref] : ref;
}

export interface NameMismatch {
  id: string;
  live: unknown;
  ours: unknown;
}

/** Per-task resolved name comparison, the check a user would actually notice in the UI. */
export function compareTaskNames(
  liveTasks: Json,
  oursTasks: Json,
  liveStrings: Record<string, string>,
  oursStrings: Record<string, string>
): { checked: number; mismatches: NameMismatch[] } {
  const index = (body: Json): Map<string, unknown> => {
    const data = isObject(body) ? body.data : undefined;
    const tasks = isObject(data) && Array.isArray(data.tasks) ? data.tasks : [];
    return new Map(
      tasks.filter(isObject).map((task) => [String(task.id), task.name] as [string, unknown])
    );
  };
  const live = index(liveTasks);
  const ours = index(oursTasks);
  const mismatches: NameMismatch[] = [];
  let checked = 0;
  for (const [id, liveRef] of live) {
    if (!ours.has(id)) continue;
    checked += 1;
    const a = resolveName(liveRef, liveStrings);
    const b = resolveName(ours.get(id), oursStrings);
    if (a !== b) mismatches.push({ id, live: a, ours: b });
  }
  return { checked, mismatches };
}

/** Groups differences by endpoint-relative field path with ids masked, for readable summaries. */
export function groupDifferences(differences: Difference[], depth = 4): Map<string, number> {
  const groups = new Map<string, number>();
  for (const { path, kind } of differences) {
    const masked = path.replace(/\[id=[^\]]*\]/g, '[]').replace(/\[\d+\]/g, '[]');
    const key = `${kind} ${masked.split('.').slice(0, depth).join('.')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}
