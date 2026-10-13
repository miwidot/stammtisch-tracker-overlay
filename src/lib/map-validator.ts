/** Map corrections plus the extractsAdd operation, which upstream calls extracts. */
import {
  validateEntityOverrides,
  type EntityValidationResult,
  type EntityValidationDetail,
} from './entity-validator.js';
import { compareOverlayFields, type OverlayComparisonDetail } from './overlay-comparison.cjs';
import { formatValue, valuesEqual } from './value-compare.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractEntries(value: unknown, label: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !record(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id.trim() ||
        typeof entry.name !== 'string' ||
        !entry.name.trim()
    )
  ) {
    throw new Error(`Invalid ${label}: expected extracts with nonempty id and name`);
  }
  return value;
}

function additionCandidate(
  addition: Record<string, unknown>,
  extracts: Record<string, unknown>[],
  translations: Record<string, string>
): Record<string, unknown> | undefined {
  const exact = extracts.filter((extract) => extract.id === addition.id);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const names = extracts.filter(
    (extract) => translatedName(extract.name, translations) === addition.name
  );
  return names.length === 1 ? names[0] : undefined;
}

function additionFieldDetails(
  addition: Record<string, unknown>,
  match: Record<string, unknown> | undefined,
  translations: Record<string, string>
): EntityValidationDetail[] {
  const upstream = match && { ...match, name: translatedName(match.name, translations) };
  return compareOverlayFields(addition, upstream).map((detail) =>
    extractFieldDetail(addition.id, detail)
  );
}

function extractFieldDetail(id: unknown, detail: OverlayComparisonDetail): EntityValidationDetail {
  const statuses = {
    same: 'fixed',
    different: 'needed',
    unverified: 'check',
    invalid: 'error',
  } as const;
  return {
    field: `extractsAdd:${id}.${detail.field}`,
    status: statuses[detail.status],
    message: `${detail.field}: ${detail.status.toUpperCase()} - ${detail.reason} (API=${formatValue(detail.upstreamValue)}, overlay=${formatValue(detail.overlayValue)})`,
  };
}

function extractAdditionDetails(
  addition: Record<string, unknown>,
  extracts: Record<string, unknown>[],
  translations: Record<string, string>
): EntityValidationDetail[] {
  const match = additionCandidate(addition, extracts, translations);
  const fields = additionFieldDetails(addition, match, translations);
  const fixed = fields.every((detail) => detail.status === 'fixed');
  return [
    {
      field: `extractsAdd:${addition.id}`,
      status: fixed ? 'fixed' : 'needed',
      message: fixed
        ? `extractsAdd '${addition.id}': all supplied values match; assess extractsAdd retirement as a whole`
        : `extractsAdd '${addition.id}': supplied values not fully adopted - STILL NEEDED`,
    },
    ...fields,
  ];
}

function replacesSharedAdditions(shared: unknown, additions: Record<string, unknown>[]): boolean {
  return Array.isArray(shared) && shared.length > 0 && !valuesEqual(shared, additions);
}

function additionDetails(
  additions: Record<string, unknown>[],
  extracts: Record<string, unknown>[],
  translations: Record<string, string>,
  sharedAdditions: unknown
): EntityValidationDetail[] {
  const replacement = replacesSharedAdditions(sharedAdditions, additions);
  const fields = additions.flatMap((addition) =>
    extractAdditionDetails(addition, extracts, translations)
  );
  const fixed = !replacement && fields.every((detail) => detail.status === 'fixed');
  return [
    {
      field: 'extractsAdd',
      status: fixed ? 'fixed' : 'needed',
      message: fixed
        ? 'extractsAdd: all supplied additions redundant - remove the operation'
        : 'extractsAdd: additions or mode replacement STILL NEEDED; retain the whole operation',
    },
    ...fields,
  ];
}

function translatedName(name: unknown, translations: Record<string, string>): unknown {
  if (typeof name !== 'string') return name;
  if (!Object.hasOwn(translations, name)) return name;
  return translations[name]?.trim() ? translations[name] : undefined;
}

function mergedMapValue(base: unknown, value: unknown): unknown {
  return record(value) ? mergeMapPatch(base, value) : value;
}

function mergeMapPatch(base: unknown, patch: unknown): Record<string, unknown> {
  const merged = record(base) ? { ...base } : {};
  if (!record(patch)) return merged;
  for (const [field, value] of Object.entries(patch)) {
    merged[field] = mergedMapValue(merged[field], value);
  }
  return merged;
}

function sameExtractIdentity(
  extract: Record<string, unknown>,
  addition: Record<string, unknown>
): boolean {
  return extract.id === addition.id || extract.name === addition.name;
}

function sharedMapBaseline(
  upstream: Record<string, unknown>,
  shared: Record<string, unknown>
): Record<string, unknown> {
  const { extractsAdd, ...corrections } = shared;
  const baseline = mergeMapPatch(upstream, corrections);
  if (extractsAdd === undefined) return baseline;
  const extracts = extractEntries(baseline.extracts, 'shared baseline extracts');
  const additions = extractEntries(extractsAdd, 'shared extractsAdd');
  baseline.extracts = [
    ...extracts,
    ...additions.filter(
      (addition) => !extracts.some((extract) => sameExtractIdentity(extract, addition))
    ),
  ];
  return baseline;
}

/** Scoped patches retire only when deleting them preserves the shared-applied values. */
export function validateModeMapOverrides(
  scoped: Record<string, unknown>,
  shared: Record<string, unknown>,
  apiMaps: Map<string, Record<string, unknown>>,
  translations: Record<string, string>
): EntityValidationResult[] {
  const patches = mergeMapOverrides({}, shared);
  const baseline = new Map(
    [...apiMaps].map(([id, map]) => [id, sharedMapBaseline(map, patches[id] ?? {})])
  );
  const operations = Object.fromEntries(
    Object.entries(patches).map(([id, patch]) => [id, { extractsAdd: patch.extractsAdd }])
  );
  return validateMapOverrides(scoped, baseline, translations, operations);
}

function assertMapPatches(patches: Record<string, unknown>): void {
  if (!record(patches)) throw new Error('Invalid map overrides collection');
  for (const [id, patch] of Object.entries(patches)) {
    if (!record(patch)) throw new Error(`Invalid map override ${id}`);
  }
}

/** Validate before spreading so invalid entries cannot become empty patches. */
export function mergeMapOverrides(
  shared: Record<string, unknown>,
  scoped: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  assertMapPatches(shared);
  assertMapPatches(scoped);
  return Object.fromEntries(
    [...new Set([...Object.keys(shared), ...Object.keys(scoped)])].map((id) => [
      id,
      mergeMapPatch(shared[id], scoped[id]),
    ])
  );
}

/** A value matching upstream can still be necessary to cancel a shared correction. */
function preserveSharedCorrections(
  result: EntityValidationResult,
  effective: Record<string, unknown>,
  shared: Record<string, unknown> = {}
): void {
  for (const detail of result.details) {
    if (
      detail.status === 'fixed' &&
      Object.hasOwn(shared, detail.field) &&
      !valuesEqual(shared[detail.field], effective[detail.field])
    ) {
      detail.status = 'needed';
      detail.message = `${detail.field}: mode value overrides a different shared correction - STILL NEEDED`;
      result.stillNeeded = true;
      result.status = 'NEEDED';
    }
  }
}

/** Match the documented consumer rule (same ID or name), including raw locale keys. */
export function validateMapOverrides(
  overrides: Record<string, unknown>,
  apiMaps: Map<string, Record<string, unknown>>,
  translations: Record<string, string>,
  sharedOverrides: Record<string, Record<string, unknown>> = {}
): EntityValidationResult[] {
  return Object.entries(overrides).map(([mapId, rawOverride]) => {
    if (!record(rawOverride)) throw new Error(`Invalid map override ${mapId}`);
    const { extractsAdd, ...corrections } = rawOverride;
    const apiMap = apiMaps.get(mapId);
    const translatedMap = apiMap && {
      ...apiMap,
      name: translatedName(apiMap.name, translations),
    };
    const result = validateEntityOverrides(
      { [mapId]: corrections },
      translatedMap ? new Map([[mapId, translatedMap]]) : new Map()
    )[0];
    preserveSharedCorrections(result, rawOverride, sharedOverrides[mapId]);
    if (!apiMap) return result;
    const extracts = extractEntries(apiMap.extracts, `${mapId}.extracts`);
    if (extractsAdd === undefined) return result;
    const additions = extractEntries(extractsAdd, `${mapId}.extractsAdd`);
    result.details.push(
      ...additionDetails(additions, extracts, translations, sharedOverrides[mapId]?.extractsAdd)
    );
    result.stillNeeded = result.details.some(
      (detail) => detail.status !== 'fixed' && detail.status !== 'info'
    );
    result.status = result.stillNeeded ? 'NEEDED' : 'FIXED';
    return result;
  });
}
