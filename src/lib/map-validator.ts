/** Map corrections plus the extractsAdd operation, which upstream calls extracts. */
import {
  validateEntityOverrides,
  type EntityValidationResult,
  type EntityValidationDetail,
} from './entity-validator.js';
import { valuesEqual } from './value-compare.js';

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

/** Upstream identity wins over the approximate coordinates of an addition. */
function additionDetails(
  additions: Record<string, unknown>[],
  extracts: Record<string, unknown>[],
  translations: Record<string, string>,
  sharedAdditions: unknown
): EntityValidationDetail[] {
  const guards: EntityValidationDetail[] = [];
  if (
    Array.isArray(sharedAdditions) &&
    sharedAdditions.length > 0 &&
    !valuesEqual(sharedAdditions, additions)
  ) {
    guards.push({
      field: 'extractsAdd',
      status: 'needed',
      message: 'extractsAdd: mode replacement suppresses shared additions - STILL NEEDED',
    });
  }
  return [
    ...guards,
    ...additions.map((addition): EntityValidationDetail => {
      const match = extracts.find(
        (extract) =>
          extract.id === addition.id ||
          extract.name === addition.id ||
          extract.name === addition.name ||
          translations[String(extract.name)] === addition.name
      );
      return {
        field: `extractsAdd:${addition.id}`,
        status: match ? 'fixed' : 'needed',
        message: match
          ? `extractsAdd '${addition.id}': NOW IN API as '${match.id}' - remove the addition`
          : `extractsAdd '${addition.id}': still missing from API - STILL NEEDED`,
      };
    }),
  ];
}

function translatedName(name: unknown, translations: Record<string, string>): unknown {
  return typeof name === 'string' ? (translations[name] ?? name) : name;
}

/** Validate before spreading so invalid entries cannot become empty patches. */
export function mergeMapOverrides(
  shared: Record<string, unknown>,
  scoped: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  for (const patches of [shared, scoped]) {
    if (!record(patches)) throw new Error('Invalid map overrides collection');
    for (const [id, patch] of Object.entries(patches)) {
      if (!record(patch)) throw new Error(`Invalid map override ${id}`);
    }
  }
  return Object.fromEntries(
    [...new Set([...Object.keys(shared), ...Object.keys(scoped)])].map((id) => [
      id,
      { ...(shared[id] as Record<string, unknown>), ...(scoped[id] as Record<string, unknown>) },
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
      (detail) =>
        detail.status === 'needed' || detail.status === 'error' || detail.status === 'synthetic'
    );
    result.status = result.stillNeeded ? 'NEEDED' : 'FIXED';
    return result;
  });
}
