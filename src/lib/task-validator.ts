/**
 * Task validation logic
 *
 * Validates task overrides against tarkov.dev API data using a
 * configuration-driven approach for easier maintenance.
 */

import type {
  TaskOverride,
  TaskObjective,
  TaskData,
  ValidationResult,
  ValidationDetail,
  ValidationStatus,
} from './types.js';
import {
  comparisonTask,
  type ComparisonTaskData,
  type ComparisonValue,
} from './task-comparison.cjs';
import { compareOverlayFields, type OverlayComparisonDetail } from './overlay-comparison.cjs';
import { compareSubset, formatValue, type CompareOptions } from './value-compare.js';
import { normalizeTaskStatus } from './task-unlocks.js';
import { validObjectiveCollection } from './tarkov-api-shared.cjs';
import { compareRequirementValues } from './requirement-comparison.js';

/** Field validator function signature */
type FieldValidator = (
  override: TaskOverride,
  apiTask: ComparisonTaskData
) => ValidationDetail | null;

type ObjectiveLike = { maps?: Array<{ id?: string; name?: string }> };

const MAP_NAME_ALIASES: Record<string, string> = {
  'night factory': 'Factory',
  'ground zero 21+': 'Ground Zero',
};

/** Return the comparison key for a map, including known display-name aliases. */
function canonicalMapKey(map?: { id?: string; name?: string }): string | undefined {
  if (!map) return undefined;
  const name = map.name?.trim();
  if (name) {
    const alias = MAP_NAME_ALIASES[name.toLowerCase()];
    return alias ?? name;
  }
  return map.id;
}

/** Collect all map keys referenced by a set of task objectives. */
function collectObjectiveMapKeys(objectives: ObjectiveLike[]): Set<string> {
  const mapKeys = new Set<string>();
  for (const objective of objectives) {
    for (const map of objective.maps ?? []) {
      const key = canonicalMapKey(map);
      if (key) mapKeys.add(key);
    }
  }
  return mapKeys;
}

/** Determine whether a task spans more than one objective map. */
function comparableObjectives(apiTask: ComparisonTaskData): ObjectiveLike[] {
  return (
    validObjectiveCollection(apiTask.objectives) ? apiTask.objectives : []
  ) as ObjectiveLike[];
}

function hasMultipleObjectiveMaps(override: TaskOverride, apiTask: ComparisonTaskData): boolean {
  const apiObjectives = comparableObjectives(apiTask);
  const overrideObjectives = Object.values(override.objectives ?? {}) as ObjectiveLike[];
  const mapKeys = new Set<string>();

  for (const key of collectObjectiveMapKeys(apiObjectives)) mapKeys.add(key);
  for (const key of collectObjectiveMapKeys(overrideObjectives)) mapKeys.add(key);

  return mapKeys.size > 1;
}

/** Create a simple field comparison validator. */
function fieldComparisonResult(
  field: string,
  overrideValue: unknown,
  apiValue: unknown,
  compareOptions?: CompareOptions
): ValidationDetail {
  const isMatch = compareSubset(overrideValue, apiValue, compareOptions);
  return {
    field,
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? `${field}: ${formatValue(apiValue)} - FIXED IN API`
      : `${field}: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
  };
}

function createFieldValidator<K extends keyof TaskOverride & keyof TaskData>(
  field: K,
  compareOptions?: CompareOptions
): FieldValidator {
  return (override, apiTask) => {
    const overrideValue = override[field];
    if (overrideValue === undefined) return null;

    const apiValue = apiTask[field];
    if (apiValue === undefined)
      return {
        field,
        status: 'check',
        message: `${field}: upstream value unavailable - UNVERIFIED`,
      };
    return fieldComparisonResult(field, overrideValue, apiValue, compareOptions);
  };
}

/** Validate an override for a task whose objectives span multiple maps. */
function validateMultiMapOverride(
  overrideValue: TaskOverride['map'],
  apiValue: ComparisonTaskData['map']
): ValidationDetail | null {
  if (overrideValue === undefined) {
    if (apiValue === null || apiValue === undefined) return null;
    return {
      field: 'map',
      status: 'needed',
      message: `map: task has multiple objective maps; add map: null to clear top-level map (API=${formatValue(
        apiValue
      )}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  if (overrideValue !== null) {
    return {
      field: 'map',
      status: 'needed',
      message: `map: task has multiple objective maps; override should be null (API=${formatValue(
        apiValue
      )}, Override=${formatValue(overrideValue)}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  const isMatch = compareSubset(overrideValue, apiValue);
  return {
    field: 'map',
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? 'map: null - FIXED IN API'
      : `map: API=${formatValue(apiValue)}, Override=null - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
  };
}

/** Validate an ordinary single-map override. */
function validateSingleMapOverride(
  overrideValue: TaskOverride['map'],
  apiValue: ComparisonTaskData['map']
): ValidationDetail | null {
  if (overrideValue === undefined) return null;

  const isMatch = compareSubset(overrideValue, apiValue);
  return {
    field: 'map',
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? `map: ${formatValue(apiValue)} - FIXED IN API`
      : `map: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
  };
}

/** Validate map field with awareness of multi-map objectives. */
const validateMap: FieldValidator = (override, apiTask) =>
  hasMultipleObjectiveMaps(override, apiTask)
    ? validateMultiMapOverride(override.map, apiTask.map)
    : validateSingleMapOverride(override.map, apiTask.map);

type TraderRequirementLike = {
  id?: string;
  requirementType?: string;
  compareMethod?: string;
  value?: number;
  trader?: { id?: string; name?: string };
};

/**
 * Semantic identity of a trader requirement: everything a consumer uses to
 * evaluate it, excluding the `id` (which differs between upstream and
 * overlay-authored entries).
 */
function traderRequirementKey(req: TraderRequirementLike): string {
  return [req.trader?.id ?? '', req.requirementType ?? '', req.compareMethod ?? '', req.value].join(
    '|'
  );
}

/** Format a trader requirement for a validation diagnostic. */
function formatTraderRequirement(req: TraderRequirementLike): string {
  return `${req.trader?.name ?? req.trader?.id ?? '?'} ${req.requirementType} ${req.compareMethod} ${req.value}`;
}

interface RequirementMatches<T> {
  remaining: T[];
  unmatched: string[];
}

/** Match override requirements to API requirements by a semantic identity. */
function matchByKey<T>(
  overrideReqs: readonly T[],
  apiReqs: readonly T[],
  keyOf: (requirement: T) => string,
  formatOf: (requirement: T) => string
): RequirementMatches<T> {
  const remaining = [...apiReqs];
  const unmatched: string[] = [];

  for (const overrideReq of overrideReqs) {
    const key = keyOf(overrideReq);
    const index = remaining.findIndex((apiReq) => keyOf(apiReq) === key);
    if (index === -1) unmatched.push(formatOf(overrideReq));
    else remaining.splice(index, 1);
  }

  return { remaining, unmatched };
}

/** Remove duplicate entries while preserving the first occurrence of each key. */
function uniqueByKey<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Match trader requirements by the semantics consumed by the validator. */
function matchTraderRequirements(
  overrideReqs: readonly TraderRequirementLike[],
  apiReqs: readonly TraderRequirementLike[]
): RequirementMatches<TraderRequirementLike> {
  return matchByKey(overrideReqs, apiReqs, traderRequirementKey, formatTraderRequirement);
}

/**
 * Validate trader requirements by semantic identity.
 *
 * The `id` field is deliberately excluded from the comparison: overlay-authored
 * requirements carry a synthetic `overlay.*` id that will never match upstream,
 * and upstream-preserved ids are only merge identity, not semantics. Comparing
 * `trader.id + requirementType + compareMethod + value` keeps Fence LL1 and
 * Fence reputation `>= 1` distinguishable while treating an id-only difference
 * as "already fixed upstream".
 *
 * This holds even if an upstream entry ever arrives without an id: an override
 * cannot address an id-less upstream requirement, so keeping it would append a
 * duplicate under a patch-by-id merge. `fixed` ("remove it") stays the correct
 * verdict there.
 */
const validateTraderRequirements: FieldValidator = (override, apiTask) => {
  if (override.traderRequirements === undefined) return null;

  const apiReqs = apiTask.traderRequirements ?? [];
  const overrideReqs = override.traderRequirements;

  // An empty override array means "no requirements" and replaces upstream
  // entries; surface it as needed rather than letting a vacuous subset match
  // hide the fact that requirements are being cleared.
  if (overrideReqs.length === 0) {
    if (apiReqs.length === 0) return null;
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: API has ${apiReqs.length} requirement(s), Override=[] (clears all) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  if (apiReqs.length === 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  const { remaining, unmatched } = matchTraderRequirements(overrideReqs, apiReqs);

  if (unmatched.length > 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: ${unmatched.length} requirement(s) differ from API (${unmatched.join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  // A non-empty override remains a whole-array replacement for consumers that
  // have not migrated to patch-by-id. Matching only a strict subset therefore
  // intentionally clears the omitted API requirements and is still needed.
  if (remaining.length > 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: override omits ${remaining.length} API requirement(s) (${remaining.map(formatTraderRequirement).join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  return {
    field: 'traderRequirements',
    status: 'fixed',
    message: 'traderRequirements: FIXED IN API',
  };
};

type TaskRequirementLike = {
  task?: { id?: string; name?: string };
  status?: unknown;
} | null;

/** Normalize aliases while preserving distinct evaluator quest states. */
function normalizeTaskRequirementStatus(status: unknown): string {
  const normalized = typeof status === 'string' ? normalizeTaskStatus(status) : undefined;
  return normalized ?? `invalid:${typeof status}:${String(status)}`;
}

/** Build the semantic identity of one task prerequisite. */
function taskRequirementKey(requirement: TaskRequirementLike): string {
  if (!requirement || typeof requirement !== 'object') return 'malformed|taskRequirement';

  const taskId = requirement.task?.id ?? '';
  const statuses =
    requirement.status === undefined
      ? ['complete']
      : Array.isArray(requirement.status)
        ? [...new Set(requirement.status.map(normalizeTaskRequirementStatus))].sort()
        : ['invalid-status'];
  return `${taskId}|${statuses.join(',')}`;
}

type TaskRequirementGroupLike = readonly TaskRequirementLike[] | null;

/** Build a semantic identity for a group without display or provenance fields. */
function taskRequirementGroupKey(group: TaskRequirementGroupLike): string {
  if (!Array.isArray(group)) return 'malformed|taskRequirementGroup';
  return JSON.stringify([...new Set(group.map(taskRequirementKey))].sort());
}

/** Format a task-prerequisite group for a validation diagnostic. */
function formatTaskRequirementGroup(group: TaskRequirementGroupLike): string {
  if (!Array.isArray(group)) return 'malformed task requirement group';
  return `(${group.map(formatTaskRequirement).join(' OR ')})`;
}

/** Format a task prerequisite for a validation diagnostic. */
function formatTaskRequirement(requirement: TaskRequirementLike): string {
  if (!requirement || typeof requirement !== 'object') return 'malformed task requirement';
  const task = requirement.task?.name ?? requirement.task?.id ?? '?';
  const statuses = requirement.status === undefined ? 'complete' : formatValue(requirement.status);
  return `${task} [${statuses}]`;
}

/** Match task prerequisites by the semantics used by availability evaluation. */
function matchTaskRequirements(
  overrideReqs: readonly TaskRequirementLike[],
  apiReqs: readonly TaskRequirementLike[]
): RequirementMatches<TaskRequirementLike> {
  return matchByKey(overrideReqs, apiReqs, taskRequirementKey, formatTaskRequirement);
}

/** Match task-prerequisite groups by their task IDs and normalized statuses. */
function matchTaskRequirementGroups(
  overrideGroups: readonly TaskRequirementGroupLike[],
  apiGroups: readonly TaskRequirementGroupLike[]
): RequirementMatches<TaskRequirementGroupLike> {
  return matchByKey(overrideGroups, apiGroups, taskRequirementGroupKey, formatTaskRequirementGroup);
}

/** Validate task requirements without discarding active or accepted edges. */
const validateTaskRequirements: FieldValidator = (override, apiTask) => {
  if (override.taskRequirements === undefined) return null;

  const apiReqs = (apiTask.taskRequirements ?? []) as TaskRequirementLike[];
  const overrideReqs = override.taskRequirements as TaskRequirementLike[];

  if (overrideReqs.length === 0) {
    if (apiReqs.length === 0) return null;
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: API has ${apiReqs.length} requirement(s), Override=[] (clears all) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  if (apiReqs.length === 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  const { remaining, unmatched } = matchTaskRequirements(overrideReqs, apiReqs);
  if (unmatched.length > 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: ${unmatched.length} requirement(s) differ from API (${unmatched.join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  if (remaining.length > 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: override omits ${remaining.length} API requirement(s) (${remaining.map(formatTaskRequirement).join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  return {
    field: 'taskRequirements',
    status: 'fixed',
    message: 'taskRequirements: FIXED IN API',
  };
};

/** Validate task-prerequisite groups while preserving explicit array clearing. */
const validateTaskRequirementGroups: FieldValidator = (override, apiTask) => {
  if (override.taskRequirementGroups === undefined) return null;

  const apiGroups = (apiTask.taskRequirementGroups ?? []) as TaskRequirementGroupLike[];
  const overrideGroups = override.taskRequirementGroups as TaskRequirementGroupLike[];
  if (overrideGroups.length === 0) {
    if (apiGroups.length === 0) return null;
    return {
      field: 'taskRequirementGroups',
      status: 'needed',
      message: `taskRequirementGroups: API has ${apiGroups.length} group(s), Override=[] (clears all) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }

  const uniqueApiGroups = uniqueByKey(apiGroups, taskRequirementGroupKey);
  const uniqueOverrideGroups = uniqueByKey(overrideGroups, taskRequirementGroupKey);
  const { remaining, unmatched } = matchTaskRequirementGroups(
    uniqueOverrideGroups,
    uniqueApiGroups
  );
  if (unmatched.length > 0) {
    return {
      field: 'taskRequirementGroups',
      status: 'needed',
      message: `taskRequirementGroups: ${unmatched.length} group(s) differ from API (${unmatched.join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }
  if (remaining.length > 0) {
    return {
      field: 'taskRequirementGroups',
      status: 'needed',
      message: `taskRequirementGroups: override omits ${remaining.length} API group(s) (${remaining.map(formatTaskRequirementGroup).join('; ')}) - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    };
  }
  return {
    field: 'taskRequirementGroups',
    status: 'fixed',
    message: 'taskRequirementGroups: FIXED IN API',
  };
};

/** Disabled flags are comparable only when upstream explicitly exposes a boolean. */
const validateDisabled: FieldValidator = (override, apiTask) => {
  if (override.disabled === undefined) return null;
  if (typeof apiTask.disabled !== 'boolean') {
    return {
      field: 'disabled',
      status: 'check',
      message:
        'disabled: UNVERIFIED upstream flag unavailable; verify gameplay visibility or retain intentional mode guard',
    };
  }
  return createFieldValidator('disabled')(override, apiTask);
};

/** Every accepted field must have an explicit comparison path. */
const COMPARABLE_FIELDS = new Set([
  'disabled',
  'minPlayerLevel',
  'name',
  'wikiLink',
  'map',
  'experience',
  'startRewards',
  'finishRewards',
  'factionName',
  'requiredPrestige',
  'kappaRequired',
  'lightkeeperRequired',
  'otherRequirements',
  'neededKeys',
  'availableDelaySecondsMin',
  'availableDelaySecondsMax',
  'taskRequirementGroups',
  'taskRequirements',
  'traderRequirements',
  'objectives',
  'objectivesAdd',
  'objectivesRemove',
]);

/** Missing or malformed collections cannot establish that a clearing patch is redundant. */
function requirementRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validReference(value: unknown): boolean {
  const reference = requirementRecord(value);
  return typeof reference?.id === 'string' && reference.id.length > 0;
}

function validStates(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every((state) => typeof state === 'string' && normalizeTaskStatus(state) !== undefined)
  );
}

function validTaskRequirement(value: unknown): boolean {
  const requirement = requirementRecord(value);
  return Boolean(
    requirement && validReference(requirement.task) && validStates(requirement.status)
  );
}

function validTraderRequirement(value: unknown): boolean {
  const requirement = requirementRecord(value);
  if (!requirement || !validReference(requirement.trader)) return false;
  return typeof requirement.compareMethod === 'string' && typeof requirement.value === 'number';
}

function validRequirementGroup(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(validTaskRequirement);
}

function validRequirementArray(field: string, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (field === 'taskRequirementGroups') return value.every(validRequirementGroup);
  return value.every(
    field === 'traderRequirements' ? validTraderRequirement : validTaskRequirement
  );
}

function withRequirementCollection(
  field: 'taskRequirements' | 'taskRequirementGroups' | 'traderRequirements',
  validator: FieldValidator
): FieldValidator {
  return (override, apiTask) => {
    if (override[field] === undefined) return validator(override, apiTask);
    if (!validRequirementArray(field, apiTask[field])) {
      return {
        field,
        status: 'check',
        message: `${field}: upstream collection unavailable - UNVERIFIED`,
      };
    }
    if (!validRequirementArray(field, override[field]))
      return {
        field,
        status: 'check',
        message: `${field}: malformed overlay requirements - UNVERIFIED`,
      };
    return validator(override, apiTask);
  };
}

const FIELD_VALIDATORS: FieldValidator[] = [
  validateDisabled,
  createFieldValidator('minPlayerLevel'),
  createFieldValidator('name'),
  createFieldValidator('wikiLink'),
  validateMap,
  createFieldValidator('experience'),
  createFieldValidator('startRewards', { arrayMode: 'subset' }),
  createFieldValidator('finishRewards', { arrayMode: 'subset' }),
  createFieldValidator('factionName'),
  createFieldValidator('requiredPrestige'),
  createFieldValidator('kappaRequired'),
  createFieldValidator('lightkeeperRequired'),
  createFieldValidator('otherRequirements'),
  createFieldValidator('neededKeys'),
  createFieldValidator('availableDelaySecondsMin'),
  createFieldValidator('availableDelaySecondsMax'),
  withRequirementCollection('taskRequirementGroups', validateTaskRequirementGroups),
  withRequirementCollection('taskRequirements', validateTaskRequirements),
  withRequirementCollection('traderRequirements', validateTraderRequirements),
];

/** Compare one objective field without inventing unavailable upstream values. */
function objectiveFieldResult(
  objId: string,
  field: string,
  value: unknown,
  upstream: unknown
): ValidationDetail {
  const same = compareSubset(value, upstream);
  return {
    field: `objective:${objId}:${field}`,
    status: same ? 'fixed' : 'needed',
    message: same
      ? `objective ${field}: ${formatValue(upstream)} - FIXED IN API`
      : `objective ${field}: API=${formatValue(upstream)}, Override=${formatValue(value)} - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
  };
}

function objectiveField(
  objId: string,
  field: string,
  value: unknown,
  apiObj: Record<string, unknown>
): ValidationDetail[] {
  if (value === undefined) return [];
  const upstream = apiObj[field];
  if (upstream === undefined)
    return [
      {
        field: `objective:${objId}:${field}`,
        status: 'check',
        message: `objective ${objId}.${field}: upstream value unavailable - UNVERIFIED`,
      },
    ];
  return [objectiveFieldResult(objId, field, value, upstream)];
}

function objectivePatch(
  objId: string,
  patch: Record<string, unknown>,
  apiTask: ComparisonTaskData
): ValidationDetail[] {
  const apiObj = findApiObjective(apiTask, objId);
  if (!apiObj)
    return [
      {
        field: `objective:${objId}`,
        status: 'check',
        message: `objective ${objId}: Not found in API - CHECK MANUALLY`,
      },
    ];
  return Object.entries(patch).flatMap(([field, value]) =>
    objectiveField(objId, field, value, apiObj as unknown as Record<string, unknown>)
  );
}

/** Validate field-level corrections for objectives already known to the API. */
function validateObjectiveOverrides(
  override: TaskOverride,
  apiTask: ComparisonTaskData
): ValidationDetail[] {
  return Object.entries(override.objectives ?? {}).flatMap(([id, patch]) =>
    objectivePatch(id, patch as Record<string, unknown>, apiTask)
  );
}

/** Missing objective collections cannot provide an objective to compare. */
function findApiObjective(apiTask: ComparisonTaskData, id: string) {
  if (!validObjectiveCollection(apiTask.objectives)) return undefined;
  return apiTask.objectives.find((objective) => objective.id === id);
}

interface ObjectiveAdditionMatch {
  upstream?: ComparisonValue<TaskObjective>;
  adopted: boolean;
  available: boolean;
}

function objectiveAdditionMatch(
  added: Record<string, unknown>,
  task: ComparisonTaskData
): ObjectiveAdditionMatch {
  if (!validObjectiveCollection(task.objectives)) return { adopted: false, available: false };
  const idMatch = task.objectives.find((objective) => objective.id === added.id);
  if (idMatch) return { upstream: idMatch, adopted: true, available: true };
  const candidates = task.objectives.filter(
    (objective) =>
      typeof added.description === 'string' && objective.description === added.description
  );
  return {
    upstream: candidates.length === 1 ? candidates[0] : undefined,
    adopted: false,
    available: true,
  };
}

function objectiveAdditionPresence(
  added: Record<string, unknown>,
  field: string,
  adopted: boolean
): ValidationDetail {
  return {
    field,
    status: adopted ? 'fixed' : 'check',
    message: adopted
      ? `added objective '${added.description}': NOW IN API - MOVE TO OBJECTIVES OR REMOVE; values checked separately`
      : `added objective '${added.description}': description candidate only - CHECK ID AND VALUES MANUALLY`,
  };
}

function objectiveAdditionDetails(
  added: Record<string, unknown>,
  task: ComparisonTaskData
): ValidationDetail[] {
  const match = objectiveAdditionMatch(added, task);
  const field = `objectivesAdd:${String(added.id || added.description)}`;
  if (!match.available)
    return [
      {
        field,
        status: 'check',
        message: `added objective '${added.description}': UNVERIFIED upstream objectives unavailable`,
      },
    ];
  if (!match.upstream)
    return [
      {
        field,
        status: 'needed',
        message: `added objective '${added.description}': Still missing by ID; description matches do not establish identity - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
      },
    ];
  const presence = objectiveAdditionPresence(added, field, match.adopted);
  const statuses = {
    same: 'info',
    different: 'needed',
    unverified: 'check',
    invalid: 'check',
  } as const;
  const fields = compareOverlayFields(added, match.upstream).map((row) => ({
    field: `${field}:${row.field}`,
    status: statuses[row.status],
    message: `${row.field}: ${row.status.toUpperCase()} - ${row.reason}`,
  }));
  return [presence, ...fields];
}

/** Identity adoption is independent of whether all supplied objective values match. */
function validateObjectiveAdditions(
  override: TaskOverride,
  apiTask: ComparisonTaskData
): ValidationDetail[] {
  // A re-added removed ID is reported once, as a removal conflict.
  const removed = new Set(override.objectivesRemove ?? []);
  return (override.objectivesAdd ?? [])
    .filter((added) => !removed.has(added.id))
    .flatMap((added) =>
      objectiveAdditionDetails(added as unknown as Record<string, unknown>, apiTask)
    );
}

/**
 * Removing an objective while the same override (or layered shared + mode
 * override) also patches or re-adds it is contradictory: consumers would drop
 * the patch, or swap the upstream objective for the overlay's copy. A
 * replacement belongs in an `objectives` patch instead.
 */
export function objectiveRemovalConflicts(override: TaskOverride): ValidationDetail[] {
  const patched = new Set(Object.keys(override.objectives ?? {}));
  const added = new Set((override.objectivesAdd ?? []).map((objective) => objective.id));
  return (override.objectivesRemove ?? []).flatMap((id): ValidationDetail[] => {
    const reasons = [
      patched.has(id) ? 'patched under objectives' : undefined,
      added.has(id)
        ? 're-added under objectivesAdd (write a replacement as an objectives patch)'
        : undefined,
    ].filter(Boolean);
    return reasons.length
      ? [
          {
            field: `objectivesRemove:${id}:conflict`,
            status: 'check',
            message: `removed objective ${id}: also ${reasons.join(' and ')} - CHECK MANUALLY`,
          },
        ]
      : [];
  });
}

/**
 * A removal stays needed while upstream still serves the objective; once the ID
 * is gone upstream the entry is redundant. Patching an objective the same
 * override removes is contradictory and needs a manual decision.
 */
function validateObjectiveRemovals(
  override: TaskOverride,
  apiTask: ComparisonTaskData
): ValidationDetail[] {
  const presence = (override.objectivesRemove ?? []).map((id): ValidationDetail => {
    const field = `objectivesRemove:${id}`;
    if (!validObjectiveCollection(apiTask.objectives)) {
      return {
        field,
        status: 'check',
        message: `removed objective ${id}: UNVERIFIED upstream objectives unavailable`,
      };
    }
    return apiTask.objectives.some((objective) => objective.id === id)
      ? {
          field,
          status: 'needed',
          message: `removed objective ${id}: still served upstream - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
        }
      : {
          field,
          status: 'fixed',
          message: `removed objective ${id}: NO LONGER IN API - REMOVE FROM objectivesRemove`,
        };
  });
  return [...presence, ...objectiveRemovalConflicts(override)];
}

function taskFieldComparison(
  override: TaskOverride,
  task: ComparisonTaskData,
  semantic: ValidationDetail[]
): OverlayComparisonDetail[] {
  // objectivesRemove is judged by objective presence (validateObjectiveRemovals),
  // not as a field upstream could carry.
  const { objectivesAdd, objectivesRemove: _removed, ...fields } = override;
  let details = compareOverlayFields(fields, task);
  for (const verdict of semantic.filter((row) => row.status === 'fixed')) {
    details = applySemanticEvidence(verdict.field, override, task, details);
  }
  (objectivesAdd ?? []).forEach((added, index) => {
    const match = objectiveAdditionMatch(added as unknown as Record<string, unknown>, task);
    const rows = compareOverlayFields(added, match.upstream).map((row) => ({
      ...row,
      field: `objectivesAdd[${index}].${row.field}`,
    }));
    details.push(...rows);
  });
  return details;
}

function fieldRows(rows: OverlayComparisonDetail[], field: string): OverlayComparisonDetail[] {
  return rows.filter(
    (row) =>
      row.field === field || row.field.startsWith(`${field}.`) || row.field.startsWith(`${field}[`)
  );
}

function hasSemanticRequirementValues(field: string, supplied: unknown, source: unknown): boolean {
  return (
    ['taskRequirements', 'taskRequirementGroups', 'traderRequirements'].includes(field) &&
    Array.isArray(supplied) &&
    Array.isArray(source)
  );
}

function applySemanticEvidence(
  field: string,
  patch: TaskOverride,
  task: ComparisonTaskData,
  rows: OverlayComparisonDetail[]
): OverlayComparisonDetail[] {
  const supplied = patch[field as keyof TaskOverride];
  const source = task[field as keyof TaskData];
  if (hasSemanticRequirementValues(field, supplied, source)) {
    const replaced = new Set(fieldRows(rows, field));
    return [
      ...rows.filter((row) => !replaced.has(row)),
      ...compareRequirementValues(field, supplied as unknown[], source as unknown[]),
    ];
  }
  if (field === 'startRewards' || field === 'finishRewards')
    return rewardSubsetEvidence(rows, field);
  return rows;
}

function rewardSubsetEvidence(
  rows: OverlayComparisonDetail[],
  field: string
): OverlayComparisonDetail[] {
  const relevant = fieldRows(rows, field);
  if (relevant.some((row) => row.status === 'invalid' || row.status === 'unverified')) return rows;
  const approved = new Set(relevant);
  return rows.map((row) =>
    approved.has(row) && row.status === 'different'
      ? {
          ...row,
          status: 'same',
          reason: 'Every supplied reward value matches a semantic subset of upstream rewards',
        }
      : row
  );
}

function comparisonFieldPath(field: string): string {
  const objective = /^objective:([^:]+):(.+)$/.exec(field);
  return objective ? `objectives.${objective[1]}.${objective[2]}` : field;
}

function retainFixedDetail(
  detail: ValidationDetail,
  root?: OverlayComparisonDetail
): ValidationDetail {
  if (!root || root.status === 'same') return detail;
  return {
    ...detail,
    status: root.status === 'different' ? 'needed' : 'check',
    message: `${detail.field}: ${root.status.toUpperCase()} supplied values; retain until every field is proven upstream`,
  };
}

function retainUnprovenFields(
  details: ValidationDetail[],
  comparison: OverlayComparisonDetail[]
): ValidationDetail[] {
  return details.map((detail) => {
    if (detail.status !== 'fixed') return detail;
    const root = comparison.find((row) => row.field === comparisonFieldPath(detail.field));
    return retainFixedDetail(detail, root);
  });
}

function validateSupportedFields(taskId: string, override: TaskOverride): void {
  const unhandled = Object.keys(override).filter((field) => !COMPARABLE_FIELDS.has(field));
  if (unhandled.length)
    throw new Error(`No upstream comparison for task ${taskId} fields: ${unhandled.join(', ')}`);
}

function collectValidationDetails(
  override: TaskOverride,
  apiTask: ComparisonTaskData
): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  for (const validator of FIELD_VALIDATORS) {
    const result = validator(override, apiTask);
    if (result) details.push(result);
  }
  details.push(...validateObjectiveOverrides(override, apiTask));
  details.push(...validateObjectiveAdditions(override, apiTask));
  details.push(...validateObjectiveRemovals(override, apiTask));
  return details;
}

function comparisonDisplayName(task: ComparisonTaskData): string {
  return task.name ?? task.id;
}

/**
 * Validate a single task override against API data
 *
 * @param taskId - The task ID to validate
 * @param override - The override data
 * @param apiTasks - All tasks from the API
 * @returns Validation result with status and details
 */
export function validateTaskOverride(
  taskId: string,
  override: TaskOverride,
  apiTasks: ComparisonTaskData[]
): ValidationResult {
  validateSupportedFields(taskId, override);
  const displayTask = apiTasks.find((t) => t.id === taskId);
  const apiTask = displayTask ? comparisonTask(displayTask) : undefined;

  // Task not found in API
  if (!apiTask) {
    return {
      id: taskId,
      name: 'Unknown',
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      comparison: compareOverlayFields(override, undefined),
      details: [
        {
          field: 'task',
          status: 'info',
          message: 'Task not found in API - has been removed from tarkov.dev',
        },
      ],
    };
  }

  const details = collectValidationDetails(override, apiTask);

  // Determine overall status
  const comparison = taskFieldComparison(override, apiTask, details);
  const verifiedDetails = retainUnprovenFields(details, comparison);
  const needsOverride = verifiedDetails.some((d) => d.status === 'needed' || d.status === 'check');
  const status: ValidationStatus = needsOverride ? 'NEEDED' : 'FIXED';

  return {
    id: taskId,
    name: comparisonDisplayName(displayTask!),
    status,
    stillNeeded: needsOverride,
    comparison,
    details: verifiedDetails,
  };
}

/**
 * Validate all task overrides against API data
 *
 * @param overrides - Map of task ID to override data
 * @param apiTasks - All tasks from the API
 * @returns Array of validation results
 */
export function validateAllOverrides(
  overrides: Record<string, TaskOverride>,
  apiTasks: ComparisonTaskData[]
): ValidationResult[] {
  return Object.entries(overrides).map(([taskId, override]) =>
    validateTaskOverride(taskId, override, apiTasks)
  );
}

/**
 * Categorize validation results by status
 */
export function categorizeResults<T extends { stillNeeded: boolean; status: string }>(
  results: T[]
) {
  return {
    stillNeeded: results.filter((r) => r.stillNeeded),
    fixed: results.filter((r) => r.status === 'FIXED'),
    removedFromApi: results.filter((r) => r.status === 'REMOVED_FROM_API'),
  };
}
