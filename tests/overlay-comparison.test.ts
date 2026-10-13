import { describe, expect, it } from 'vitest';
import { compareOverlayFields, comparisonSummary } from '../src/lib/overlay-comparison.cjs';

function row(patch: unknown, upstream: unknown, field: string) {
  const detail = compareOverlayFields(patch, upstream).find((entry) => entry.field === field);
  expect(detail, `Missing diagnostic for ${field}`).toBeDefined();
  return detail!;
}

describe('compareOverlayFields', () => {
  it('reports craft duration, counts, attributes and tools independently', () => {
    const patch = {
      duration: 120,
      requiredItems: [
        { item: 'screw', count: 3, attributes: { foundInRaid: false }, tool: true },
        { item: 'wire', count: 2 },
      ],
    };
    const upstream = {
      duration: 60,
      requiredItems: [
        { item: 'wire', count: 2, name: 'Wire' },
        { item: { id: 'screw' }, count: 1, attributes: { foundInRaid: true }, tool: false },
      ],
      station: 'workbench',
    };
    const details = compareOverlayFields(patch, upstream);
    expect(details.find((entry) => entry.field === 'duration')?.status).toBe('different');
    for (const field of ['count', 'attributes.foundInRaid', 'tool']) {
      expect(details.find((entry) => entry.field === `requiredItems[0].${field}`)?.status).toBe(
        'different'
      );
    }
    expect(details.find((entry) => entry.field === 'requiredItems[1].count')?.status).toBe('same');
    expect(details.some((entry) => entry.field === 'station')).toBe(false);
  });

  it('aligns reordered recipes, item references and effect IDs', () => {
    const patch = {
      recipes: [
        { id: 'b', duration: 120 },
        { id: 'a', duration: 60 },
      ],
      effects: [
        { effectId: 'e2', value: 0 },
        { effectId: 'e1', value: false },
      ],
      items: [{ item: { id: 'x' }, count: 2 }],
    };
    const upstream = {
      recipes: [
        { id: 'a', duration: 60 },
        { id: 'b', duration: 120 },
      ],
      effects: [
        { effectId: 'e1', value: false },
        { effectId: 'e2', value: 0 },
      ],
      items: [{ item: { id: 'x', name: 'X' }, count: 2 }],
    };
    expect(compareOverlayFields(patch, upstream).every((entry) => entry.status === 'same')).toBe(
      true
    );
    expect(row(patch, upstream, 'recipes[0].duration').upstreamValue).toBe(120);
  });

  it('compares object patches as subsets without discarding absent nested fields', () => {
    const patch = { properties: { count: 0, missing: { optional: false } } };
    const upstream = { properties: { count: 0, untouched: true } };
    expect(row(patch, upstream, 'properties.count').status).toBe('same');
    expect(row(patch, upstream, 'properties.missing.optional').status).toBe('unverified');
    expect(row(patch, upstream, 'properties').status).toBe('unverified');
  });

  it('compares ID-keyed objective patches against API arrays without requiring every objective', () => {
    const patch = { objectives: { b: { count: 2 }, absent: { optional: false } } };
    const upstream = {
      objectives: [
        { id: 'a', count: 1 },
        { id: 'b', count: 2, optional: true },
      ],
    };
    expect(row(patch, upstream, 'objectives.b.count').status).toBe('same');
    expect(row(patch, upstream, 'objectives.absent.optional').status).toBe('unverified');
    expect(row(patch, upstream, 'objectives').status).toBe('unverified');
  });

  it('compares partial nested dictionaries and preserves upstream-only records', () => {
    const patch = { counters: { a: { count: 2 } } };
    const upstream = { counters: { a: { count: 2, label: 'A' }, b: { count: 1 } } };
    expect(compareOverlayFields(patch, upstream).every((entry) => entry.status === 'same')).toBe(
      true
    );
    expect(upstream.counters.b).toEqual({ count: 1 });
    expect(
      compareOverlayFields(patch, upstream).some((entry) => entry.field.includes('label'))
    ).toBe(false);
  });

  it.each([
    [{ value: [] }, { value: [] }, 'same'],
    [{ value: [] }, { value: {} }, 'different'],
    [{ value: {} }, { value: [] }, 'different'],
    [{ value: {} }, { value: {} }, 'same'],
    [{ value: null }, { value: 0 }, 'different'],
    [{ value: false }, { value: 0 }, 'different'],
    [{ value: 0 }, { value: '0' }, 'different'],
    [{ value: '' }, { value: null }, 'different'],
    [{ value: [] }, {}, 'unverified'],
    [{ value: {} }, {}, 'unverified'],
    [{ value: false }, {}, 'unverified'],
    [{ value: null }, {}, 'unverified'],
  ])('preserves empty, null, false and zero distinctions: %j / %j', (patch, upstream, status) => {
    expect(row(patch, upstream, 'value').status).toBe(status);
  });

  it('checks unordered primitive membership, cardinality, types and duplicates', () => {
    expect(row({ values: [1, '1', false] }, { values: [false, '1', 1] }, 'values').status).toBe(
      'same'
    );
    expect(row({ values: [1, 1] }, { values: [1] }, 'values').status).toBe('different');
    expect(row({ values: [1] }, { values: ['1'] }, 'values').status).toBe('different');
    expect(row({ values: [] }, { values: [1] }, 'values').status).toBe('different');
  });

  it('does not retire array replacements while upstream has additional or missing records', () => {
    const patch = { recipes: [{ id: 'a', count: 1 }] };
    expect(
      row(
        patch,
        {
          recipes: [
            { id: 'a', count: 1 },
            { id: 'b', count: 2 },
          ],
        },
        'recipes'
      ).status
    ).toBe('different');
    expect(row(patch, { recipes: [{ id: 'b', count: 1 }] }, 'recipes').status).toBe('different');
    expect(row(patch, { recipes: [{ id: 'b', count: 1 }] }, 'recipes[0].count').status).toBe(
      'unverified'
    );
  });

  it('does not match repeated or ambiguous identities to an arbitrary record', () => {
    const patch = {
      entries: [
        { id: 'a', count: 2 },
        { id: 'a', count: 1 },
      ],
    };
    const upstream = {
      entries: [
        { id: 'a', count: 1 },
        { id: 'a', count: 2 },
      ],
    };
    expect(row(patch, upstream, 'entries').status).toBe('unverified');
    expect(row(patch, upstream, 'entries[0].count').status).toBe('unverified');
    expect(
      row(
        { objectives: { a: { count: 1 } } },
        { objectives: upstream.entries },
        'objectives.a.count'
      ).status
    ).toBe('unverified');
  });

  it('keeps nested diagnostics unverified when array alignment is unavailable', () => {
    const patch = { requirements: [{ count: 2, attributes: { tool: true } }] };
    const upstream = { requirements: [{ count: 1, attributes: { tool: false } }] };
    expect(row(patch, upstream, 'requirements').status).toBe('different');
    expect(row(patch, upstream, 'requirements[0].attributes.tool').status).toBe('unverified');
  });

  it('reports unavailable entities and records without false sameness', () => {
    const patch = { duration: 0, fields: { optional: false }, entries: [{ id: 'a', count: 1 }] };
    const details = compareOverlayFields(patch, undefined);
    expect(details.length).toBeGreaterThan(3);
    expect(details.every((entry) => entry.status === 'unverified')).toBe(true);
    expect(
      compareOverlayFields({ objectives: { a: { count: 1 } } }, undefined).every(
        (entry) => entry.status === 'unverified'
      )
    ).toBe(true);
  });

  it('ignores undefined supplied values while exposing every defined nested value', () => {
    const details = compareOverlayFields(
      { skipped: undefined, nested: { skipped: undefined, zero: 0 } },
      { nested: { zero: 0 } }
    );
    expect(details.map((entry) => entry.field)).toEqual(['nested', 'nested.zero']);
    expect(compareOverlayFields({ skipped: undefined }, {})).toEqual([]);
  });

  it.each([NaN, Infinity, new Date(), () => 1, 1n])(
    'reports non-JSON supplied values as invalid',
    (value) => {
      expect(row({ value }, { value }, 'value').status).toBe('invalid');
    }
  );

  it('propagates invalid nested values to container diagnostics', () => {
    const patch = { entries: [{ id: 'a', count: NaN }] };
    const upstream = { entries: [{ id: 'b', count: 1 }] };
    expect(row(patch, upstream, 'entries[0].count').status).toBe('invalid');
    expect(row(patch, upstream, 'entries').status).toBe('invalid');
    expect(row({ value: { count: NaN } }, undefined, 'value').status).toBe('invalid');
  });

  it('compares empty patches explicitly and never invents missing upstream records', () => {
    expect(compareOverlayFields({}, {})).toMatchObject([{ field: '(root)', status: 'same' }]);
    expect(compareOverlayFields({}, undefined)).toMatchObject([
      { field: '(root)', status: 'unverified' },
    ]);
    expect(compareOverlayFields({ value: {} }, { value: { extra: 1 } })).toMatchObject([
      { field: 'value', status: 'same' },
    ]);
  });

  it('preserves diagnostic values and leaves inputs untouched', () => {
    const patch = Object.freeze({
      duration: 120,
      items: Object.freeze([Object.freeze({ id: 'a', count: 2 })]),
    });
    const upstream = Object.freeze({
      duration: 60,
      items: Object.freeze([Object.freeze({ id: 'a', count: 1 })]),
    });
    expect(row(patch, upstream, 'items[0].count')).toMatchObject({
      overlayValue: 2,
      upstreamValue: 1,
      status: 'different',
    });
    expect(upstream.items[0].count).toBe(1);
  });

  it('reports circular supplied values without recursion failures', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(row({ value }, { value }, 'value.self').status).toBe('invalid');
  });

  it('retains identity diagnostics and visible exclusions', () => {
    const details = compareOverlayFields(
      { id: 'a', metadata: { version: 1 } },
      { id: 'a', metadata: { version: 1 } },
      { identityFields: ['id'], ignoreFields: ['metadata'] }
    );
    expect(details.find((entry) => entry.field === 'id')).toMatchObject({
      status: 'same',
      reason: expect.stringContaining('identity'),
    });
    expect(details.find((entry) => entry.field === 'metadata.version')?.status).toBe('unverified');
    expect(comparisonSummary(details)).toEqual({
      same: 1,
      different: 0,
      unverified: 2,
      invalid: 0,
    });
  });

  it('does not read inherited upstream fields', () => {
    expect(row({ toString: 'value' }, {}, 'toString').status).toBe('unverified');
  });
});

it('rejects sparse overlay arrays and does not prove sparse upstream arrays equal', () => {
  const sparse = new Array(1);
  expect(compareOverlayFields({ values: sparse }, { values: [] })).toContainEqual(
    expect.objectContaining({ field: 'values', status: 'invalid' })
  );
  expect(compareOverlayFields({ values: [] }, { values: sparse })).toContainEqual(
    expect.objectContaining({ field: 'values', status: 'unverified' })
  );
  expect(
    compareOverlayFields({ values: [1] }, { values: sparse }).some((row) => row.status !== 'same')
  ).toBe(true);
});

it('matches dictionary keys in the canonical ID domain instead of nested item IDs', () => {
  const rows = compareOverlayFields(
    { objectives: { item: { count: 3 } } },
    { objectives: [{ id: 'objective', item: { id: 'item' }, count: 3 }] }
  );
  expect(rows.find((row) => row.field === 'objectives.item.count')?.status).toBe('unverified');
  const exact = compareOverlayFields(
    { objectives: { objective: { count: 3 } } },
    { objectives: [{ id: 'objective', item: { id: 'item' }, count: 3 }] }
  );
  expect(exact.every((row) => row.status === 'same')).toBe(true);
});
