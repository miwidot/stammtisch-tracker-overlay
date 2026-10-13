import { describe, expect, it } from 'vitest';
import { validateMapOverrides, validateModeMapOverrides } from '../src/lib/map-validator.js';

const addition = {
  id: 'SCAV_Underboat_Hideout',
  name: 'Hideout Under the Landing Stage',
  faction: 'scav',
  position: { x: 143.13, y: 0.73, z: -159.34 },
};
const extract = {
  id: 'canonical-extract-id',
  name: 'Scav_Underboat_Hideout',
  faction: 'scav',
  position: { x: 133.07, y: -0.47, z: 286.84 },
};
const translations = { Scav_Underboat_Hideout: addition.name, map_name: 'Lighthouse' };
const maps = (extracts: unknown = [extract]) =>
  new Map([['lighthouse', { name: 'map_name', disabled: false, extracts }]]);
const validate = (extracts: unknown = [extract], patch: Record<string, unknown> = {}) =>
  validateMapOverrides(
    { lighthouse: { extractsAdd: [addition], ...patch } },
    maps(extracts),
    translations
  );

describe('map override validation', () => {
  it('retains a translated candidate with different canonical ID and coordinates', () => {
    expect(validate()[0]).toMatchObject({ status: 'NEEDED', stillNeeded: true });
    expect(validate()[0].details[1]).toMatchObject({
      field: `extractsAdd:${addition.id}`,
      status: 'needed',
    });
  });

  it('matches a canonical ID but retains changed values when upstream renamed the extract', () => {
    expect(validate([{ ...extract, id: addition.id, name: 'renamed' }])[0].status).toBe('NEEDED');
  });

  it('does not retire raw name candidates without canonical ID adoption', () => {
    expect(validate([{ ...extract, name: addition.name }])[0].status).toBe('NEEDED');
    expect(validate([{ ...extract, name: addition.id }])[0].status).toBe('NEEDED');
  });

  it('keeps a genuinely missing extract and does not match another map', () => {
    const apiMaps = maps([]);
    apiMaps.set('other-map', { name: 'other', disabled: false, extracts: [extract] });
    expect(
      validateMapOverrides({ lighthouse: { extractsAdd: [addition] } }, apiMaps, translations)[0]
    ).toMatchObject({ status: 'NEEDED', stillNeeded: true });
  });

  it('reports stale additions within a map that still needs a correction', () => {
    const result = validate([addition], { disabled: true })[0];
    expect(result.status).toBe('NEEDED');
    expect(result.details.slice(0, 2).map((detail) => detail.status)).toEqual(['needed', 'fixed']);
  });

  it('compares ordinary map fields with translated names', () => {
    expect(
      validateMapOverrides(
        { lighthouse: { name: 'Lighthouse', disabled: false } },
        maps(),
        translations
      )[0].status
    ).toBe('FIXED');
  });

  it('reports a missing map as an error', () => {
    expect(
      validateMapOverrides({ missing: { extractsAdd: [addition] } }, maps(), translations)[0]
    ).toMatchObject({ status: 'REMOVED_FROM_API', details: [{ status: 'error' }] });
  });

  it.each([undefined, null, {}, [null], [{ id: 'x' }]])(
    'rejects malformed upstream extracts: %j',
    (extracts) => {
      const upstream = new Map([['lighthouse', { extracts }]]);
      expect(() =>
        validateMapOverrides({ lighthouse: { extractsAdd: [addition] } }, upstream, translations)
      ).toThrow(/extracts/);
    }
  );

  it('rejects malformed additions rather than silently skipping them', () => {
    expect(() => validate([extract], { extractsAdd: {} })).toThrow(/extractsAdd/);
  });
  it.each([{ disabled: true }, { extractsAdd: [] }])(
    'validates upstream extracts for patches without additions: %j',
    (patch) => {
      expect(() => validateMapOverrides({ lighthouse: patch }, maps(null), translations)).toThrow(
        /extracts/
      );
    }
  );
  it('treats an empty replacement as necessary while shared additions remain', () => {
    const result = validateMapOverrides({ lighthouse: { extractsAdd: [] } }, maps(), translations, {
      lighthouse: { extractsAdd: [addition] },
    })[0];
    expect(result).toMatchObject({
      status: 'NEEDED',
      stillNeeded: true,
      details: [{ field: 'extractsAdd', status: 'needed' }],
    });
  });
  it('preserves a mode correction matching upstream when it overrides shared data', () => {
    const result = validateMapOverrides({ lighthouse: { disabled: false } }, maps(), translations, {
      lighthouse: { disabled: true },
    })[0];
    expect(result).toMatchObject({
      status: 'NEEDED',
      stillNeeded: true,
      details: [{ field: 'disabled', status: 'needed' }],
    });
  });

  it('retains a nonempty scoped replacement while showing matching entry diagnostics', () => {
    const result = validateMapOverrides(
      { lighthouse: { extractsAdd: [addition] } },
      maps([addition]),
      translations,
      {
        lighthouse: { extractsAdd: [{ ...addition, id: 'shared-other', name: 'Other exit' }] },
      }
    )[0];
    expect(result).toMatchObject({ status: 'NEEDED', stillNeeded: true });
    expect(result.details.slice(0, 2).map((detail) => detail.status)).toEqual(['needed', 'fixed']);
  });

  it('still retires a shared addition when a scoped list does not change it', () => {
    const result = validateMapOverrides(
      { lighthouse: { extractsAdd: [addition] } },
      maps([addition]),
      translations,
      {
        lighthouse: { extractsAdd: [addition] },
      }
    )[0];
    expect(result.status).toBe('FIXED');
  });
});

describe('mode map retirement', () => {
  it('compares scoped corrections with the recursive shared baseline', () => {
    const shared = { lighthouse: { disabled: true, settings: { count: 2, other: 9 } } };
    const scoped = { lighthouse: { disabled: true, settings: { count: 2 } } };
    const upstream: Map<string, Record<string, unknown>> = maps();
    upstream.get('lighthouse')!.settings = { count: 1, other: 9 };
    expect(validateMapOverrides(shared, upstream, translations)[0].status).toBe('NEEDED');
    expect(validateModeMapOverrides(scoped, shared, upstream, translations)[0].status).toBe(
      'FIXED'
    );
    const guard = validateModeMapOverrides(
      { lighthouse: { settings: { count: 1 } } },
      shared,
      upstream,
      translations
    )[0];
    expect(guard.status).toBe('NEEDED');
    expect(
      validateModeMapOverrides(
        { lighthouse: { settings: { other: 9 } } },
        { lighthouse: { settings: { count: 2 } } },
        upstream,
        translations
      )[0].status
    ).toBe('FIXED');
    expect(guard.details).toContainEqual(
      expect.objectContaining({ field: 'settings.count', status: 'needed' })
    );
  });

  it('retires redundant scoped additions but preserves empty replacement guards', () => {
    const shared = { lighthouse: { extractsAdd: [addition] } };
    expect(validateModeMapOverrides(shared, shared, maps([]), translations)[0].status).toBe(
      'FIXED'
    );
    expect(
      validateModeMapOverrides(
        { lighthouse: { extractsAdd: [] } },
        shared,
        maps([]),
        translations
      )[0].status
    ).toBe('NEEDED');
  });
});

describe('extract addition supplied values', () => {
  it('retains adopted IDs with differing metadata and unknown values', () => {
    const exact = { ...addition };
    expect(validate([exact])[0].status).toBe('FIXED');
    expect(validate([{ ...exact, position: { ...addition.position, x: 0 } }])[0].status).toBe(
      'NEEDED'
    );
    const result = validateMapOverrides(
      { lighthouse: { extractsAdd: [{ ...addition, future: true }] } },
      maps([exact]),
      translations
    )[0];
    expect(result.status).toBe('NEEDED');
    expect(result.details).toContainEqual(
      expect.objectContaining({ field: `extractsAdd:${addition.id}.future`, status: 'check' })
    );
  });
  it('does not retire a name-only candidate with a different canonical ID', () => {
    expect(validate([{ ...addition, id: 'another-id' }])[0].status).toBe('NEEDED');
  });
});

it('keeps blank known translations unverified instead of matching raw dictionary keys', () => {
  const result = validateMapOverrides(
    {
      lighthouse: {
        name: 'map_name',
        extractsAdd: [{ ...addition, name: 'Scav_Underboat_Hideout' }],
      },
    },
    maps([{ ...addition, name: 'Scav_Underboat_Hideout' }]),
    { map_name: '', Scav_Underboat_Hideout: ' ' }
  )[0];
  expect(result.status).toBe('NEEDED');
  expect(result.details).toContainEqual(
    expect.objectContaining({ field: 'name', status: 'check' })
  );
  expect(result.details).toContainEqual(
    expect.objectContaining({ field: `extractsAdd:${addition.id}.name`, status: 'check' })
  );
});

it('keeps a missing addition unverified without strict errors', () => {
  const result = validate([])[0];
  expect(result.details.some((detail) => detail.status === 'error')).toBe(false);
  for (const field of ['id', 'name'])
    expect(result.details).toContainEqual(
      expect.objectContaining({ field: `extractsAdd:${addition.id}.${field}`, status: 'check' })
    );
});

it('treats scoped extract replacement and partial raw adoption as atomic operations', () => {
  const other = { ...addition, id: 'other', name: 'Other exit' };
  const shared = { lighthouse: { extractsAdd: [addition, other] } };
  const scoped = { lighthouse: { extractsAdd: [addition] } };
  const guarded = validateModeMapOverrides(scoped, shared, maps([]), translations)[0];
  expect(guarded.details.find((detail) => detail.field === 'extractsAdd')?.status).toBe('needed');
  const partial = validateMapOverrides(shared, maps([addition]), translations)[0];
  expect(partial.details.find((detail) => detail.field === 'extractsAdd')?.status).toBe('needed');
  const adopted = validateMapOverrides(shared, maps([addition, other]), translations)[0];
  expect(adopted.details.find((detail) => detail.field === 'extractsAdd')?.status).toBe('fixed');
  const redundant = validateModeMapOverrides(shared, shared, maps([]), translations)[0];
  expect(redundant.details.find((detail) => detail.field === 'extractsAdd')?.status).toBe('fixed');
});
