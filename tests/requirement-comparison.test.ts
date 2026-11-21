import { describe, expect, it } from './test-support.js';
import { compareRequirementValues } from '../src/lib/requirement-comparison.js';

const a = { task: { id: 'a', name: 'A' }, provenance: 'first' };
const b = { task: { id: 'b', name: 'B' } };
const c = { task: { id: 'c', name: 'C' } };

function compareGroups(patch: unknown[], source: unknown[]) {
  return compareRequirementValues('taskRequirementGroups', patch, source);
}

describe('requirement group comparison', () => {
  it('keeps conflicting semantically equivalent upstream groups unverified', () => {
    const rows = compareGroups(
      [[a, b]],
      [
        [a, b],
        [{ ...a, provenance: 'other' }, b],
      ]
    );
    expect(rows[0].status).toBe('unverified');
    expect(rows).toContainEqual(
      expect.objectContaining({
        field: 'taskRequirementGroups[0][0].provenance',
        status: 'unverified',
      })
    );
  });

  it('accepts duplicate equivalent groups with reordered and repeated members', () => {
    const rows = compareGroups(
      [[a, b, a]],
      [
        [b, a],
        [a, b],
      ]
    );
    expect(rows.every((row) => row.status === 'same')).toBe(true);
  });

  it('does not borrow matching members from non-equivalent groups', () => {
    const rows = compareGroups([[a, b]], [[a, c], [b]]);
    expect(rows[0].status).toBe('unverified');
    expect(rows).toContainEqual(
      expect.objectContaining({
        field: 'taskRequirementGroups[0][0].provenance',
        status: 'unverified',
      })
    );
  });

  it('reports contradictory supplied values within a unique matching group', () => {
    const rows = compareGroups([[a, b]], [[{ ...a, provenance: 'other' }, b]]);
    expect(rows[0].status).toBe('different');
    expect(rows).toContainEqual(
      expect.objectContaining({
        field: 'taskRequirementGroups[0][0].provenance',
        status: 'different',
      })
    );
  });

  it('matches groups using canonical unordered status sets', () => {
    const patch = { ...a, status: ['accepted', 'completed', 'accepted'] };
    const source = { ...a, status: ['complete', 'active'] };
    const rows = compareGroups([[patch, b]], [[b, source]]);
    expect(rows.every((row) => row.status === 'same')).toBe(true);
  });
});
