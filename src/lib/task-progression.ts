/** Progress-based counter resolution in front of the existing unlock evaluator. */
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  normalizeTaskStatus,
  type TaskUnlockDerivationOptions,
  type TaskUnlockEvaluation,
  type TaskUnlockEvaluationOptions,
  type TaskUnlockState,
} from './task-unlocks.js';
import {
  SUPPORTED_GAME_MODES,
  type GameMode,
  type ProgressionCounterRegistry,
  type TaskData,
} from './types.js';

export interface TaskProgressionOptions extends TaskUnlockDerivationOptions {
  mode: GameMode;
  /** Must match the registry revision; omitted/mismatched revisions never derive values. */
  revision?: string;
  counters?: ProgressionCounterRegistry;
  evaluation?: TaskUnlockEvaluationOptions;
}

export interface ProgressionCounterEvaluation {
  source: 'account' | 'tasks' | 'unresolved';
  value?: number;
  reason: string;
  completedTaskIds?: string[];
  incompleteTaskIds?: string[];
  unknownTaskIds?: string[];
}

export interface TaskProgressionEvaluation extends TaskUnlockEvaluation {
  /** Recorded lifecycle state, independent of calculated start eligibility. */
  recordedStatus?: string;
  counters: Record<string, ProgressionCounterEvaluation>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read only JSON-like own properties, never an inherited counter/status. */
function own(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function unresolved(reason: string): ProgressionCounterEvaluation {
  return { source: 'unresolved', reason };
}

function uniqueIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every(nonEmpty) &&
    new Set(value).size === value.length
  );
}

/** One counter point: earned once every member is complete, or once any member is if `any`. */
export interface CounterGroup {
  ids: string[];
  any: boolean;
}

/** A group is a task-ID list (all members) or `{ anyOf }` (alternatives such as faction variants). */
function counterGroup(value: unknown): CounterGroup | undefined {
  if (uniqueIds(value)) return { ids: Array.from(value), any: false };
  if (!record(value) || Object.keys(value).some((name) => name !== 'anyOf')) return undefined;
  const ids = own(value, 'anyOf');
  return uniqueIds(ids) && ids.length > 1 ? { ids: Array.from(ids), any: true } : undefined;
}

/**
 * Contributor groups for a derivation: one point per group. `distinctTaskCompletions` is the
 * singleton case. Undefined unless the derivation is well formed and no task belongs to two groups.
 */
export function counterGroups(derivation: unknown): CounterGroup[] | undefined {
  if (!record(derivation)) return undefined;
  const type = own(derivation, 'type');
  const key = type === 'distinctTaskCompletions' ? 'taskIds' : 'groups';
  if (
    (type !== 'distinctTaskCompletions' && type !== 'taskGroupCompletions') ||
    Object.keys(derivation).some((name) => !['type', key].includes(name))
  )
    return undefined;
  const value = own(derivation, key);
  if (type === 'distinctTaskCompletions')
    return uniqueIds(value) ? value.map((id) => ({ ids: [id], any: false })) : undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const groups = Array.from(value).map(counterGroup);
  if (!groups.every((group) => group !== undefined)) return undefined;
  const ids = groups.flatMap((group) => group.ids);
  return new Set(ids).size === ids.length ? groups : undefined;
}

/** Schema validation cannot express cross-group uniqueness, so the source check enforces it. */
export function assertDisjointCounterGroups(registry: ProgressionCounterRegistry): void {
  for (const [mode, entries] of Object.entries(registry)) {
    for (const [variableId, entry] of Object.entries(entries ?? {})) {
      if (!counterGroups(own(entry, 'derivation')))
        throw new Error(
          `${mode}/${variableId}: malformed derivation, or a task appears in more than one group`
        );
    }
  }
}

/** Validate externally supplied registry entries even when schema validation was skipped. */
function contributorGroups(definition: unknown, revision: unknown): CounterGroup[] | undefined {
  if (
    !record(definition) ||
    !nonEmpty(revision) ||
    own(definition, 'revision') !== revision ||
    own(definition, 'verification') !== 'verified' ||
    own(definition, 'coverage') !== 'complete'
  )
    return undefined;
  if (
    Object.keys(definition).some(
      (key) => !['revision', 'verification', 'coverage', 'derivation', 'proof'].includes(key)
    )
  )
    return undefined;
  const proof = own(definition, 'proof');
  if (!uniqueIds(proof) || !proof.every((link) => /^https?:\/\/\S+$/.test(link))) return undefined;
  return counterGroups(own(definition, 'derivation'));
}

/** A mixed status list expresses uncertainty, not an additional completion. */
function completionState(value: unknown): 'complete' | 'incomplete' | 'unknown' {
  const statuses = Array.isArray(value) ? Array.from(value) : [value];
  const normalized = statuses.map(normalizeTaskStatus);
  if (!normalized.length || normalized.some((status) => status === undefined)) return 'unknown';
  if (normalized.every((status) => status === 'complete')) return 'complete';
  if (normalized.every((status) => status !== 'complete')) return 'incomplete';
  return 'unknown';
}

/** Count one point per verified contributor group; missing task history is never implicitly zero. */
function resolveCounter(
  variableId: string,
  state: TaskUnlockState,
  options: TaskProgressionOptions
): ProgressionCounterEvaluation {
  const globalVariables = own(state, 'globalVariables');
  if (record(globalVariables) && Object.hasOwn(globalVariables, variableId)) {
    const account = globalVariables[variableId];
    return typeof account === 'number' && Number.isFinite(account)
      ? { source: 'account', value: account, reason: 'explicit resolved account value' }
      : unresolved('account value is invalid');
  }
  const mode = own(options, 'mode');
  if (!nonEmpty(mode) || !SUPPORTED_GAME_MODES.includes(mode as GameMode))
    return unresolved('game mode is invalid');
  const groups = contributorGroups(
    own(own(own(options, 'counters'), mode), variableId),
    own(options, 'revision')
  );
  if (!groups) return unresolved('no complete verified mapping for this mode and revision');
  const taskStatuses = own(state, 'taskStatuses');
  const states = new Map(
    groups
      .flatMap(({ ids }) => ids)
      .map((id) => [id, completionState(own(taskStatuses, id))] as const)
  );
  const idsIn = (wanted: string) => [...states].filter(([, s]) => s === wanted).map(([id]) => id);
  const progress = {
    completedTaskIds: idsIn('complete'),
    incompleteTaskIds: idsIn('incomplete'),
    unknownTaskIds: idsIn('unknown'),
  };
  const points = groups.map((group) => groupPoint(group, states));
  if (points.includes(undefined))
    return { ...unresolved('contributor task history is missing or ambiguous'), ...progress };
  return {
    source: 'tasks',
    value: points.filter(Boolean).length,
    reason: 'verified contributor group completions',
    ...progress,
  };
}

/**
 * Whether a group earns its point, or undefined while unknown members could still decide it. An
 * all-members group is settled at zero by any incomplete member; an any-member group is settled
 * at one by any complete member.
 */
function groupPoint(
  { ids, any }: CounterGroup,
  states: Map<string, 'complete' | 'incomplete' | 'unknown'>
): boolean | undefined {
  const members = ids.map((id) => states.get(id));
  const decisive = any ? 'complete' : 'incomplete';
  if (members.includes(decisive)) return any;
  return members.includes('unknown') ? undefined : !any;
}

/**
 * Evaluate start eligibility without changing recorded progress or backfilling history.
 * The caller supplies one account/mode/run snapshot and already-merged TaskData.
 */
export function evaluateTaskProgression(
  task: TaskData,
  state: TaskUnlockState,
  options: TaskProgressionOptions
): TaskProgressionEvaluation {
  const safeState = record(state) ? state : {};
  const safeOptions = (record(options) ? options : {}) as unknown as TaskProgressionOptions;
  const safeTask = (record(task) ? task : {}) as unknown as TaskData;
  const definition = deriveTaskUnlockDefinition(safeTask, safeOptions);
  const counters: Record<string, ProgressionCounterEvaluation> = Object.create(null);
  const globalVariables: Record<string, number> = Object.create(null);
  for (const condition of definition.all) {
    if (condition.type !== 'globalVariable' || Object.hasOwn(counters, condition.variableId))
      continue;
    const counter = resolveCounter(condition.variableId, safeState, safeOptions);
    counters[condition.variableId] = counter;
    if (counter.value !== undefined) globalVariables[condition.variableId] = counter.value;
  }
  const result = evaluateTaskUnlock(
    safeTask,
    definition,
    { ...safeState, globalVariables },
    own(safeOptions, 'evaluation') as TaskUnlockEvaluationOptions | undefined
  );
  const taskId = own(safeTask, 'id');
  return {
    ...result,
    recordedStatus: nonEmpty(taskId)
      ? normalizeTaskStatus(own(own(safeState, 'taskStatuses'), taskId))
      : undefined,
    counters,
  };
}
