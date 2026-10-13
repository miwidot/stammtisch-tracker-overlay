import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkAdditionContracts,
  fetchContractContext,
} from '../scripts/check-addition-contracts.js';
import type { AdditionContractContext } from '../src/lib/addition-contracts.js';

const directories: string[] = [];
function source(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-contracts-'));
  directories.push(dir);
  for (const [file, data] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(data));
  }
  return dir;
}
function context(): AdditionContractContext {
  return {
    items: new Map(),
    tasks: new Map(),
    stations: new Map([['station', { id: 'station', levels: [{ level: 1 }] }]]),
    crafts: new Map(),
    traders: new Map(),
    maps: new Map(),
  };
}
const snapshots = { regular: [], pve: [], 'pvp-season': [] };
afterEach(() => {
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('addition contract CLI integration', () => {
  it('resolves addition aliases across families without letting additions validate their own unknown fields', async () => {
    const dir = source({
      'additions/itemsAdd.json5': { new_item: { id: 'new_item', name: 'New', invented: 123 } },
      'additions/craftsAdd.json5': {
        craft: {
          id: 'craft',
          station: 'station',
          level: 1,
          duration: 10,
          requiredItems: [],
          requiredQuestItems: [],
          gameEditions: [],
          productItem: { item: 'new_item', count: 1, attributes: {} },
        },
      },
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const getContext = vi.fn<typeof fetchContractContext>(async () => context());
    const result = await checkAdditionContracts(dir, snapshots, getContext);
    expect(result.actionable).toBe(0);
    expect(getContext.mock.calls.map(([mode]) => mode)).toEqual(['regular', 'pve', 'pvp-season']);
    expect(output.mock.calls.flat().join('\n')).toContain('new_item.invented: UNVERIFIED');
    expect(output.mock.calls.flat().join('\n')).not.toContain('craft.productItem.item: UNVERIFIED');
  });
  it('validates shared and mode task patches in every applicable mode', async () => {
    const dir = source({
      'overrides/tasks.json5': { task: { minPlayerLevel: 'invalid' } },
      'overrides/modes/pve/tasks.json5': { task: { experience: 'invalid' } },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await checkAdditionContracts(dir, snapshots, async () => context());
    expect(result.actionable).toBe(4);
  });
  it('cannot pass when upstream context acquisition fails', async () => {
    const dir = source({});
    await expect(
      checkAdditionContracts(dir, snapshots, async () => {
        throw new Error('unavailable');
      })
    ).rejects.toThrow('unavailable');
  });
  it('uses the real seasonal catalog only in seasonal mode', async () => {
    const dir = source({
      'additions/seasonalPerks.json5': {
        perk: { id: 'perk', effects: [{ effectId: 'ExperienceRate', value: 1 }] },
      },
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const getContext = vi.fn<typeof fetchContractContext>(async () => context());
    const getPerks = vi.fn(
      async () =>
        new Map([['perk', { id: 'perk', effects: [{ effectId: 'ExperienceRate', value: 1 }] }]])
    );
    const result = await checkAdditionContracts(dir, snapshots, getContext, getPerks);
    expect(result.actionable).toBe(0);
    expect(getPerks).toHaveBeenCalledTimes(1);
    expect(getContext.mock.results.filter((result) => result.type === 'return')).toHaveLength(3);
    const contexts = await Promise.all(getContext.mock.results.map((result) => result.value));
    expect(contexts.map((entry) => entry.perks?.has('perk') ?? false)).toEqual([
      false,
      false,
      true,
    ]);
    expect(output.mock.calls.flat().join('\n')).not.toContain('perk.effects.0');
  });
  it('uses one item source read for the validation index and category catalog', async () => {
    const routes: Record<string, unknown> = {
      'regular/items': { data: { items: { i: { id: 'i' } }, categories: [{ id: 'category' }] } },
      'regular/tasks': { data: { tasks: { t: { id: 't' } }, questItems: [] } },
      'regular/items_en': { data: {} },
      'regular/tasks_en': { data: {} },
      'regular/maps': { data: { maps: { m: { id: 'm' } } } },
      'regular/hideout': { data: [{ id: 'h' }] },
      'regular/crafts': { data: [{ id: 'c' }] },
      'regular/traders': { data: [{ id: 'r' }] },
    };
    const fetch = vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(routes[url.replace('https://json.tarkov.dev/', '')]))
    );
    vi.stubGlobal('fetch', fetch);
    const result = await fetchContractContext('regular', []);
    expect(result.items.has('i')).toBe(true);
    expect(result.categories?.has('category')).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/regular/items'))).toHaveLength(1);
  });
});
