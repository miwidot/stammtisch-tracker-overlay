import { describe, expect, it } from 'vitest';
import { validateMapOverrides } from '../src/lib/map-validator.js';

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
  it('retires a translated extract with a new canonical ID and coordinates', () => {
    expect(validate()[0]).toMatchObject({ status: 'FIXED', stillNeeded: false });
    expect(validate()[0].details[0]).toMatchObject({
      field: `extractsAdd:${addition.id}`,
      status: 'fixed',
    });
  });

  it('matches a canonical ID even when upstream renamed the extract', () => {
    expect(validate([{ ...extract, id: addition.id, name: 'renamed' }])[0].status).toBe('FIXED');
  });

  it('matches the raw extract name or a synthetic ID used as its name', () => {
    expect(validate([{ ...extract, name: addition.name }])[0].status).toBe('FIXED');
    expect(validate([{ ...extract, name: addition.id }])[0].status).toBe('FIXED');
  });

  it('keeps a genuinely missing extract and does not match another map', () => {
    const apiMaps = maps([]);
    apiMaps.set('other-map', { name: 'other', disabled: false, extracts: [extract] });
    expect(
      validateMapOverrides({ lighthouse: { extractsAdd: [addition] } }, apiMaps, translations)[0]
    ).toMatchObject({ status: 'NEEDED', stillNeeded: true });
  });

  it('reports stale additions within a map that still needs a correction', () => {
    const result = validate([extract], { disabled: true })[0];
    expect(result.status).toBe('NEEDED');
    expect(result.details.map((detail) => detail.status)).toEqual(['needed', 'fixed']);
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

  it('retains a nonempty scoped replacement while allowing its stale entries to retire', () => {
    const result = validateMapOverrides(
      { lighthouse: { extractsAdd: [addition] } },
      maps(),
      translations,
      {
        lighthouse: { extractsAdd: [{ ...addition, id: 'shared-other', name: 'Other exit' }] },
      }
    )[0];
    expect(result).toMatchObject({ status: 'NEEDED', stillNeeded: true });
    expect(result.details.map((detail) => detail.status)).toEqual(['needed', 'fixed']);
  });

  it('still retires a shared addition when a scoped list does not change it', () => {
    const result = validateMapOverrides(
      { lighthouse: { extractsAdd: [addition] } },
      maps(),
      translations,
      {
        lighthouse: { extractsAdd: [addition] },
      }
    )[0];
    expect(result.status).toBe('FIXED');
  });
});
