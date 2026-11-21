/** Guards raw seasonal effect supplements without duplicating upstream metadata. */
import { describe, expect, it } from './test-support.js';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJsonFile,
  type SeasonalPerk,
} from '../src/lib/index.js';

const { srcDir } = getProjectPaths();
const perks = loadAllJson5FromDir(join(srcDir, 'additions'), false).seasonalPerks as Record<
  string,
  SeasonalPerk
>;
const validate = new Ajv().compile(
  loadJsonFile(join(srcDir, 'schemas', 'seasonal-perk.schema.json'))
);

describe('seasonal perk effect supplements', () => {
  it('retains the meaningful captured effects', () => {
    expect(Object.keys(perks)).toHaveLength(37);
    expect(perks['69c41a86383fc5c9ad03f3d5'].effects).toContainEqual({
      effectId: 'craft_time_multiplicator',
      multiplicator: 0.87,
    });
  });

  it('matches every object key to its id', () => {
    for (const [key, perk] of Object.entries(perks)) expect(perk.id, key).toBe(key);
  });

  it('ships only meaningful effects without upstream metadata', () => {
    for (const [key, perk] of Object.entries(perks)) {
      expect(Object.keys(perk).sort(), key).toEqual(['effects', 'id']);
      expect(perk.effects.length, key).toBeGreaterThan(0);
      for (const effect of perk.effects) {
        expect(effect.effectId, key).not.toBe('stub');
        expect(effect.effectId.length, key).toBeGreaterThan(0);
      }
    }
    expect(validate(perks), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects duplicated metadata, missing/empty effects and stub effects', () => {
    const id = '69c41a86383fc5c9ad03f3d5';
    for (const field of [
      'name',
      'type',
      'description',
      'points',
      'mutuallyExclusiveSeasonalPerkIds',
    ]) {
      expect(validate({ [id]: { ...perks[id], [field]: 'duplicate' } }), field).toBe(false);
    }
    for (const entry of [{ id }, { id, effects: [] }, { id, effects: [{ effectId: 'stub' }] }]) {
      expect(validate({ [id]: entry })).toBe(false);
    }
  });
});
