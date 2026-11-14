import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPaths, loadJson5File } from '../src/lib/file-loader.js';
import { isDirectExecution } from '../src/lib/script-utils.js';
import {
  translateComparisonValues,
  validateTranslationMap,
} from '../src/lib/tarkov-api-shared.cjs';
import { fetchTarkovEnvelope } from '../src/lib/tarkov-api.js';
import { comparisonTranslation } from '../src/lib/task-comparison.cjs';
import { SUPPORTED_GAME_MODES, type GameMode } from '../src/lib/types.js';
import {
  validateSeasonalPerks,
  validateProgressionCounters,
  type SupplementReport,
} from '../src/lib/supplement-validator.js';

type Counts = Pick<SupplementReport, 'actionable' | 'staleProblems'>;
type FetchEnvelope = typeof fetchTarkovEnvelope;
type LoadSupplement = (name: string) => Record<string, unknown>;

function loadSupplement(sourceDir: string, name: string): Record<string, unknown> {
  const file = join(sourceDir, 'additions', `${name}.json5`);
  return existsSync(file) ? loadJson5File(file) : {};
}

async function compareSupplement(
  label: string,
  path: string,
  validate: (data: unknown) => SupplementReport,
  fetchEnvelope: FetchEnvelope,
  counts: Counts
): Promise<void> {
  try {
    const report = validate((await fetchEnvelope(path)).data);
    counts.actionable += report.actionable;
    counts.staleProblems += report.staleProblems;
    for (const message of report.messages) console.log(`${label}: ${message}`);
  } catch {
    throw new Error(`${label}: upstream comparison unavailable or malformed`);
  }
}

async function seasonTranslations(fetchEnvelope: FetchEnvelope): Promise<Record<string, string>> {
  try {
    return validateTranslationMap(
      (await fetchEnvelope('pvp-season/season_en', false)).data,
      'season_en'
    );
  } catch {
    throw new Error('pvp-season: upstream comparison unavailable or malformed');
  }
}

function textRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function applyPerkTexts(
  perk: Record<string, unknown>,
  result: Record<string, unknown>,
  translations: Record<string, string>
): void {
  for (const field of ['name', 'description']) {
    if (Object.hasOwn(perk, field))
      result[field] = comparisonTranslation(perk[field], translations);
  }
}

function perkTexts(raw: unknown, translations: Record<string, string>): unknown {
  if (!textRecord(raw)) return raw;
  const result = translateComparisonValues(raw, translations) as Record<string, unknown>;
  applyPerkTexts(raw, result, translations);
  return result;
}

function perkGroupTexts(raw: unknown, translations: Record<string, string>): unknown {
  return Array.isArray(raw) ? raw.map((perk) => perkTexts(perk, translations)) : raw;
}

function seasonTexts(raw: unknown, translations: Record<string, string>): unknown {
  if (!textRecord(raw)) return raw;
  const perks = raw.perks;
  if (!textRecord(perks)) return raw;
  return {
    ...raw,
    perks: Object.fromEntries(
      Object.entries(perks).map(([key, group]) => [key, perkGroupTexts(group, translations)])
    ),
  };
}

async function checkPerks(
  load: LoadSupplement,
  fetchEnvelope: FetchEnvelope,
  counts: Counts
): Promise<void> {
  const perks = load('seasonalPerks');
  if (!Object.keys(perks).length) {
    console.log('seasonalPerks: no supplemental entries');
    return;
  }
  const translations = await seasonTranslations(fetchEnvelope);
  await compareSupplement(
    'pvp-season',
    'pvp-season/season',
    (data) => validateSeasonalPerks(perks, seasonTexts(data, translations)),
    fetchEnvelope,
    counts
  );
}

async function checkCounterMode(
  mode: string,
  entries: unknown,
  fetchEnvelope: FetchEnvelope,
  counts: Counts,
  taskData?: Record<string, unknown>
): Promise<void> {
  if (!entries || !Object.keys(entries).length) {
    console.log(`${mode}/progressionCounters: no supplemental entries`);
    return;
  }
  await compareSupplement(
    mode,
    `${mode}/tasks`,
    (data) => validateProgressionCounters(entries as Record<string, unknown>, data),
    taskData === undefined ? fetchEnvelope : async () => ({ data: taskData }),
    counts
  );
}

function endpointLabel(entry: unknown): string {
  const endpoint = entry as { name?: unknown; path?: unknown };
  if (typeof endpoint?.name !== 'string' || typeof endpoint.path !== 'string') {
    throw new Error('Expected endpoint name and path');
  }
  return `${endpoint.name} ${endpoint.path}`;
}

async function discoverEndpoints(fetchEnvelope: FetchEnvelope): Promise<string[]> {
  try {
    const data = (await fetchEnvelope('endpoints')).data as { endpoints?: unknown };
    if (!Array.isArray(data?.endpoints) || !data.endpoints.length) {
      throw new Error('Expected nonempty endpoint catalogue');
    }
    return data.endpoints.map(endpointLabel);
  } catch {
    throw new Error('Supplement endpoint discovery unavailable or malformed');
  }
}

/** Supplements with no upstream counterpart, and the endpoint names that would need review. */
const UNSUPPORTED_SUPPLEMENTS: Record<string, RegExp> = {
  editions: /edition/i,
  storyChapters: /\b(?:story|chapters?|storyChapters)\b/i,
  extractRequirements: /exfil|extract[-_ ]?(?:requirement|rule)/i,
  extractCues: /exfil|extract[-_ ]?cue/i,
};

/** Map-then-extract sections count extracts; other supplements count top-level records. */
function supplementEntryCount(name: string, data: Record<string, unknown>): number {
  if (!name.startsWith('extract')) return Object.keys(data).length;
  const maps = (name === 'extractRequirements' ? data.maps : data) as Record<string, object>;
  return Object.values(maps ?? {}).reduce((sum, extracts) => sum + Object.keys(extracts).length, 0);
}

function reportUnsupported(name: string, endpoints: string[], load: LoadSupplement): void {
  const pattern = UNSUPPORTED_SUPPLEMENTS[name]!;
  const candidates = endpoints.filter((endpoint) => pattern.test(endpoint));
  if (candidates.length) {
    console.log(
      `${name}: NEEDS REVIEW — new potential upstream endpoint(s): ${candidates.join(', ')}; comparison not implemented`
    );
    return;
  }
  console.log(
    `${name}: NOT COMPARABLE — no corresponding endpoint advertised; ${supplementEntryCount(name, load(name))} supplemental entries (not a clean upstream comparison)`
  );
}

export async function checkSupplements(
  sourceDir = getProjectPaths().srcDir,
  fetchEnvelope: FetchEnvelope = fetchTarkovEnvelope,
  taskDataByMode: Partial<Record<GameMode, Record<string, unknown>>> = {}
): Promise<Counts> {
  const counts = { actionable: 0, staleProblems: 0 };
  const load: LoadSupplement = (name) => loadSupplement(sourceDir, name);
  console.log(
    'taskIdAliases: NOT COMPARABLE — historical identity ledger; validate mappings against recorded evidence, not current upstream absence'
  );
  await checkPerks(load, fetchEnvelope, counts);
  const counters = load('progressionCounters');
  await Promise.all(
    SUPPORTED_GAME_MODES.map((mode) =>
      checkCounterMode(mode, counters[mode], fetchEnvelope, counts, taskDataByMode[mode])
    )
  );
  const endpoints = await discoverEndpoints(fetchEnvelope);
  for (const name of Object.keys(UNSUPPORTED_SUPPLEMENTS)) reportUnsupported(name, endpoints, load);
  return counts;
}

function printSummary(counts: Counts): void {
  console.log(
    `Supplements: ${counts.actionable} reference problems, ${counts.staleProblems} adopted raw effects`
  );
  process.exitCode = counts.actionable ? 2 : counts.staleProblems ? 3 : 0;
}

if (isDirectExecution(import.meta.url)) {
  checkSupplements()
    .then(printSummary)
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
