#!/usr/bin/env tsx
/**
 * Full quest coverage check:  REFERENCE  ->  what consumers see
 * (tarkov.dev + effective overrides, or the overlay's own additions).
 *
 * eft:audit adjudicates four fields for tasks tarkov.dev already serves. This
 * tool covers every quest in the reference and every field the reference can
 * speak to, so one run answers "is the overlay accurate for this capture?":
 *
 *   Coverage, per reference quest:
 *     upstream     served by tarkov.dev in this mode (fields compared after
 *                  applying the effective shared + mode overrides)
 *     addition     an overlay task addition with the real BSG id
 *     placeholder  a `placeholder_*` addition matched by name and trader; the
 *                  report prints the placeholder -> real id mapping and the
 *                  objective mapping matched by text (issue #507 ledger)
 *     story        referenced by storyChapters (checked by eft:story)
 *     hidden       `notDisplayedQuest` helper quest with no overlay entry
 *     missing      visible quest that no source represents (add it)
 *
 *   Fields compared for upstream / addition / placeholder quests:
 *     name, trader, map (`location`; `any` is no map), experience,
 *     minPlayerLevel (explicit Level gate only), Quest prerequisites and their
 *     accepted statuses, availability delay, explicit TraderLoyalty gates,
 *     GlobalVariableValue start gates, objective presence / counts / text, and
 *     finish rewards (items, trader standing, offer unlocks).
 *
 * Field authority follows AGENTS.md: a missing Level or TraderLoyalty condition
 * is not evidence of "no gate", so only explicit reference gates are checked.
 * Prerequisite targets tarkov.dev cannot represent (story or absent tasks) are
 * reported as info, never as edges to add. Objective text differences are info
 * because tarkov.dev rephrases objectives intentionally.
 *
 * LOCAL-ONLY: requires a reference in data/reference/ (a decoded capture or an
 * eft:remote snapshot). Reference quests are account-scoped: a quest absent
 * from the reference proves nothing, so overlay entries are never flagged for
 * being absent from it.
 *
 * Usage:
 *   tsx scripts/eft-coverage.ts [eftDir] [--mode pve|regular|pvp-season] [--json out.json] [--all]
 *   npm run eft:coverage -- --mode pvp-season
 *
 * `--all` also prints info rows. Exit codes: 0 when the check ran; 1 when it
 * could not run.
 */

import { existsSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import {
  isDirectExecution,
  fetchRawEntities,
  fetchTasks,
  loadJson5File,
  getProjectPaths,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  colors,
  icons,
  TARKOV_MAP_NAMES_BY_ID,
  TARKOV_TRADER_NAMES_BY_ID,
  type GameMode,
  type TaskAddition,
  type TaskData,
  type TaskObjective,
  type TaskOverride,
  type TaskRewards,
} from '../src/lib/index.js';
import { normalizeTaskStatus } from '../src/lib/task-unlocks.js';
import { effectiveOverrides } from './eft-audit.js';
import {
  findReferenceFile,
  parseModeArgs,
  readQuestArray,
  referenceAppVersion,
  requireMatchingReferenceMode,
} from './eft-compare.js';
import { canonicalQuestId, loadSiblingLocale, questText } from './lib/quest-definitions.js';

// ---------------------------------------------------------------------------
// Reference normalization
// ---------------------------------------------------------------------------

/** Condition types whose `value` is the objective count tarkov.dev exposes. */
const COUNTABLE_CONDITIONS = new Set([
  'CounterCreator',
  'FindItem',
  'HandoverItem',
  'LeaveItemAtLocation',
  'PlaceBeacon',
  'SellItemToTrader',
]);

type RawRecord = Record<string, unknown>;

export interface RefPrerequisite {
  target: string;
  statuses?: string[];
  availableAfter: number;
  dispersion: number;
}

export interface RefObjective {
  id: string;
  conditionType: string;
  text?: string;
  count?: number;
  parentId?: string;
}

export interface RefQuest {
  id: string;
  name?: string;
  traderId?: string;
  /** Map id, null for `any`, undefined when the reference has no location. */
  mapId?: string | null;
  hidden: boolean;
  experience?: number;
  minPlayerLevel?: number;
  prerequisites: RefPrerequisite[];
  loyalty: Array<{ traderId: string; compareMethod: string; value: number }>;
  globalVariables: Array<{ variableId: string; compareMethod: string; value: number }>;
  objectives: RefObjective[];
  rewards: {
    items: Map<string, number>;
    standing: Map<string, number>;
    offerUnlocks: Set<string>;
  };
}

const isRecord = (value: unknown): value is RawRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const records = (value: unknown): RawRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
/** Reference ids, unwrapped when the enriched variant wraps them as `[<id> name]`. */
const refId = (value: unknown): string | undefined => {
  const id = asString(value);
  return id === undefined ? undefined : canonicalQuestId(id);
};

function sumInto(
  map: Map<string, number>,
  key: string | undefined,
  value: number | undefined
): void {
  if (!key || value === undefined) return;
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Accepted statuses of a Quest condition, or undefined when any is unknown. */
function prerequisiteStatuses(status: unknown): string[] | undefined {
  const statuses = Array.isArray(status) ? status.map(normalizeTaskStatus) : [];
  if (statuses.length === 0 || statuses.some((s) => s === undefined)) return undefined;
  return [...new Set(statuses as string[])].sort();
}

/** Readers for the start-condition types this check compares. */
const START_READERS: Record<string, (ref: RefQuest, condition: RawRecord) => void> = {
  Level: (ref, c) => {
    ref.minPlayerLevel ??= asNumber(c.value);
  },
  Quest: (ref, c) => {
    const target = refId(c.target);
    if (!target) return;
    ref.prerequisites.push({
      target,
      statuses: prerequisiteStatuses(c.status),
      availableAfter: asNumber(c.availableAfter) ?? 0,
      dispersion: asNumber(c.dispersion) ?? 0,
    });
  },
  TraderLoyalty: (ref, c) => {
    const traderId = refId(c.target);
    const value = asNumber(c.value);
    if (!traderId || value === undefined) return;
    ref.loyalty.push({ traderId, compareMethod: asString(c.compareMethod) ?? '>=', value });
  },
  GlobalVariableValue: (ref, c) => {
    const variableId = refId(c.target);
    if (!variableId) return;
    ref.globalVariables.push({
      variableId,
      compareMethod: asString(c.compareMethod) ?? '==',
      value: asNumber(c.value) ?? Number.NaN,
    });
  },
};

/** One finish condition as an objective, with its English text when known. */
function readObjective(
  c: RawRecord,
  text: (key: string) => string | undefined
): RefObjective | undefined {
  const rawId = asString(c.id);
  const id = refId(rawId);
  const conditionType = asString(c.conditionType);
  if (!rawId || !id || !conditionType) return undefined;
  const props = isRecord(c.props) ? c.props : {};
  return {
    id,
    conditionType,
    text: text(id) ?? text(rawId),
    count: COUNTABLE_CONDITIONS.has(conditionType) ? asNumber(c.value) : undefined,
    parentId: refId(c.parentId) ?? refId(props.parentId),
  };
}

/** Readers for the success-reward types this check compares. */
const REWARD_READERS: Record<string, (ref: RefQuest, reward: RawRecord) => void> = {
  Experience: (ref, r) => {
    ref.experience ??= asNumber(r.value);
  },
  Item: (ref, r) => sumInto(ref.rewards.items, refId(records(r.items)[0]?._tpl), asNumber(r.value)),
  TraderStanding: (ref, r) => sumInto(ref.rewards.standing, refId(r.target), asNumber(r.value)),
  AssortmentUnlock: (ref, r) => {
    const tpl = refId(records(r.items)[0]?._tpl);
    if (tpl) ref.rewards.offerUnlocks.add(tpl);
  },
};

/** Map id for a quest `location`: `any` is no map, absent stays unknown. */
function questMapId(location: string | undefined): string | null | undefined {
  if (location === undefined) return undefined;
  return location === 'any' ? null : location;
}

/** A reader for a raw type string, ignoring inherited keys such as `__proto__`. */
function ownReader<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Normalize one raw quest template into the fields this check compares. */
export function normalizeReferenceQuest(
  quest: RawRecord,
  locale: Record<string, unknown> = {}
): RefQuest | null {
  const rawId = asString(quest._id);
  const id = refId(rawId);
  if (!rawId || !id) return null;
  const text = questText(quest, locale);
  const conditions = isRecord(quest.conditions) ? quest.conditions : {};

  const ref: RefQuest = {
    id,
    name: text(`${id} name`) ?? text(`${rawId} name`),
    traderId: refId(quest.traderId),
    mapId: questMapId(asString(quest.location)),
    hidden: quest.notDisplayedQuest === true,
    prerequisites: [],
    loyalty: [],
    globalVariables: [],
    objectives: [],
    rewards: { items: new Map(), standing: new Map(), offerUnlocks: new Set() },
  };
  for (const c of records(conditions.AvailableForStart)) {
    ownReader(START_READERS, c.conditionType)?.(ref, c);
  }
  ref.objectives = records(conditions.AvailableForFinish)
    .map((c) => readObjective(c, text))
    .filter((objective): objective is RefObjective => objective !== undefined);
  const rewards = isRecord(quest.rewards) ? records(quest.rewards.Success) : [];
  for (const r of rewards) ownReader(REWARD_READERS, r.type)?.(ref, r);
  return ref;
}

// ---------------------------------------------------------------------------
// Overlay loading
// ---------------------------------------------------------------------------

const { srcDir } = getProjectPaths();

function loadOptionalJson5<T>(...segments: string[]): Record<string, T> {
  const file = join(srcDir, ...segments);
  return existsSync(file) ? loadJson5File<Record<string, T>>(file) : {};
}

/** Shared task additions, then mode additions (mode wins per key, as built). */
export function loadTaskAdditions(mode: GameMode): Map<string, TaskAddition> {
  const additions = [
    ...Object.values(loadOptionalJson5<TaskAddition>('additions', 'tasksAdd.json5')),
    ...Object.values(loadOptionalJson5<TaskAddition>('additions', 'modes', mode, 'tasksAdd.json5')),
  ].filter((addition) => isRecord(addition) && typeof addition.id === 'string');
  return new Map(additions.map((addition) => [addition.id, addition]));
}

/** Collect `chapterQuestId` / `sourceQuestId` strings anywhere in `value`. */
export function collectStoryQuestIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectStoryQuestIds(entry, ids);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const isQuestId = key === 'chapterQuestId' || key === 'sourceQuestId';
      if (isQuestId && typeof entry === 'string') ids.add(entry);
      else collectStoryQuestIds(entry, ids);
    }
  }
  return ids;
}

/** tarkov.dev preset id -> base item template, from the mode's items catalog. */
export function presetBaseItems(items: ReadonlyMap<string, RawRecord>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, item] of items) {
    const base = isRecord(item.properties) ? asString(item.properties.baseItem) : undefined;
    const isPreset = Array.isArray(item.types) && item.types.includes('preset');
    if (base && isPreset) out.set(id, base);
  }
  return out;
}

/** Patch upstream trader requirements by id; an empty override list clears them. */
function mergeTraderRequirements(
  upstream: TaskData['traderRequirements'],
  patch: NonNullable<TaskOverride['traderRequirements']>
): TaskData['traderRequirements'] {
  if (patch.length === 0) return [];
  const byId = new Map((upstream ?? []).map((requirement) => [requirement.id, requirement]));
  for (const requirement of patch) {
    byId.set(requirement.id, { ...byId.get(requirement.id), ...requirement } as typeof requirement);
  }
  return [...byId.values()];
}

/**
 * Apply a task override the way INTEGRATION.md documents it: top-level fields
 * replace, objectives patch by id, objectivesRemove drops upstream objectives,
 * objectivesAdd appends, and traderRequirements patch by id (an empty array
 * clears).
 */
export function applyTaskOverride(task: TaskData, override: TaskOverride | undefined): TaskData {
  if (!override) return task;
  const {
    objectives: patches,
    objectivesAdd,
    objectivesRemove,
    traderRequirements,
    ...fields
  } = override;
  const removed = new Set(objectivesRemove ?? []);
  const objectives = (task.objectives ?? [])
    .filter((objective) => !removed.has(objective.id))
    .map((objective) => ({ ...objective, ...patches?.[objective.id] }));
  const merged: TaskData = {
    ...task,
    ...(fields as Partial<TaskData>),
    objectives: [...objectives, ...((objectivesAdd ?? []) as TaskObjective[])],
  };
  if (traderRequirements !== undefined) {
    merged.traderRequirements = mergeTraderRequirements(
      task.traderRequirements,
      traderRequirements
    );
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type Coverage = 'upstream' | 'addition' | 'placeholder' | 'story' | 'hidden' | 'missing';
export type Severity = 'error' | 'warning' | 'info';

export interface CoverageRow {
  taskId: string;
  taskName: string;
  coverage: Coverage;
  /** Overlay key the comparison ran against (addition / placeholder id). */
  overlayId?: string;
  field: string;
  reference: string;
  effective: string;
  severity: Severity;
  /** Where the effective value comes from. */
  source: 'api' | 'override' | 'addition' | 'none';
  note?: string;
}

export interface PlaceholderMapping {
  placeholderId: string;
  realId: string;
  name: string;
  objectives: Array<{ placeholderObjectiveId?: string; realObjectiveId?: string; text?: string }>;
}

export interface CoverageReport {
  quests: Array<{ id: string; name: string; coverage: Coverage; overlayId?: string }>;
  rows: CoverageRow[];
  placeholders: PlaceholderMapping[];
}

/** Lowercase alphanumeric words, used to compare names and objective text. */
export function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/^\s*\[[^\]]*\]\s*/, '') // "[KORD BREACH] Name" -> "Name"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Word-overlap similarity (Jaccard) for matching placeholder objectives by text. */
function textSimilarity(a: string | undefined, b: string | undefined): number {
  const left = new Set(normalizeText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Display form of a compared value. */
function show(value: unknown): string {
  if (value === undefined) return '(none)';
  if (value === null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const traderName = (id: string | undefined): string =>
  id ? `${TARKOV_TRADER_NAMES_BY_ID[id] ?? '?'} (${id})` : '(none)';

function mapName(id: string | null | undefined): string {
  if (id === undefined) return '(none)';
  if (id === null) return 'any';
  return `${TARKOV_MAP_NAMES_BY_ID[id] ?? '?'} (${id})`;
}

interface Target {
  coverage: Coverage;
  overlayId?: string;
  task: TaskData | TaskAddition;
  /** Fields whose effective value an override supplies. */
  overridden: Set<string>;
  /** Upstream task before overrides, to explain values an override replaced. */
  upstream?: TaskData;
  placeholderObjectiveIds?: Map<string, string>;
}

interface Context {
  apiIds: ReadonlySet<string>;
  additionIds: ReadonlySet<string>;
  storyIds: ReadonlySet<string>;
  /** placeholder id -> real id discovered in this reference */
  placeholderToReal: ReadonlyMap<string, string>;
  /** tarkov.dev weapon preset id -> base item template (the client rewards the base). */
  presetBase: ReadonlyMap<string, string>;
}

/** Adds one coverage row for the quest being compared. */
type Push = (
  field: string,
  reference: unknown,
  effective: unknown,
  severity: Severity,
  sourceField?: string,
  note?: string
) => void;

/** Match placeholder objectives to reference conditions by text (best pair first). */
function matchObjectives(
  ref: RefQuest,
  objectives: Array<{ id: string; description?: string }>
): Map<string, string> {
  const pairs = ref.objectives
    .flatMap((real) =>
      objectives.map((objective) => ({
        realId: real.id,
        placeholderId: objective.id,
        score: textSimilarity(real.text, objective.description),
      }))
    )
    .filter((pair) => pair.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const realToPlaceholder = new Map<string, string>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (realToPlaceholder.has(pair.realId) || used.has(pair.placeholderId)) continue;
    realToPlaceholder.set(pair.realId, pair.placeholderId);
    used.add(pair.placeholderId);
  }
  return realToPlaceholder;
}

/** Name, trader and map. */
function compareIdentity(ref: RefQuest, task: Target['task'], push: Push): void {
  if (ref.name && normalizeText(ref.name) !== normalizeText(task.name)) {
    push('name', ref.name, task.name, 'warning');
  }
  if (ref.traderId && ref.traderId !== task.trader?.id) {
    push('trader', traderName(ref.traderId), traderName(task.trader?.id), 'error');
  }
  compareMap(ref, task, push);
}

/** The quest location against the effective task map (`any` is no map). */
function compareMap(ref: RefQuest, task: Target['task'], push: Push): void {
  if (ref.mapId === undefined) return;
  const effectiveMap = task.map === undefined ? undefined : (task.map?.id ?? null);
  if (effectiveMap !== ref.mapId) push('map', mapName(ref.mapId), mapName(effectiveMap), 'warning');
}

/** Experience and the explicit Level gate. */
function compareNumbers(ref: RefQuest, task: Target['task'], push: Push): void {
  if (ref.experience !== undefined && ref.experience !== task.experience) {
    push('experience', ref.experience, task.experience, 'error');
  }
  if (ref.minPlayerLevel !== undefined && ref.minPlayerLevel !== (task.minPlayerLevel ?? 0)) {
    push('minPlayerLevel', ref.minPlayerLevel, task.minPlayerLevel, 'error');
  }
}

/** Effective prerequisite targets (placeholders mapped to real ids) and their statuses. */
function effectiveRequirementMap(task: Target['task'], ctx: Context): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const requirement of task.taskRequirements ?? []) {
    const raw = requirement?.task?.id;
    if (!raw) continue;
    const statuses = (requirement.status ?? ['complete']).map((s) => normalizeTaskStatus(s) ?? s);
    out.set(ctx.placeholderToReal.get(raw) ?? raw, [...new Set(statuses)].sort());
  }
  return out;
}

/** One reference Quest gate against the effective requirements. */
function comparePrerequisite(
  prerequisite: RefPrerequisite,
  effective: Map<string, string[]>,
  grouped: boolean,
  ctx: Context,
  push: Push
): void {
  const { target, statuses } = prerequisite;
  const label = `taskRequirements[${target}]`;
  if (!ctx.apiIds.has(target) && !ctx.additionIds.has(target)) {
    const why = ctx.storyIds.has(target)
      ? 'story quest (storyChapters), not a task'
      : 'task absent from tarkov.dev and the overlay';
    push(
      label,
      show(statuses),
      '(not representable)',
      'info',
      'taskRequirements',
      `${why}; do not add a dangling edge`
    );
    return;
  }
  const actual = effective.get(target);
  if (!actual) {
    const note = grouped ? 'task uses taskRequirementGroups; check the OR groups' : undefined;
    push(label, show(statuses), '(none)', grouped ? 'warning' : 'error', 'taskRequirements', note);
  } else if (statuses && show(statuses) !== show(actual)) {
    push(`${label}.status`, statuses, actual, 'warning', 'taskRequirements');
  }
}

/** The availability delay a Quest gate carries. */
function compareDelay(prerequisite: RefPrerequisite, task: Target['task'], push: Push): void {
  if (prerequisite.availableAfter <= 0 && prerequisite.dispersion <= 0) return;
  const min = prerequisite.availableAfter;
  const max = prerequisite.availableAfter + prerequisite.dispersion;
  if (task.availableDelaySecondsMin === min && task.availableDelaySecondsMax === max) return;
  push(
    'availableDelaySeconds',
    `${min}-${max}`,
    `${show(task.availableDelaySecondsMin)}-${show(task.availableDelaySecondsMax)}`,
    'warning',
    'availableDelaySecondsMin'
  );
}

/** Quest prerequisites (AND gates with accepted statuses) in both directions. */
function comparePrerequisites(ref: RefQuest, task: Target['task'], ctx: Context, push: Push): void {
  const effective = effectiveRequirementMap(task, ctx);
  const grouped = (task.taskRequirementGroups?.length ?? 0) > 0;
  for (const prerequisite of ref.prerequisites) {
    comparePrerequisite(prerequisite, effective, grouped, ctx, push);
    compareDelay(prerequisite, task, push);
  }
  const referenceTargets = new Set(ref.prerequisites.map((p) => p.target));
  for (const [id, statuses] of effective) {
    if (referenceTargets.has(id)) continue;
    push(
      `taskRequirements[${id}]`,
      '(none)',
      statuses,
      'warning',
      'taskRequirements',
      'not a Quest start condition in the reference'
    );
  }
}

/** Explicit loyalty gates (absence in the reference is not evidence). */
function compareLoyalty(ref: RefQuest, task: Target['task'], push: Push): void {
  for (const gate of ref.loyalty) {
    const match = (task.traderRequirements ?? []).find(
      (r) => r?.trader?.id === gate.traderId && r.requirementType === 'level'
    );
    if (match && match.value === gate.value && match.compareMethod === gate.compareMethod) continue;
    push(
      `traderRequirements[${TARKOV_TRADER_NAMES_BY_ID[gate.traderId] ?? gate.traderId}]`,
      `LL${gate.compareMethod}${gate.value}`,
      match ? `LL${match.compareMethod}${match.value}` : '(none)',
      'error',
      'traderRequirements'
    );
  }
}

/**
 * GlobalVariableValue start gates. Upstream and the overlay may represent a
 * story/dialogue variable as a dialogue or storyObjective requirement instead.
 */
function compareGlobalVariables(ref: RefQuest, task: Target['task'], push: Push): void {
  const requirements = task.otherRequirements ?? [];
  const alternatives = requirements
    .filter((r) => r?.type && r.type !== 'globalVariable')
    .map((r) => `${r.type} ${r.id}`);
  for (const gate of ref.globalVariables) {
    const match = requirements.find(
      (r) =>
        r?.type === 'globalVariable' &&
        (r as { variableId?: string }).variableId === gate.variableId
    ) as { compareMethod?: string; value?: number } | undefined;
    if (match?.value === gate.value && match?.compareMethod === gate.compareMethod) continue;
    const field = `otherRequirements[globalVariable ${gate.variableId}]`;
    const expected = `${gate.compareMethod} ${gate.value}`;
    if (match)
      push(
        field,
        expected,
        `${match.compareMethod} ${match.value}`,
        'warning',
        'otherRequirements'
      );
    else if (alternatives.length > 0)
      push(
        field,
        expected,
        alternatives.join(', '),
        'info',
        'otherRequirements',
        'effective gate uses another requirement type; confirm it represents this variable'
      );
    else push(field, expected, '(none)', 'warning', 'otherRequirements');
  }
}

type EffectiveObjective = TaskObjective & { description?: string };

/** Count and text of one matched objective. */
/** Count of one matched objective; a count of 1 is implicit when tarkov.dev serves none. */
function compareObjectiveCount(
  objective: RefObjective,
  effective: EffectiveObjective,
  push: Push
): void {
  const label = `objective[${objective.id}].count`;
  const field = `objectives.${effective.id}`;
  if (typeof effective.count !== 'number') {
    if ((objective.count ?? 0) > 1) {
      push(
        label,
        objective.count,
        effective.count,
        'warning',
        field,
        'effective objective has no count'
      );
    }
  } else if (objective.count !== undefined && effective.count !== objective.count) {
    push(label, objective.count, effective.count, 'error', field);
  }
}

/** Text of one matched objective (info: tarkov.dev rephrases objectives). */
function compareObjectiveText(
  objective: RefObjective,
  effective: EffectiveObjective,
  push: Push
): void {
  if (!objective.text || !effective.description) return;
  if (normalizeText(objective.text) === normalizeText(effective.description)) return;
  push(
    `objective[${objective.id}].description`,
    objective.text,
    effective.description,
    'info',
    `objectives.${effective.id}`
  );
}

/** The effective objective a reference objective maps to (placeholders map by text). */
function effectiveObjectiveFor(
  objective: RefObjective,
  target: Target,
  byId: Map<string, EffectiveObjective>
): EffectiveObjective | undefined {
  const localId = target.placeholderObjectiveIds
    ? target.placeholderObjectiveIds.get(objective.id)
    : objective.id;
  return localId ? byId.get(localId) : undefined;
}

/** Objective presence, counts and text, in both directions. */
function compareObjectives(ref: RefQuest, target: Target, push: Push): void {
  const objectives = (target.task.objectives ?? []) as EffectiveObjective[];
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const matched = new Set<string>();
  for (const objective of ref.objectives) {
    const effective = effectiveObjectiveFor(objective, target, byId);
    if (!effective) {
      const note = objective.parentId
        ? `sub-condition of ${objective.parentId}`
        : objective.conditionType;
      push(
        `objective[${objective.id}]`,
        objective.text ?? objective.conditionType,
        '(missing)',
        'error',
        'objectives',
        note
      );
      continue;
    }
    matched.add(effective.id);
    compareObjectiveCount(objective, effective, push);
    compareObjectiveText(objective, effective, push);
  }
  for (const objective of objectives.filter((o) => !matched.has(o.id))) {
    push(
      `objective[${objective.id}]`,
      '(not in reference)',
      objective.description,
      'warning',
      'objectives'
    );
  }
}

/** Shared state for the reward comparisons of one quest. */
interface RewardContext {
  rewards: TaskRewards;
  upstream: TaskRewards;
  replaced: boolean;
  baseOf: (id: string | undefined) => string | undefined;
}

/** Note for a reward field that a whole-object finishRewards override drops. */
function droppedRewardNote(
  rc: RewardContext,
  key: keyof TaskRewards,
  upstreamHas = ((rc.upstream[key] as unknown[] | undefined) ?? []).length > 0
): string | undefined {
  return rc.replaced && rc.rewards[key] === undefined && upstreamHas
    ? `the finishRewards override omits ${key}, so the documented top-level merge drops upstream's value`
    : undefined;
}

/** Sum reward item counts by base item template. */
function itemCounts(rc: RewardContext, rewards: TaskRewards): Map<string, number> {
  const out = new Map<string, number>();
  for (const reward of rewards.items ?? [])
    sumInto(out, rc.baseOf(reward?.item?.id), reward?.count);
  return out;
}

/** Why an overridden item reward differs: upstream already matched, or the override dropped it. */
function itemRewardNote(
  rc: RewardContext,
  upstream: Map<string, number>,
  tpl: string,
  expected: number | undefined
): string | undefined {
  if (!rc.replaced) return undefined;
  if (upstream.has(tpl) && upstream.get(tpl) === expected) {
    return `tarkov.dev serves ${expected}, matching the reference; the override changes it`;
  }
  return droppedRewardNote(rc, 'items', upstream.has(tpl));
}

function compareItemRewards(ref: RefQuest, rc: RewardContext, push: Push): void {
  const items = itemCounts(rc, rc.rewards);
  const upstream = itemCounts(rc, rc.upstream);
  for (const tpl of new Set([...ref.rewards.items.keys(), ...items.keys()])) {
    const expected = ref.rewards.items.get(tpl);
    if (expected === items.get(tpl)) continue;
    push(
      `finishRewards.items[${tpl}]`,
      expected,
      items.get(tpl),
      'warning',
      'finishRewards',
      itemRewardNote(rc, upstream, tpl, expected)
    );
  }
}

/** Standing rewards differ unless both sides give the same amount (float tolerance). */
const standingDiffers = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined || b === undefined || Math.abs(a - b) > 1e-6;

function compareStandingRewards(ref: RefQuest, rc: RewardContext, push: Push): void {
  const standing = new Map<string, number>();
  for (const reward of rc.rewards.traderStanding ?? []) {
    sumInto(standing, reward?.trader?.id, reward?.standing);
  }
  for (const trader of new Set([...ref.rewards.standing.keys(), ...standing.keys()])) {
    const expected = ref.rewards.standing.get(trader);
    if (!standingDiffers(expected, standing.get(trader))) continue;
    push(
      `finishRewards.traderStanding[${TARKOV_TRADER_NAMES_BY_ID[trader] ?? trader}]`,
      expected,
      standing.get(trader),
      'warning',
      'finishRewards',
      droppedRewardNote(rc, 'traderStanding')
    );
  }
}

function compareOfferRewards(ref: RefQuest, rc: RewardContext, push: Push): void {
  const offers = new Set(
    (rc.rewards.offerUnlock ?? []).map((o) => rc.baseOf(o?.item?.id)).filter(Boolean) as string[]
  );
  const label = (has: boolean) => (has ? 'unlock' : '(none)');
  for (const tpl of new Set([...ref.rewards.offerUnlocks, ...offers])) {
    if (ref.rewards.offerUnlocks.has(tpl) === offers.has(tpl)) continue;
    push(
      `finishRewards.offerUnlock[${tpl}]`,
      label(ref.rewards.offerUnlocks.has(tpl)),
      label(offers.has(tpl)),
      'warning',
      'finishRewards',
      droppedRewardNote(rc, 'offerUnlock')
    );
  }
}

/** Finish rewards (tarkov.dev serves weapon presets; the client rewards the base). */
function compareRewards(ref: RefQuest, target: Target, ctx: Context, push: Push): void {
  const rc: RewardContext = {
    rewards: (target.task.finishRewards ?? {}) as TaskRewards,
    upstream: (target.upstream?.finishRewards ?? {}) as TaskRewards,
    replaced: target.overridden.has('finishRewards'),
    baseOf: (id) => (id === undefined ? undefined : (ctx.presetBase.get(id) ?? id)),
  };
  compareItemRewards(ref, rc, push);
  compareStandingRewards(ref, rc, push);
  compareOfferRewards(ref, rc, push);
}

/** Every comparable field of one reference quest against its effective task. */
export function compareTask(ref: RefQuest, target: Target, ctx: Context): CoverageRow[] {
  const rows: CoverageRow[] = [];
  const sourceOf = (field: string): CoverageRow['source'] => {
    if (target.coverage !== 'upstream') return 'addition';
    return target.overridden.has(field) ? 'override' : 'api';
  };
  const push: Push = (field, reference, effective, severity, sourceField = field, note) => {
    rows.push({
      taskId: ref.id,
      taskName: ref.name ?? target.task.name,
      coverage: target.coverage,
      overlayId: target.overlayId,
      field,
      reference: show(reference),
      effective: show(effective),
      severity,
      source: sourceOf(sourceField),
      note,
    });
  };
  compareIdentity(ref, target.task, push);
  compareNumbers(ref, target.task, push);
  comparePrerequisites(ref, target.task, ctx, push);
  compareLoyalty(ref, target.task, push);
  compareGlobalVariables(ref, target.task, push);
  compareObjectives(ref, target, push);
  compareRewards(ref, target, ctx, push);
  return rows;
}

/** Placeholder additions matched to reference quests tarkov.dev and real additions lack. */
function matchPlaceholders(
  refQuests: RefQuest[],
  apiIds: ReadonlySet<string>,
  additions: Map<string, TaskAddition>
): Map<string, TaskAddition> {
  const placeholders = [...additions.values()].filter((a) => a.id.startsWith('placeholder_'));
  const out = new Map<string, TaskAddition>();
  for (const ref of refQuests) {
    if (apiIds.has(ref.id) || additions.has(ref.id) || !ref.name) continue;
    const match = placeholders.find(
      (p) =>
        normalizeText(p.name) === normalizeText(ref.name) &&
        (!ref.traderId || p.trader?.id === ref.traderId)
    );
    if (match) out.set(ref.id, match);
  }
  return out;
}

/** An upstream task with its effective overrides applied. */
function upstreamTarget(api: TaskData, override: TaskOverride | undefined): Target {
  return {
    coverage: 'upstream',
    task: applyTaskOverride(api, override),
    upstream: api,
    overridden: new Set([
      ...Object.keys(override ?? {}),
      ...Object.keys(override?.objectives ?? {}).map((id) => `objectives.${id}`),
    ]),
  };
}

/** The placeholder -> real mapping for #507, objectives matched by text. */
function placeholderMapping(
  ref: RefQuest,
  placeholder: TaskAddition,
  objectiveMap: Map<string, string>
): PlaceholderMapping {
  const descriptions = new Map((placeholder.objectives ?? []).map((o) => [o.id, o.description]));
  const mapped = new Set(objectiveMap.values());
  return {
    placeholderId: placeholder.id,
    realId: ref.id,
    name: ref.name ?? placeholder.name,
    objectives: [
      ...ref.objectives.map((o) => ({
        placeholderObjectiveId: objectiveMap.get(o.id),
        realObjectiveId: o.id,
        text: o.text ?? descriptions.get(objectiveMap.get(o.id) ?? ''),
      })),
      ...(placeholder.objectives ?? [])
        .filter((o) => !mapped.has(o.id))
        .map((o) => ({ placeholderObjectiveId: o.id, text: o.description })),
    ],
  };
}

/** The error row for a visible quest nothing represents. */
function missingRow(ref: RefQuest): CoverageRow {
  const facts = [
    traderName(ref.traderId),
    mapName(ref.mapId),
    ref.experience === undefined ? undefined : `${ref.experience} XP`,
    `${ref.objectives.length} objectives`,
  ];
  return {
    taskId: ref.id,
    taskName: ref.name ?? '(unnamed)',
    coverage: 'missing',
    field: 'task',
    reference: facts.filter(Boolean).join(', '),
    effective: '(missing)',
    severity: 'error',
    source: 'none',
    note: 'not served by tarkov.dev and no overlay addition or placeholder matches it',
  };
}

function disabledRow(ref: RefQuest, api: TaskData): CoverageRow {
  return {
    taskId: ref.id,
    taskName: ref.name ?? api.name,
    coverage: 'upstream',
    field: 'disabled',
    reference: 'present in reference',
    effective: 'disabled by override',
    severity: 'warning',
    source: 'override',
    note: 'the client still serves this quest',
  };
}

interface CoverageInputs {
  apiById: Map<string, TaskData>;
  overrides: Record<string, TaskOverride>;
  additions: Map<string, TaskAddition>;
  placeholderFor: Map<string, TaskAddition>;
}

/** What one reference quest is compared against, recording side outputs in `report`. */
function resolveTarget(
  ref: RefQuest,
  inputs: CoverageInputs,
  report: CoverageReport
): Target | undefined {
  const api = inputs.apiById.get(ref.id);
  if (api) {
    if (inputs.overrides[ref.id]?.disabled === true) report.rows.push(disabledRow(ref, api));
    return upstreamTarget(api, inputs.overrides[ref.id]);
  }
  const addition = inputs.additions.get(ref.id);
  if (addition) {
    return { coverage: 'addition', overlayId: addition.id, task: addition, overridden: new Set() };
  }
  const placeholder = inputs.placeholderFor.get(ref.id);
  if (!placeholder) return undefined;
  const objectiveMap = matchObjectives(ref, placeholder.objectives ?? []);
  report.placeholders.push(placeholderMapping(ref, placeholder, objectiveMap));
  return {
    coverage: 'placeholder',
    overlayId: placeholder.id,
    task: placeholder,
    overridden: new Set(),
    placeholderObjectiveIds: objectiveMap,
  };
}

function uncoveredKind(ref: RefQuest, storyIds: ReadonlySet<string>): Coverage {
  if (storyIds.has(ref.id)) return 'story';
  return ref.hidden ? 'hidden' : 'missing';
}

/** Classify and compare every reference quest against what consumers see. */
export function buildCoverage(
  refQuests: RefQuest[],
  apiTasks: TaskData[],
  overrides: Record<string, TaskOverride>,
  additions: Map<string, TaskAddition>,
  storyIds: Set<string>,
  presetBase: ReadonlyMap<string, string> = new Map()
): CoverageReport {
  const apiById = new Map(apiTasks.map((task) => [task.id, task]));
  const placeholderFor = matchPlaceholders(refQuests, new Set(apiById.keys()), additions);
  const ctx: Context = {
    apiIds: new Set(apiById.keys()),
    // A real id backed by a placeholder addition is representable (via the placeholder).
    additionIds: new Set([...additions.keys(), ...placeholderFor.keys()]),
    storyIds,
    placeholderToReal: new Map([...placeholderFor].map(([real, p]) => [p.id, real])),
    presetBase,
  };
  const inputs: CoverageInputs = { apiById, overrides, additions, placeholderFor };
  const report: CoverageReport = { quests: [], rows: [], placeholders: [] };
  for (const ref of refQuests) {
    const target = resolveTarget(ref, inputs, report);
    const coverage = target?.coverage ?? uncoveredKind(ref, storyIds);
    report.quests.push({
      id: ref.id,
      name: ref.name ?? target?.task.name ?? '(unnamed)',
      coverage,
      overlayId: target?.overlayId,
    });
    if (target) report.rows.push(...compareTask(ref, target, ctx));
    else if (coverage === 'missing') report.rows.push(missingRow(ref));
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SEVERITY_META: Record<Severity, { icon: string; color: string }> = {
  error: { icon: icons.error, color: colors.red },
  warning: { icon: icons.warning, color: colors.yellow },
  info: { icon: icons.info, color: colors.cyan },
};
const COVERAGE_ORDER: Coverage[] = [
  'missing',
  'placeholder',
  'addition',
  'upstream',
  'story',
  'hidden',
];

function printRow(row: CoverageRow): void {
  const meta = SEVERITY_META[row.severity];
  console.log(
    `    ${meta.icon} ${row.field} ${dim(`[${row.source}]`)}\n` +
      `       reference: ${colors.green}${row.reference}${colors.reset}  ` +
      `effective: ${meta.color}${row.effective}${colors.reset}` +
      (row.note ? `\n       ${dim(row.note)}` : '')
  );
}

/** Rows of one coverage category, grouped by quest. */
function printTaskRows(rows: CoverageRow[]): void {
  const byTask = new Map<string, CoverageRow[]>();
  for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  for (const [taskId, taskRows] of byTask) {
    const first = taskRows[0];
    const overlay = first.overlayId ? ` -> ${first.overlayId}` : '';
    console.log(`  ${bold(first.taskName)} ${dim(`(${taskId}${overlay})`)}`);
    taskRows.forEach(printRow);
  }
}

function printCoverageSection(coverage: Coverage, report: CoverageReport, showInfo: boolean): void {
  const quests = report.quests.filter((q) => q.coverage === coverage);
  if (quests.length === 0) return;
  const rows = report.rows.filter(
    (r) => r.coverage === coverage && (showInfo || r.severity !== 'info')
  );
  console.log(bold(`\n${coverage} (${quests.length} quests, ${rows.length} rows)`));
  if (coverage === 'story' || coverage === 'hidden') {
    console.log(dim(`  ${quests.map((q) => q.id).join(', ')}`));
  } else {
    printTaskRows(rows);
  }
}

function printPlaceholders(placeholders: PlaceholderMapping[]): void {
  if (placeholders.length === 0) return;
  printHeader('PLACEHOLDER -> REAL ID (issue #507)');
  for (const mapping of placeholders) {
    console.log(
      `  ${bold(mapping.name)}: ${mapping.placeholderId} -> ${colors.green}${mapping.realId}${colors.reset}`
    );
    for (const objective of mapping.objectives) {
      const local = objective.placeholderObjectiveId ?? dim('(no placeholder objective)');
      const real = objective.realObjectiveId ?? dim('(not in reference)');
      console.log(`    ${local} -> ${real}  ${dim(objective.text ?? '')}`);
    }
  }
}

function printSummary(report: CoverageReport, showInfo: boolean): void {
  printHeader('SUMMARY');
  for (const coverage of COVERAGE_ORDER) {
    const count = report.quests.filter((q) => q.coverage === coverage).length;
    if (count > 0) console.log(`  ${coverage.padEnd(12)} ${bold(String(count))}`);
  }
  const count = (severity: Severity) =>
    bold(String(report.rows.filter((r) => r.severity === severity).length));
  console.log(
    `\n  errors: ${count('error')}  warnings: ${count('warning')}  info: ${count('info')}` +
      (showInfo ? '' : dim(' (--all to show)'))
  );
  console.log();
}

export function printReport(report: CoverageReport, showInfo: boolean): void {
  printHeader('QUEST COVERAGE (reference -> tarkov.dev + overlay)');
  for (const coverage of COVERAGE_ORDER) printCoverageSection(coverage, report, showInfo);
  printPlaceholders(report.placeholders);
  printSummary(report, showInfo);
}

async function main(): Promise<void> {
  try {
    const opts = parseModeArgs(process.argv.slice(2), ['--all']);
    const referenceFile = findReferenceFile(opts.eftDir, opts.mode);
    requireMatchingReferenceMode(opts.eftDir, opts.mode);
    const locale = loadSiblingLocale(referenceFile);
    const refQuests = (readQuestArray(referenceFile) as unknown as RawRecord[])
      .map((quest) => normalizeReferenceQuest(quest, locale))
      .filter((quest): quest is RefQuest => quest !== null);
    printSuccess(
      `Loaded ${refQuests.length} quests from ${relative(process.cwd(), referenceFile)} ` +
        `(${referenceAppVersion(referenceFile) ?? 'unknown client version'})`
    );

    printProgress(`Fetching ${opts.mode} tasks and items from tarkov.dev...`);
    const [apiTasks, items] = await Promise.all([
      fetchTasks(opts.mode),
      fetchRawEntities(opts.mode, 'items', 'items'),
    ]);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks`);

    const report = buildCoverage(
      refQuests,
      apiTasks,
      effectiveOverrides(opts.mode),
      loadTaskAdditions(opts.mode),
      collectStoryQuestIds(loadOptionalJson5('additions', 'storyChapters.json5')),
      presetBaseItems(items)
    );
    printReport(report, opts.flags.has('--all'));

    if (opts.jsonOut) {
      writeFileSync(opts.jsonOut, JSON.stringify(report, null, 2));
      printSuccess(`Wrote ${report.rows.length} coverage rows to ${opts.jsonOut}`);
    }
    process.exitCode = 0;
  } catch (error) {
    printError('Error during quest coverage check:', error as Error);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
