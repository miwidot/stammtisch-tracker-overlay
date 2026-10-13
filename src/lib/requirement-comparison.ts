import { compareOverlayFields, type OverlayComparisonDetail } from './overlay-comparison.cjs';
import { normalizeTaskStatus } from './task-unlocks.js';

type Requirement = Record<string, unknown>;
type Key = (value: Requirement) => string;

function record(value: unknown): Requirement {
  return value !== null && typeof value === 'object' ? (value as Requirement) : {};
}

function states(value: unknown): unknown {
  if (value === undefined) return ['complete'];
  if (!Array.isArray(value)) return value;
  return [
    ...new Set(
      value.map((state) =>
        typeof state === 'string' ? (normalizeTaskStatus(state) ?? state) : state
      )
    ),
  ].sort();
}

function taskKey(value: Requirement): string {
  return JSON.stringify([record(value.task).id, states(value.status)]);
}

function traderKey(value: Requirement): string {
  return JSON.stringify([
    record(value.trader).id,
    value.requirementType,
    value.compareMethod,
    value.value,
  ]);
}

function normalize(value: Requirement, trader: boolean): Requirement {
  if (!trader) return { ...value, status: states(value.status) };
  const { id: _id, ...fields } = value;
  return fields;
}

function atPath(rows: OverlayComparisonDetail[], path: string): OverlayComparisonDetail[] {
  return rows.map((row) => ({ ...row, field: `${path}.${row.field}` }));
}

function aggregate(
  path: string,
  overlayValue: unknown,
  upstreamValue: unknown,
  rows: OverlayComparisonDetail[]
): OverlayComparisonDetail[] {
  const status =
    (['invalid', 'different', 'unverified'] as const).find((s) =>
      rows.some((r) => r.status === s)
    ) ?? 'same';
  return [
    {
      field: path,
      overlayValue,
      upstreamValue,
      status,
      reason: 'Requirement semantics and every supplied value checked',
    },
    ...rows,
  ];
}

function ambiguous(rows: OverlayComparisonDetail[]): OverlayComparisonDetail[] {
  return rows.map((row) => ({
    ...row,
    status: 'unverified',
    reason: 'Semantic identity matches conflicting upstream records',
  }));
}

function entryFields(
  patch: Requirement,
  source: Requirement,
  trader: boolean
): OverlayComparisonDetail[] {
  const rows = compareOverlayFields(normalize(patch, trader), normalize(source, trader));
  if (trader && Object.hasOwn(patch, 'id'))
    rows.push({
      field: 'id',
      overlayValue: patch.id,
      upstreamValue: source.id,
      status: 'same',
      reason:
        'Equivalent trader requirement; merge IDs may differ without requiring a duplicate append',
    });
  return rows;
}

function chooseCandidateRows(comparisons: OverlayComparisonDetail[][]): OverlayComparisonDetail[] {
  const proven = comparisons.every((rows) => rows.every((row) => row.status === 'same'));
  return comparisons.length === 1 || proven ? comparisons[0] : ambiguous(comparisons[0]);
}

function entryEvidence(
  patch: Requirement,
  source: unknown[],
  trader: boolean,
  path: string
): OverlayComparisonDetail[] {
  const key: Key = trader ? traderKey : taskKey;
  const candidates = source.map(record).filter((entry) => key(entry) === key(patch));
  if (!candidates.length) return atPath(compareOverlayFields(patch, undefined), path);
  const comparisons = candidates.map((entry) => entryFields(patch, entry, trader));
  const rows = chooseCandidateRows(comparisons);
  return aggregate(path, patch, candidates[0], atPath(rows, path));
}

function groupKey(group: unknown[]): string {
  return JSON.stringify([...new Set(group.map((entry) => taskKey(record(entry))))].sort());
}

function groupFields(patch: unknown[], source: unknown[], path: string): OverlayComparisonDetail[] {
  return patch.flatMap((entry, index) =>
    entryEvidence(record(entry), source, false, `${path}[${index}]`)
  );
}

function groupEvidence(
  patch: unknown[],
  source: unknown[],
  path: string
): OverlayComparisonDetail[] {
  const candidates = source.filter(
    (group): group is unknown[] => Array.isArray(group) && groupKey(group) === groupKey(patch)
  );
  if (!candidates.length) return aggregate(path, patch, undefined, groupFields(patch, [], path));
  const comparisons = candidates.map((group) => groupFields(patch, group, path));
  return aggregate(path, patch, candidates[0], chooseCandidateRows(comparisons));
}

/** Called only after the legacy evaluator proves collection cardinality/state semantics. */
export function compareRequirementValues(
  field: string,
  patch: unknown[],
  source: unknown[]
): OverlayComparisonDetail[] {
  const groups = field === 'taskRequirementGroups';
  const rows = patch.flatMap((entry, index) =>
    groups && Array.isArray(entry)
      ? groupEvidence(entry, source, `${field}[${index}]`)
      : entryEvidence(record(entry), source, field === 'traderRequirements', `${field}[${index}]`)
  );
  return aggregate(field, patch, source, rows);
}
