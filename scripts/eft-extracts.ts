/**
 * Generate extract requirement rules from the game's location and global definitions.
 *
 * tarkov.dev serves extract positions and a vehicle's transfer item, but not equipment
 * restrictions, opening chances, train/timer windows, cooperation or activation requirements.
 * The game client's `/client/locations` definitions carry them per exit, and
 * `/client/globals` (`config.RequirementReferences`) expands shared references such as
 * Alpinist's Paracord, Red Rebel and empty body-armor slot.
 *
 * Steps (both run by default):
 *   1. fetch  - save the remote session's archived `locations` and `globals` definitions for
 *               Regular and Seasonal under the gitignored data/reference/remote/<mode>/.
 *               A dataset equal to the newest saved one is not written again.
 *   2. generate - read the newest saved definitions, join every exit to its tarkov.dev extract
 *               by map ID and raw exit name, and write src/additions/extractRequirements.json5.
 *
 * PvE has no session of its own: its values come from the regular definitions' `*PVE` fields.
 * Committed output records only client builds and a definitions hash, never hosts, sessions,
 * capture dates or file names. Curated scene cues the game data does not describe live in the
 * hand-edited src/additions/extractCues.json5.
 *
 * Usage:
 *   REMOTE_SESSION_URL=http://<lan-host> npm run eft:extracts
 *   npm run eft:extracts -- --offline            # regenerate from saved definitions only
 *   npm run eft:extracts -- --allow-stale        # accept an archived copy the worker could not refresh
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import JSON5 from 'json5';

import {
  fetchTarkovEnvelope,
  isDirectExecution,
  printError,
  printProgress,
  printSuccess,
  TARKOV_MAP_NAMES_BY_ID,
} from '../src/lib/index.js';
import { getLanJson, lanOrigin } from './eft-remote.js';
import { writeFileAtomicSync } from './lib/atomic-write.js';
import {
  referenceDirectory,
  resolveReferenceDirectory,
  resolveReferenceWriteDirectory,
} from './local-reference.js';

/** Capture modes with a remote session, keyed by overlay mode. */
const SESSION_MODES = { regular: 'pvp', 'pvp-season': 'pvp-season' } as const;
type CaptureMode = keyof typeof SESSION_MODES;
const CAPTURE_MODES = Object.keys(SESSION_MODES) as CaptureMode[];
const DATASETS = { locations: '/client/locations', globals: '/client/globals' } as const;
type Dataset = keyof typeof DATASETS;
/** tarkov.dev catalogs whose extract IDs the rules are keyed by. */
const CATALOG_MODES = ['regular', 'pve', 'pvp-season'] as const;
const OUTPUT = join('src', 'additions', 'extractRequirements.json5');

type JsonRecord = Record<string, unknown>;
export type ExtractRule = {
  type: string;
  item?: string;
  count?: number;
  countPve?: number;
  vehicle?: boolean;
  slot?: string;
  percent?: number;
  percentPve?: number;
  min?: number;
  max?: number;
  minPve?: number;
  maxPve?: number;
};
export type ExtractEntry = {
  name: string;
  rules?: ExtractRule[];
  pvp?: ExtractRule[];
  seasonal?: ExtractRule[];
};
export type ExtractRequirementsFile = {
  sources: Partial<Record<CaptureMode, { clientBuild: string; definitionsSha256: string }>>;
  maps: Record<string, Record<string, ExtractEntry>>;
};
export type SavedDefinitions = { appVersion: string; data: JsonRecord };
type Exit = JsonRecord & { Name?: unknown; PassageRequirement?: unknown };
type References = Record<string, JsonRecord[]>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ---------------------------------------------------------------- rules

/** Configured window in seconds after raid start, with PvE values when they differ. */
function timeWindow(exit: Exit): Pick<ExtractRule, 'min' | 'max' | 'minPve' | 'maxPve'> {
  return {
    min: num(exit.MinTime),
    max: num(exit.MaxTime),
    minPve: num(exit.MinTimePVE),
    maxPve: num(exit.MaxTimePVE),
  };
}

/** One `RequirementReferences` entry; requirement kinds without a rule stay unknown. */
function referenceRule(entry: JsonRecord): ExtractRule {
  if (entry.Requirement === 'HasItem' && typeof entry.Id === 'string' && entry.Id) {
    return { type: 'item', item: entry.Id, count: num(entry.Count) ?? 1 };
  }
  if (entry.Requirement === 'Empty' && typeof entry.RequiredSlot === 'string') {
    return { type: 'empty', slot: entry.RequiredSlot };
  }
  return { type: 'unknown' };
}

function referenceRules(exit: Exit, references: References): ExtractRule[] {
  const entries = typeof exit.Id === 'string' ? references[exit.Id] : undefined;
  return Array.isArray(entries) && entries.length
    ? entries.filter(isRecord).map(referenceRule)
    : [{ type: 'unknown' }];
}

/** A shared-timer transfer is a vehicle: it must still be there and leaves once used. */
function transferRules(exit: Exit): ExtractRule[] {
  if (typeof exit.Id !== 'string' || !exit.Id) return [{ type: 'unknown' }];
  return [
    {
      type: 'transfer',
      item: exit.Id,
      count: num(exit.Count),
      countPve: num(exit.CountPVE),
      vehicle: exit.ExfiltrationType === 'SharedTimer',
    },
  ];
}

const RULE_BUILDERS: Record<string, (exit: Exit, references: References) => ExtractRule[]> = {
  None: () => [],
  TransferItem: transferRules,
  ScavCooperation: () => [{ type: 'coop' }],
  WorldEvent: () => [{ type: 'activation' }],
  Empty: (exit) =>
    typeof exit.RequiredSlot === 'string' && exit.RequiredSlot
      ? [{ type: 'empty', slot: exit.RequiredSlot }]
      : [{ type: 'unknown' }],
  Train: (exit) => [{ type: 'train', ...timeWindow(exit) }],
  Timer: (exit) => [{ type: 'timer', ...timeWindow(exit) }],
  Reference: referenceRules,
};

/** A configured opening chance below 100% in either PvP or PvE. */
function chanceRules(exit: Exit): ExtractRule[] {
  const percent = num(exit.Chance);
  const percentPve = num(exit.ChancePVE);
  if (percent === undefined || (percent >= 100 && (percentPve ?? 100) >= 100)) return [];
  return [{ type: 'chance', percent, percentPve }];
}

/** Requirement rules for one exit; a missing or unrecognised requirement stays unknown. */
export function exitRules(exit: Exit, references: References): ExtractRule[] {
  const kind = typeof exit.PassageRequirement === 'string' ? exit.PassageRequirement : '';
  const build = Object.hasOwn(RULE_BUILDERS, kind) ? RULE_BUILDERS[kind] : undefined;
  const rules = build ? build(exit, references) : [{ type: 'unknown' }];
  return [...rules, ...chanceRules(exit)].map(withoutUndefined);
}

function withoutUndefined(rule: ExtractRule): ExtractRule {
  return Object.fromEntries(
    Object.entries(rule).filter(([, value]) => value !== undefined)
  ) as ExtractRule;
}

// ---------------------------------------------------------------- joins

type Catalog = Map<string, Set<string>>;
const catalogKey = (mapId: string, name: string) => `${mapId}\u0000${name}`;

/** tarkov.dev extract IDs by map ID and raw exit name, across every served mode. */
export function extractCatalog(mapCollections: unknown[]): Catalog {
  const catalog: Catalog = new Map();
  for (const maps of mapCollections) {
    for (const map of Object.values(isRecord(maps) ? maps : {})) addMapExtracts(catalog, map);
  }
  return catalog;
}

function addMapExtracts(catalog: Catalog, map: unknown): void {
  if (!isRecord(map) || typeof map.id !== 'string' || !Array.isArray(map.extracts)) return;
  for (const extract of map.extracts.filter(isRecord)) {
    if (typeof extract.id !== 'string' || typeof extract.name !== 'string') continue;
    const key = catalogKey(map.id, extract.name);
    catalog.set(key, (catalog.get(key) ?? new Set()).add(extract.id));
  }
}

/** Exact raw name first; tarkov.dev trims names such as Lighthouse's " V-Ex_light". */
function extractIds(catalog: Catalog, mapId: string, name: string): string[] {
  const ids = catalog.get(catalogKey(mapId, name)) ?? catalog.get(catalogKey(mapId, name.trim()));
  return [...(ids ?? [])];
}

type ModeRules = Map<string, { mapId: string; name: string; rules: ExtractRule[] }>;

/** Rules per tarkov.dev extract ID for one capture mode, limited to tarkov.dev maps. */
export function modeRules(definitions: SavedDefinitions, catalog: Catalog): ModeRules {
  const locations = isRecord(definitions.data.locations) ? definitions.data.locations : {};
  const references = requirementReferences(definitions);
  const result: ModeRules = new Map();
  for (const [mapId, location] of Object.entries(locations)) {
    if (!TARKOV_MAP_NAMES_BY_ID[mapId] || !isRecord(location)) continue;
    addLocationRules(result, mapId, location, { catalog, references });
  }
  return result;
}

function requirementReferences(definitions: SavedDefinitions): References {
  const config = isRecord(definitions.data.globals) ? definitions.data.globals.config : undefined;
  const references = isRecord(config) ? config.RequirementReferences : undefined;
  return isRecord(references) ? (references as References) : {};
}

function addLocationRules(
  result: ModeRules,
  mapId: string,
  location: JsonRecord,
  context: { catalog: Catalog; references: References }
): void {
  const exits = Array.isArray(location.exits) ? location.exits.filter(isRecord) : [];
  for (const exit of exits as Exit[]) {
    if (typeof exit.Name !== 'string' || !exit.Name) continue;
    const rules = exitRules(exit, context.references);
    for (const id of extractIds(context.catalog, mapId, exit.Name)) {
      result.set(id, { mapId, name: exit.Name.trim(), rules });
    }
  }
}

/** Rules equal in both captures are shared; otherwise each mode keeps its own list. */
function entryFor(
  regular: ExtractRule[] | undefined,
  seasonal: ExtractRule[] | undefined
): Omit<ExtractEntry, 'name'> {
  if (regular && seasonal && JSON.stringify(regular) === JSON.stringify(seasonal)) {
    return { rules: regular };
  }
  return { ...(regular ? { pvp: regular } : {}), ...(seasonal ? { seasonal } : {}) };
}

/** Combine both capture modes into the committed file shape, in a stable order. */
export function buildExtractRequirements(
  definitions: Partial<Record<CaptureMode, SavedDefinitions>>,
  catalog: Catalog
): ExtractRequirementsFile {
  const regular = definitions.regular ? modeRules(definitions.regular, catalog) : new Map();
  const seasonal = definitions['pvp-season']
    ? modeRules(definitions['pvp-season'], catalog)
    : new Map();
  const maps: ExtractRequirementsFile['maps'] = {};
  for (const id of [...new Set([...regular.keys(), ...seasonal.keys()])].sort()) {
    const base = regular.get(id) ?? seasonal.get(id)!;
    const entry = { name: base.name, ...entryFor(regular.get(id)?.rules, seasonal.get(id)?.rules) };
    (maps[base.mapId] ??= {})[id] = entry;
  }
  return { sources: sourcesFor(definitions), maps: sortedRecord(maps) };
}

function sourcesFor(
  definitions: Partial<Record<CaptureMode, SavedDefinitions>>
): ExtractRequirementsFile['sources'] {
  const sources: ExtractRequirementsFile['sources'] = {};
  for (const mode of CAPTURE_MODES) {
    const saved = definitions[mode];
    if (!saved) continue;
    sources[mode] = {
      clientBuild: saved.appVersion.replace(/^EFT Client\s*/, ''),
      definitionsSha256: sha256(saved.data),
    };
  }
  return sources;
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

// ---------------------------------------------------------------- output

const HEADER = [
  '// Extract requirement rules - not served by the tarkov.dev API.',
  '//',
  "// GENERATED by `npm run eft:extracts`; do not edit by hand. Source: the game client's",
  '// location definitions (per-exit requirement, chance, count and time window) and global',
  '// RequirementReferences, for the client builds in `sources`. Entries are keyed by',
  '// tarkov.dev map ID, then by the tarkov.dev extract ID matched on the raw exit name.',
  '// `rules` applies to every mode; `pvp` / `seasonal` appear only when the two captures',
  "// differ. PvE reads the regular definitions' *Pve values. A chance is the configured",
  '// opening chance, not live raid status. `unknown` marks an exit whose requirement the',
  '// definitions do not describe. Curated scene cues live in extractCues.json5.',
].join('\n');

export function renderExtractRequirements(data: ExtractRequirementsFile): string {
  return `${HEADER}\n${JSON5.stringify(data, { space: 2, quote: "'" })}\n`;
}

// ---------------------------------------------------------------- references

type RemoteDatasetResponse = {
  ok?: unknown;
  stale?: unknown;
  data?: unknown;
  source?: { mode?: unknown; captured_mode?: unknown; app_version?: unknown; path?: unknown };
};

/** A remote `locations` / `globals` response must be the requested dataset and mode. */
export function validateDatasetResponse(
  body: RemoteDatasetResponse,
  options: { sessionMode: string; dataset: Dataset; allowStale: boolean }
): SavedDefinitions {
  const source = body.source ?? {};
  const problem =
    datasetProblem(body, options) ??
    contentProblem(body.data as JsonRecord, options.dataset) ??
    sourceProblem(source, options);
  if (problem) throw new Error(`remote ${options.dataset}: ${problem}`);
  return { appVersion: source.app_version as string, data: body.data as JsonRecord };
}

/** An otherwise valid but empty payload must not replace saved definitions or generated rules. */
function contentProblem(data: JsonRecord, dataset: Dataset): string | undefined {
  if (dataset === 'locations') {
    const locations = data.locations;
    return isRecord(locations) && Object.keys(locations).length
      ? undefined
      : 'has no locations collection';
  }
  return isRecord(data.config) ? undefined : 'has no config';
}

function datasetProblem(
  body: RemoteDatasetResponse,
  options: { allowStale: boolean }
): string | undefined {
  if (body.ok !== true) return 'did not return ok';
  if (body.stale === true && !options.allowStale) {
    return 'is a stale archived copy the worker could not refresh (pass --allow-stale to accept it)';
  }
  return isRecord(body.data) ? undefined : 'has no definitions';
}

function sourceProblem(
  source: NonNullable<RemoteDatasetResponse['source']>,
  options: { sessionMode: string; dataset: Dataset }
): string | undefined {
  if (source.path !== DATASETS[options.dataset]) return `is not ${DATASETS[options.dataset]}`;
  if (
    source.mode !== options.sessionMode ||
    (source.captured_mode ?? source.mode) !== source.mode
  ) {
    return `is from ${String(source.captured_mode ?? source.mode)}, expected ${options.sessionMode}`;
  }
  return typeof source.app_version === 'string' ? undefined : 'has no client version';
}

const datasetSuffix = (dataset: Dataset) => `.${dataset}.json`;

/** Saved files for one dataset, newest name last (names start with an ISO-like stamp). */
function savedFiles(dir: string, dataset: Dataset): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(datasetSuffix(dataset)))
    .sort();
}

export function readSavedDefinitions(file: string): SavedDefinitions {
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as JsonRecord;
  const source = isRecord(envelope.source) ? envelope.source : {};
  const response = isRecord(envelope.response) ? envelope.response : {};
  const body = isRecord(response.body_response) ? response.body_response : {};
  if (typeof source.appVersion !== 'string' || !isRecord(body.data)) {
    throw new Error(`saved definitions ${file} are malformed`);
  }
  return { appVersion: source.appVersion, data: body.data };
}

/**
 * Save `definitions` unless the newest saved copy has the same definitions and client build;
 * files are created exclusively. Comparing the build too means a client update that changes only
 * one dataset still re-saves the other under the new build, so the pair always matches.
 */
export function saveDefinitions(
  dir: string,
  options: { sessionMode: string; dataset: Dataset; stamp: string },
  definitions: SavedDefinitions
): { file: string; written: boolean } {
  const hash = sha256(definitions.data);
  const newest = savedFiles(dir, options.dataset).at(-1);
  const saved = newest ? readSavedDefinitions(join(dir, newest)) : undefined;
  if (saved && saved.appVersion === definitions.appVersion && sha256(saved.data) === hash) {
    return { file: join(dir, newest!), written: false };
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${options.stamp}_${hash.slice(0, 12)}${datasetSuffix(options.dataset)}`);
  const envelope = {
    request: { method: 'GET', path: DATASETS[options.dataset] },
    source: {
      kind: 'remote-session',
      mode: options.sessionMode,
      appVersion: definitions.appVersion,
      definitionsSha256: hash,
    },
    response: { body_response: { err: 0, data: definitions.data } },
  };
  writeFileSync(file, JSON.stringify(envelope), { flag: 'wx' });
  return { file, written: true };
}

// ---------------------------------------------------------------- CLI

export type ExtractArgs = { url?: string; offline: boolean; allowStale: boolean };

export function parseExtractArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ExtractArgs {
  const args: ExtractArgs = { url: env.REMOTE_SESSION_URL, offline: false, allowStale: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[(i += 1)];
    else if (argv[i] === '--offline') args.offline = true;
    else if (argv[i] === '--allow-stale') args.allowStale = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!args.offline && !args.url)
    throw new Error('Set REMOTE_SESSION_URL, pass --url, or --offline');
  return args;
}

const modeDirectory = (mode: CaptureMode) => join(referenceDirectory(), 'remote', mode);

async function fetchMode(origin: string, mode: CaptureMode, allowStale: boolean): Promise<void> {
  const sessionMode = SESSION_MODES[mode];
  const dir = resolveReferenceWriteDirectory(modeDirectory(mode));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const dataset of Object.keys(DATASETS) as Dataset[]) {
    const response = await getLanJson(`${origin}/api/${sessionMode}/${dataset}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`remote ${dataset} returned HTTP ${response.status}`);
    }
    const options = { sessionMode, dataset, allowStale };
    const definitions = validateDatasetResponse(response.body as RemoteDatasetResponse, options);
    const saved = saveDefinitions(dir, { sessionMode, dataset, stamp }, definitions);
    printProgress(
      `${mode} ${dataset}: ${saved.written ? 'saved' : 'unchanged'} ${relative(process.cwd(), saved.file)}`
    );
  }
}

/** The newest saved locations and globals for one mode, or undefined when either is missing. */
function newestDefinitions(mode: CaptureMode): SavedDefinitions | undefined {
  const dir = resolveReferenceDirectory(modeDirectory(mode));
  const [locations, globals] = (['locations', 'globals'] as Dataset[]).map((dataset) =>
    savedFiles(dir, dataset).at(-1)
  );
  if (!locations || !globals) return undefined;
  const saved = readSavedDefinitions(join(dir, locations));
  const savedGlobals = readSavedDefinitions(join(dir, globals));
  if (saved.appVersion !== savedGlobals.appVersion) {
    throw new Error(`${mode} locations and globals are from different client builds`);
  }
  return { appVersion: saved.appVersion, data: { ...saved.data, globals: savedGlobals.data } };
}

async function generate(): Promise<ExtractRequirementsFile> {
  const definitions = Object.fromEntries(
    CAPTURE_MODES.flatMap((mode) => {
      const saved = newestDefinitions(mode);
      return saved ? [[mode, saved]] : [];
    })
  ) as Partial<Record<CaptureMode, SavedDefinitions>>;
  if (!definitions.regular)
    throw new Error('no saved regular locations/globals; run without --offline');
  const catalogs = await Promise.all(
    CATALOG_MODES.map(async (mode) => catalogMaps(mode, await fetchTarkovEnvelope(`${mode}/maps`)))
  );
  return buildExtractRequirements(definitions, extractCatalog(catalogs));
}

/** tarkov.dev's maps for one mode; a response without them must not empty the generated file. */
export function catalogMaps(mode: string, envelope: { data: unknown }): JsonRecord {
  const maps = isRecord(envelope.data) ? envelope.data.maps : undefined;
  if (!isRecord(maps) || !Object.keys(maps).length) {
    throw new Error(`json.tarkov.dev ${mode}/maps has no maps`);
  }
  return maps;
}

async function main(): Promise<void> {
  try {
    const args = parseExtractArgs(process.argv.slice(2));
    if (!args.offline) {
      const origin = await lanOrigin(args.url!);
      for (const mode of CAPTURE_MODES) await fetchMode(origin, mode, args.allowStale);
    }
    const data = await generate();
    writeFileAtomicSync(OUTPUT, renderExtractRequirements(data));
    const count = Object.values(data.maps).reduce((sum, map) => sum + Object.keys(map).length, 0);
    const builds = Object.entries(data.sources).map(
      ([mode, source]) => `${mode} ${source!.clientBuild}`
    );
    printSuccess(`Wrote ${count} extracts (${builds.join(', ')}) to ${OUTPUT}`);
    process.exitCode = 0;
  } catch (error) {
    printError('Error generating extract requirements:', error as Error);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
