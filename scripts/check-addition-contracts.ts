import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJson5File } from '../src/lib/file-loader.js';
import {
  fetchItemValidationSnapshot,
  fetchRawEntities,
  fetchTarkovEnvelope,
} from '../src/lib/tarkov-api.js';
import { SUPPORTED_GAME_MODES, type GameMode, type TaskData } from '../src/lib/types.js';
import {
  validateAdditionContracts,
  type AdditionContractContext,
  type AdditionSection,
} from '../src/lib/addition-contracts.js';
import { comparisonRecords } from '../src/lib/tarkov-api-shared.cjs';

type RecordData = Record<string, unknown>;
type Catalog = Map<string, RecordData>;
type TasksByMode = Partial<Record<GameMode, TaskData[]>>;

function load(sourceDir: string, ...segments: string[]): RecordData {
  const file = join(sourceDir, ...segments);
  return existsSync(file) ? loadJson5File(file) : {};
}

/** Overlay aliases are references, not additional upstream evidence. */
function includeAdditions(catalog: Catalog, additions: RecordData): Catalog {
  const result = new Map(catalog);
  for (const [key, raw] of Object.entries(additions)) {
    includeAdditionAliases(result, key, raw);
  }
  return result;
}

function additionRecord(raw: unknown): RecordData | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as RecordData;
}

function includeAdditionAliases(catalog: Catalog, key: string, raw: unknown): void {
  const entry = additionRecord(raw);
  if (!entry) return;
  includeAlias(catalog, key, entry);
  if (typeof entry.id === 'string') includeAlias(catalog, entry.id, entry);
}

function includeAlias(catalog: Catalog, key: string, entry: RecordData): void {
  if (!catalog.has(key)) catalog.set(key, entry);
}

export async function fetchContractContext(
  mode: GameMode,
  tasks: TaskData[]
): Promise<AdditionContractContext> {
  const [itemData, stations, crafts, traders, maps] = await Promise.all([
    fetchItemValidationSnapshot(mode),
    fetchRawEntities(mode, 'hideout'),
    fetchRawEntities(mode, 'crafts'),
    fetchRawEntities(mode, 'traders'),
    fetchRawEntities(mode, 'maps', 'maps'),
  ]);
  const categories = itemData.data.categories;
  return {
    items: itemData.items,
    stations,
    crafts,
    traders,
    maps,
    tasks: new Map(tasks.map((task) => [task.id, task as unknown as RecordData])),
    categories:
      categories === undefined
        ? undefined
        : new Map(
            comparisonRecords(categories, 'item categories').map((category) => [
              category.id as string,
              category,
            ])
          ),
  };
}

function checkSection(
  section: AdditionSection,
  entries: RecordData,
  context: AdditionContractContext,
  label: string
): number {
  const diagnostics = validateAdditionContracts(section, entries, context);
  for (const diagnostic of diagnostics) {
    console.log(
      `${label}/${diagnostic.id}.${diagnostic.field}: ${diagnostic.status.toUpperCase()} - ${diagnostic.message}`
    );
  }
  return diagnostics.filter((diagnostic) => diagnostic.status === 'invalid').length;
}

function modeSections(sourceDir: string, mode: GameMode): Record<AdditionSection, RecordData> {
  return {
    itemsAdd: load(sourceDir, 'additions', 'itemsAdd.json5'),
    craftsAdd: load(sourceDir, 'additions', 'craftsAdd.json5'),
    tasksAdd: {
      ...load(sourceDir, 'additions', 'tasksAdd.json5'),
      ...load(sourceDir, 'additions', 'modes', mode, 'tasksAdd.json5'),
    },
    seasonalPerks: mode === 'pvp-season' ? load(sourceDir, 'additions', 'seasonalPerks.json5') : {},
  };
}

async function perkCatalog(): Promise<Catalog> {
  const data = (await fetchTarkovEnvelope('pvp-season/season')).data as RecordData;
  const collections = perkGroups(data?.perks);
  if (!collections.every(Array.isArray)) throw new Error('Invalid seasonal perk groups');
  const records = comparisonRecords(collections.flat(), 'seasonal perks');
  return new Map(records.map((perk) => [perk.id as string, perk]));
}

function perkGroups(groups: unknown): unknown[] {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups))
    throw new Error('Invalid seasonal perk catalog');
  return Object.values(groups);
}

async function checkModeContracts(
  sourceDir: string,
  mode: GameMode,
  tasksByMode: TasksByMode,
  getContext: typeof fetchContractContext,
  getPerks: typeof perkCatalog
): Promise<number> {
  const entries = modeSections(sourceDir, mode);
  const context = await getContext(mode, tasksByMode[mode] ?? []);
  context.itemsAdd = includeAdditions(new Map(), entries.itemsAdd);
  context.tasksAdd = includeAdditions(new Map(), entries.tasksAdd);
  if (Object.keys(entries.seasonalPerks).length) context.perks = await getPerks();
  let actionable = 0;
  for (const section of Object.keys(entries) as AdditionSection[]) {
    actionable += checkSection(section, entries[section], context, `${mode}/${section}`);
  }
  const partial = { ...context, partial: true };
  actionable += checkSection(
    'itemsAdd',
    load(sourceDir, 'overrides', 'items.json5'),
    partial,
    `${mode}/items`
  );
  const sharedTasks = load(sourceDir, 'overrides', 'tasks.json5');
  const modeTasks = load(sourceDir, 'overrides', 'modes', mode, 'tasks.json5');
  actionable += checkSection('tasksAdd', sharedTasks, partial, `${mode}/sharedTasks`);
  actionable += checkSection('tasksAdd', modeTasks, partial, `${mode}/tasks`);
  return actionable;
}

/** Validate supplied format and references in every applicable mode without changing data. */
export async function checkAdditionContracts(
  sourceDir: string,
  tasksByMode: TasksByMode,
  getContext = fetchContractContext,
  getPerks = perkCatalog
): Promise<{ actionable: number; staleProblems: number; upstreamProblems: number }> {
  let actionable = 0;
  for (const mode of SUPPORTED_GAME_MODES) {
    actionable += await checkModeContracts(sourceDir, mode, tasksByMode, getContext, getPerks);
  }
  return { actionable, staleProblems: 0, upstreamProblems: 0 };
}
