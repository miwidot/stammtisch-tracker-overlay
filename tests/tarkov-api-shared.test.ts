import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildItemComparisonIndex,
  fetchCached,
  adaptReward,
  getNextTagVersion,
  isVersionStale,
  mergeTaskOverride,
  readResponseJson,
  resolveReferenceMatrix,
} from '../src/lib/tarkov-api-shared.cjs';

const isolatedGitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function runGit(directory: string, args: string[]) {
  return execFileSync('git', ['-C', directory, ...args], { env: isolatedGitEnv });
}

function createGitRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tarkov-overlay-tags-'));
  runGit(directory, ['init', '--quiet']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['config', 'user.name', 'Test']);
  runGit(directory, ['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'init']);
  return directory;
}

describe('fetchCached', () => {
  it('reuses in-flight requests and evicts rejected entries', async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new Error('boom');
    };

    const first = fetchCached(cache, 'items', load);
    expect(fetchCached(cache, 'items', load)).toBe(first);
    await expect(first).rejects.toThrow('boom');
    expect(cache.has('items')).toBe(false);

    await expect(fetchCached(cache, 'items', load)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('getNextTagVersion', () => {
  it('uses the highest supported tag and ignores lower prereleases', () => {
    const directory = createGitRepo();
    try {
      for (const tag of ['v1.9', 'v1.10.0-rc.2', 'v1.10.0', 'not-a-version']) {
        runGit(directory, ['tag', tag]);
      }

      expect(getNextTagVersion(directory)).toBe('v1.11');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts with v1.0 when no supported tags exist', () => {
    const directory = createGitRepo();
    try {
      expect(getNextTagVersion(directory)).toBe('v1.0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores canonical-looking tags that are not reachable from HEAD', () => {
    const directory = createGitRepo();
    try {
      runGit(directory, ['tag', 'v1.0']);
      runGit(directory, ['checkout', '--quiet', '-b', 'unmerged-release']);
      runGit(directory, ['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'unmerged']);
      runGit(directory, ['tag', 'v99.99']);
      runGit(directory, ['checkout', '--quiet', '-']);

      expect(getNextTagVersion(directory)).toBe('v1.1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('compares large numeric prerelease identifiers without precision loss', () => {
    expect(isVersionStale('1.0.0-rc.9007199254740992', '1.0.0-rc.9007199254740993')).toBe(true);
  });

  it('ignores invalid prerelease identifiers', () => {
    const directory = createGitRepo();
    try {
      for (const tag of ['v1.0', 'v99.99.0-01', 'v99.99.0-123_']) {
        runGit(directory, ['tag', tag]);
      }

      expect(getNextTagVersion(directory)).toBe('v1.1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('resolveReferenceMatrix', () => {
  it('wraps single entries, omits empty groups, and rejects non-array input', () => {
    const resolve = (value: unknown) => (value === 'skip' ? undefined : { id: String(value) });

    expect(resolveReferenceMatrix(['item', ['skip']], resolve)).toEqual([[{ id: 'item' }]]);
    expect(resolveReferenceMatrix('item', resolve)).toBeUndefined();
  });
});

describe('mergeTaskOverride', () => {
  it('merges objective patches without treating special keys as prototype setters', () => {
    const shared = JSON.parse('{"objectives":{"__proto__":{"count":1}}}');
    const modeSpecific = JSON.parse('{"objectives":{"__proto__":{"foundInRaid":true}}}');

    const merged = mergeTaskOverride(shared, modeSpecific) as {
      objectives: Record<string, Record<string, unknown>>;
    };

    expect(Object.hasOwn(merged.objectives, '__proto__')).toBe(true);
    expect(merged.objectives.__proto__).toEqual({ count: 1, foundInRaid: true });
    expect(Object.getPrototypeOf(merged.objectives)).toBe(Object.prototype);
  });
});

describe('adaptReward', () => {
  it('adds explicit names to unresolved trader and map references', () => {
    const compact = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
    const result = adaptReward(
      { traderUnlock: ['missing-trader'], locationUnlock: ['missing-map'] },
      {},
      {
        isRecord: (value): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value),
        compact,
        resolveItemRef: () => undefined,
        resolveTraderRef: (value) => ({ id: String(value) }),
        resolveMapRef: (value) => ({ id: String(value) }),
      }
    ) as {
      traderUnlock: Array<{ id: string; name: string }>;
      locationUnlock: Array<{ id: string; name: string }>;
    };

    expect(result.traderUnlock).toEqual([{ id: 'missing-trader', name: 'Unknown trader' }]);
    expect(result.locationUnlock).toEqual([{ id: 'missing-map', name: 'Unknown map' }]);
  });
});

describe('readResponseJson', () => {
  it('parses native responses and rejects malformed JSON without retry semantics', async () => {
    await expect(readResponseJson(new Response('{"data":{}}'), 'regular/tasks')).resolves.toEqual({
      data: {},
    });
    await expect(readResponseJson(new Response('{'), 'regular/tasks')).rejects.toThrow(
      'Invalid JSON response from tarkov.dev for regular/tasks'
    );
  });

  it('rejects a streamed body after it crosses the configured limit', async () => {
    await expect(readResponseJson(new Response('12345'), 'regular/tasks', 4)).rejects.toThrow(
      'exceeds the 4-byte limit'
    );
  });
});

describe('buildItemComparisonIndex', () => {
  const items = { items: [{ id: 'x', name: 'x Name', weight: 1 }] };
  const itemsEn = { 'x Name': 'Item' };
  it.each([
    { questItems: [{ id: 'q', name: 'q Name' }] },
    {
      questItems: { q: { id: 'q', name: 'q Name' } },
    },
  ])('indexes quest items from arrays and objects', ({ questItems }) => {
    expect(
      buildItemComparisonIndex(items, { questItems }, itemsEn, {
        'q Name': 'Quest',
      }).get('q')
    ).toEqual({ id: 'q', name: 'Quest' });
  });
  it('gives item records precedence over quest records and dictionary names', () => {
    const result = buildItemComparisonIndex(
      items,
      { questItems: [{ id: 'x', name: 'quest Name' }] },
      itemsEn,
      { 'quest Name': 'Quest', 'x Name': 'Dictionary' }
    );
    expect(result.get('x')).toEqual({ id: 'x', name: 'Item', weight: 1 });
  });
  it('omits unresolved record names for unverified comparisons', () => {
    expect(buildItemComparisonIndex(items, { questItems: [] }, {}, {}).get('x')).toEqual({
      id: 'x',
      weight: 1,
    });
  });
  it.each(
    [null, 7, [{ id: 'q' }, { id: 'q' }], [{ name: 'broken' }]].map((questItems) => ({
      questItems,
    }))
  )('rejects invalid quest sources %j', ({ questItems }) => {
    expect(() => buildItemComparisonIndex(items, { questItems }, itemsEn, {})).toThrow(
      'questItems'
    );
  });
  it.each(
    [{}, [], [{ id: 'x' }, { id: 'x' }], [{ id: ' ' }]].map((collection) => ({ collection }))
  )('rejects invalid item sources %j', ({ collection }) => {
    expect(() =>
      buildItemComparisonIndex({ items: collection }, { questItems: [] }, {}, {})
    ).toThrow('items');
  });
  it('accepts an explicitly empty supplemental quest collection', () => {
    expect(buildItemComparisonIndex(items, { questItems: [] }, itemsEn, {}).size).toBe(1);
  });
  it.each([null, [], { key: 7 }].map((translations) => ({ translations })))(
    'rejects malformed translation maps %j',
    ({ translations }) => {
      expect(() => buildItemComparisonIndex(items, { questItems: [] }, translations, {})).toThrow(
        'translations'
      );
    }
  );
});

describe('complete item comparison snapshots', () => {
  it('rejects an absent quest collection rather than establish absence', () => {
    expect(() => buildItemComparisonIndex({ items: [{ id: 'x' }] }, {}, {}, {})).toThrow(
      'questItems'
    );
  });
  it('resolves record fields from either dictionary', () => {
    const result = buildItemComparisonIndex(
      { items: [{ id: 'x', name: 'x Name' }] },
      { questItems: [{ id: 'q', name: 'q Name' }] },
      { 'q Name': 'Quest' },
      { 'x Name': 'Item' }
    );
    expect(result.get('x')).toEqual({ id: 'x', name: 'Item' });
    expect(result.get('q')).toEqual({
      id: 'q',
      name: 'Quest',
    });
  });
  it('does not fabricate dictionary identities from unresolved or blank names', () => {
    const result = buildItemComparisonIndex(
      { items: [{ id: 'x' }] },
      { questItems: [] },
      {
        '0123456789abcdef01234567 Name': '0123456789abcdef01234567 Name',
        '3123456789abcdef01234567 Name': ' ',
        '4123456789abcdef01234567 ShortName': 'Only short name',
      },
      {}
    );
    expect([...result.keys()]).toEqual(['x']);
  });
});

it('enriches dictionary-only items with all usable dictionary fields', () => {
  const result = buildItemComparisonIndex(
    { items: [{ id: 'x' }] },
    { questItems: [] },
    {
      '0123456789abcdef01234567 Name': 'Quest',
      '0123456789abcdef01234567 ShortName': 'Q',
      '0123456789abcdef01234567 Description': 'Description',
    },
    {}
  );
  expect(result.get('0123456789abcdef01234567')).toEqual({
    id: '0123456789abcdef01234567',
    name: 'Quest',
    shortName: 'Q',
    description: 'Description',
  });
});
it('fills missing fields with source dictionary precedence while preserving record values', () => {
  const result = buildItemComparisonIndex(
    { items: [{ id: 'x', description: 'Actual description', shortName: 'x ShortName' }] },
    { questItems: [{ id: 'q' }] },
    {
      'x Name': 'Item',
      'x ShortName': 'I',
      'x Description': 'Wrong description',
      'q Name': 'Wrong quest',
    },
    {
      'x Name': 'Wrong item',
      'q Name': 'Quest',
      'q ShortName': 'Q',
      'q Description': 'Quest description',
    }
  );
  expect(result.get('x')).toEqual({
    id: 'x',
    name: 'Item',
    shortName: 'I',
    description: 'Actual description',
  });
  expect(result.get('q')).toEqual({
    id: 'q',
    name: 'Quest',
    shortName: 'Q',
    description: 'Quest description',
  });
});

it('preserves literal text ending in dictionary field words', () => {
  const result = buildItemComparisonIndex(
    {
      items: [
        { id: '0123456789abcdef01234567', name: 'Display Name', description: 'Full Description' },
      ],
    },
    { questItems: [] },
    {},
    {}
  );
  expect(result.get('0123456789abcdef01234567')).toEqual({
    id: '0123456789abcdef01234567',
    name: 'Display Name',
    description: 'Full Description',
  });
});

it('omits unresolved values tied to a known dictionary key', () => {
  const result = buildItemComparisonIndex(
    { items: [{ id: 'x', name: 'other Name' }] },
    { questItems: [] },
    { 'other Name': 'other Name' },
    {}
  );
  expect(result.get('x')).toEqual({ id: 'x' });
  expect(result.has('other')).toBe(false);
});

it('excludes task names from dictionary-only item identities while preserving real items', () => {
  const result = buildItemComparisonIndex(
    { items: [{ id: 'real' }] },
    {
      tasks: {
        task: { id: '2123456789abcdef01234567' },
        real: { id: 'real' },
        quest: { id: 'quest' },
      },
      questItems: [{ id: 'quest' }],
    },
    { 'real Name': 'Real item' },
    {
      '2123456789abcdef01234567 Name': 'Task title',
      'marathon Name': 'Transition',
      'quest Name': 'Quest item',
      '1123456789abcdef01234567 Name': 'Dictionary item',
    }
  );
  expect(result.has('2123456789abcdef01234567')).toBe(false);
  expect(result.has('marathon')).toBe(false);
  expect(result.get('1123456789abcdef01234567')).toEqual({
    id: '1123456789abcdef01234567',
    name: 'Dictionary item',
  });
  expect(result.get('real')).toEqual({ id: 'real', name: 'Real item' });
  expect(result.get('quest')).toEqual({ id: 'quest', name: 'Quest item' });
});

it('rejects generic dictionary labels while preserving actual nonhex item records', () => {
  const result = buildItemComparisonIndex(
    { items: [{ id: 'customdogtags12345678910', name: 'Dogtag' }] },
    { questItems: [] },
    {},
    { 'marathon Name': 'Transition' }
  );
  expect(result.has('marathon')).toBe(false);
  expect(result.get('customdogtags12345678910')).toEqual({
    id: 'customdogtags12345678910',
    name: 'Dogtag',
  });
});
