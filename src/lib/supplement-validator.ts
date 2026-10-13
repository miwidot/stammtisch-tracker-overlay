import { compareSubset } from './value-compare.js';

export interface SupplementReport {
  actionable: number;
  staleProblems: number;
  messages: string[];
}

type RecordData = Record<string, unknown>;
function record(value: unknown): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an upstream object');
  }
  return value as RecordData;
}

function newReport(): SupplementReport {
  return { actionable: 0, staleProblems: 0, messages: [] };
}

function rawEffect(value: unknown): RecordData {
  const effect = record(value);
  if (typeof effect.effectId !== 'string') throw new Error('Expected raw effectId');
  return effect;
}

function rawEffects(value: unknown): RecordData[] {
  if (!Array.isArray(value)) throw new Error('Expected raw effects array');
  return value.map(rawEffect);
}

function optionalEffects(perk: RecordData): RecordData[] | undefined {
  return perk.effects == null ? undefined : rawEffects(perk.effects);
}

function indexPerk(perks: Map<string, RecordData>, raw: unknown): void {
  const perk = record(raw);
  if (typeof perk.id !== 'string') throw new Error('Expected upstream perk id');
  if (perks.has(perk.id)) throw new Error(`Duplicate upstream perk id: ${perk.id}`);
  optionalEffects(perk);
  perks.set(perk.id, perk);
}

function indexPerks(season: unknown): Map<string, RecordData> {
  const groups = record(record(season).perks);
  const perks = new Map<string, RecordData>();
  for (const group of Object.values(groups)) {
    if (!Array.isArray(group)) throw new Error('Expected season.perks groups to be arrays');
    group.forEach((raw: unknown) => indexPerk(perks, raw));
  }
  if (!perks.size) throw new Error('Upstream season contains no perks');
  return perks;
}

function compareEffect(
  id: string,
  effect: RecordData,
  upstream: RecordData[],
  report: SupplementReport
): void {
  const label = `${id}: raw effect ${String(effect.effectId)}`;
  if (upstream.some((candidate) => compareSubset(effect, candidate))) {
    report.staleProblems++;
    report.messages.push(`${label} now present upstream; review retirement`);
  } else if (upstream.some((candidate) => candidate.effectId === effect.effectId)) {
    report.actionable++;
    report.messages.push(`${label} differs upstream — NEEDS EVIDENCE; no automatic retirement`);
  } else {
    report.messages.push(`${label} UNSUPPORTED upstream; value not verified`);
  }
}

function comparePerk(
  id: string,
  raw: unknown,
  perks: Map<string, RecordData>,
  report: SupplementReport
): void {
  const supplement = record(raw);
  const upstream = perks.get(id);
  if (!upstream || supplement.id !== id) {
    report.actionable++;
    report.messages.push(`${id}: perk ID missing upstream or supplement ID disagrees with key`);
    return;
  }
  const effects = rawEffects(supplement.effects);
  const exposed = optionalEffects(upstream);
  if (!exposed) {
    report.messages.push(`${id}: raw effects UNSUPPORTED upstream; values not verified`);
    return;
  }
  effects.forEach((effect) => compareEffect(id, effect, exposed, report));
}

/** Compare raw effects only; locale descriptions are not evidence of raw values. */
export function validateSeasonalPerks(overlay: RecordData, season: unknown): SupplementReport {
  const perks = indexPerks(season);
  const report = newReport();
  Object.entries(overlay).forEach(([id, raw]) => comparePerk(id, raw, perks, report));
  report.messages.push(
    'seasonalPerks: IDs and exposed raw effects compared; absent raw effects remain supplements (descriptions not compared)'
  );
  return report;
}

function upstreamTasks(data: unknown): RecordData[] {
  const raw = record(data).tasks;
  const tasks = Array.isArray(raw) ? raw : Object.values(record(raw));
  if (!tasks.length) throw new Error('Expected nonempty upstream tasks');
  return tasks.map(record);
}

function globalVariableId(raw: unknown): string | undefined {
  const requirement = record(raw);
  if (requirement.type !== 'globalVariable') return undefined;
  if (typeof requirement.variableId !== 'string')
    throw new Error('Expected globalVariable variableId');
  return requirement.variableId;
}

function taskVariables(task: RecordData): string[] {
  if (task.otherRequirements === undefined) return [];
  if (!Array.isArray(task.otherRequirements)) throw new Error('Expected otherRequirements array');
  return task.otherRequirements
    .map(globalVariableId)
    .filter((id): id is string => id !== undefined);
}

function upstreamTaskId(task: RecordData): string {
  if (typeof task.id !== 'string') throw new Error('Expected upstream task id');
  return task.id;
}

function counterTasks(raw: unknown, variableId: string): unknown[] {
  const ids = record(record(raw).derivation).taskIds;
  if (!Array.isArray(ids)) throw new Error(`Expected derivation.taskIds for ${variableId}`);
  return [...new Set(ids)];
}

function compareCounter(
  variableId: string,
  raw: unknown,
  taskIds: Set<string>,
  variableIds: Set<string>,
  report: SupplementReport
): void {
  for (const id of counterTasks(raw, variableId)) {
    if (taskIds.has(id as string)) continue;
    report.actionable++;
    report.messages.push(
      `${variableId}: task reference ${String(id)} missing upstream; review reference`
    );
  }
  if (!variableIds.has(variableId)) {
    report.messages.push(
      `${variableId}: NOT COMPARABLE variable not referenced by upstream task gates; absence does not prove invalidity`
    );
  }
}

/** Upstream gates establish variable references, not the counter's completion pool. */
export function validateProgressionCounters(counters: RecordData, data: unknown): SupplementReport {
  const tasks = upstreamTasks(data);
  const taskIds = new Set(tasks.map(upstreamTaskId));
  const variableIds = new Set(tasks.flatMap(taskVariables));
  const report = newReport();
  Object.entries(counters).forEach(([id, raw]) =>
    compareCounter(id, raw, taskIds, variableIds, report)
  );
  report.messages.push(
    'progressionCounters: task references compared; global variable references checked where gates expose them; pool membership and verification/coverage claims NOT COMPARABLE'
  );
  return report;
}
