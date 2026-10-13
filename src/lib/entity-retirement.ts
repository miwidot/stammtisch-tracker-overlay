import type {
  EntityValidationDetail,
  EntityValidationResult,
  EntityDetailStatus,
} from './entity-validator.js';

export interface EntityModeEvidence {
  mode: string;
  results: EntityValidationResult[];
}

function completeModes(evidence: EntityModeEvidence[], modes: readonly string[]): void {
  const actual = new Set(evidence.map((entry) => entry.mode));
  if (actual.size !== evidence.length || modes.some((mode) => !actual.has(mode)))
    throw new Error('Missing or duplicate mode evidence for shared entity retirement');
}

function resultFor(evidence: EntityModeEvidence, id: string): EntityValidationResult | undefined {
  return evidence.results.find((result) => result.id === id);
}

function detailStatus(details: Array<EntityValidationDetail | undefined>): EntityDetailStatus {
  if (details.some((detail) => !detail)) return 'check';
  return provenDetailStatus(details as EntityValidationDetail[]);
}

function provenDetailStatus(details: EntityValidationDetail[]): EntityDetailStatus {
  const blocker = (['error', 'check', 'needed', 'synthetic'] as const).find((status) =>
    details.some((detail) => detail.status === status)
  );
  if (blocker) return blocker;
  return details.every((detail) => detail.status === 'fixed') ? 'fixed' : 'info';
}

function modeField(
  evidence: EntityModeEvidence,
  id: string,
  field: string
): EntityValidationDetail | undefined {
  return resultFor(evidence, id)?.details.find((detail) => detail.field === field);
}

function fieldMessage(mode: string, detail?: EntityValidationDetail): string {
  return `[${mode}] ${detail?.message ?? 'Field evidence unavailable; keep shared value'}`;
}

function sharedField(
  id: string,
  field: string,
  evidence: EntityModeEvidence[]
): EntityValidationDetail {
  const details = evidence.map((mode) => modeField(mode, id, field));
  return {
    field,
    status: detailStatus(details),
    message: details.map((detail, index) => fieldMessage(evidence[index].mode, detail)).join('; '),
  };
}

function sharedAdoption(results: Array<EntityValidationResult | undefined>): boolean | undefined {
  if (!results.some((result) => result?.adopted !== undefined)) return undefined;
  return results.every((result) => result?.adopted === true);
}

function retirementStatus(
  results: Array<EntityValidationResult | undefined>,
  needed: boolean
): EntityValidationResult['status'] {
  if (results.every((result) => result?.status === 'REMOVED_FROM_API')) return 'REMOVED_FROM_API';
  return needed ? 'NEEDED' : 'FIXED';
}

function evidenceNeeded(
  results: Array<EntityValidationResult | undefined>,
  details: EntityValidationDetail[]
): boolean {
  return (
    results.some((result) => !result || result.stillNeeded) ||
    details.some((detail) => ['needed', 'synthetic', 'error', 'check'].includes(detail.status))
  );
}

function sharedResult(id: string, evidence: EntityModeEvidence[]): EntityValidationResult {
  const results = evidence.map((mode) => resultFor(mode, id));
  const fields = new Set(
    results.flatMap((result) => result?.details.map((detail) => detail.field) ?? [])
  );
  const details = [...fields].map((field) => sharedField(id, field, evidence));
  const needed = evidenceNeeded(results, details);
  return {
    id,
    status: retirementStatus(results, needed),
    stillNeeded: needed,
    adopted: sharedAdoption(results),
    details,
  };
}

/** One physical shared source unit can retire only with evidence from every applicable mode. */
export function aggregateEntityRetirement(
  evidence: EntityModeEvidence[],
  modes: readonly string[]
): EntityValidationResult[] {
  completeModes(evidence, modes);
  const ids = new Set(evidence.flatMap((mode) => mode.results.map((result) => result.id)));
  return [...ids].map((id) => sharedResult(id, evidence));
}
