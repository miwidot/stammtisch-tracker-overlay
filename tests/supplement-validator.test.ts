import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSupplements } from '../scripts/check-supplements.js';
import {
  validateSeasonalPerks,
  validateProgressionCounters,
} from '../src/lib/supplement-validator.js';

describe('supplement upstream coverage', () => {
  it('checks actual perk IDs and raw effects, never display descriptions', () => {
    const overlay = { perk: { id: 'perk', effects: [{ effectId: 'speed', multiplicator: 2 }] } };
    const unexposed = validateSeasonalPerks(overlay, {
      perks: { personal: [{ id: 'perk', description: '2x speed' }] },
    });
    expect(unexposed).toMatchObject({ actionable: 0, staleProblems: 0 });
    expect(unexposed.messages.join('\n')).toContain('raw effects UNSUPPORTED');
    expect(
      validateSeasonalPerks(overlay, {
        perks: { personal: [{ id: 'perk', effects: [{ effectId: 'speed', multiplicator: 2 }] }] },
      })
    ).toMatchObject({ staleProblems: 1 });
    expect(
      validateSeasonalPerks(overlay, { perks: { personal: [{ id: 'other' }] } })
    ).toMatchObject({ actionable: 1 });
  });
  it('does not retire conflicting or partially adopted effects', () => {
    const overlay = {
      perk: {
        id: 'perk',
        effects: [{ effectId: 'speed', multiplicator: 2 }, { effectId: 'health' }],
      },
    };
    expect(
      validateSeasonalPerks(overlay, {
        perks: { personal: [{ id: 'perk', effects: [{ effectId: 'speed', multiplicator: 3 }] }] },
      })
    ).toMatchObject({ actionable: 1, staleProblems: 0 });
    expect(
      validateSeasonalPerks(overlay, {
        perks: { personal: [{ id: 'perk', effects: [{ effectId: 'speed', multiplicator: 2 }] }] },
      })
    ).toMatchObject({ staleProblems: 1 });
  });
  it('resolves task and variable references without claiming pool membership validation', () => {
    const counters = { counter: { derivation: { taskIds: ['exists', 'missing'] } } };
    const result = validateProgressionCounters(counters, {
      tasks: [
        { id: 'exists', otherRequirements: [{ type: 'globalVariable', variableId: 'counter' }] },
      ],
    });
    expect(result.actionable).toBe(1);
    expect(result.messages.join('\n')).toContain('missing');
    expect(result.messages.join('\n')).toContain('pool membership');
  });
  it('reports unreferenced variables as unverified rather than invalid', () => {
    const result = validateProgressionCounters(
      { counter: { derivation: { taskIds: ['exists'] } } },
      { tasks: [{ id: 'exists' }] }
    );
    expect(result).toMatchObject({ actionable: 0, staleProblems: 0 });
    expect(result.messages.join('\n')).toContain('NOT COMPARABLE variable not referenced');
  });
  it('accepts the live ID-keyed tasks collection', () => {
    expect(
      validateProgressionCounters(
        { counter: { derivation: { taskIds: ['exists'] } } },
        { tasks: { exists: { id: 'exists', otherRequirements: [] } } }
      )
    ).toMatchObject({ actionable: 0 });
  });
  it('rejects duplicate perk IDs and unsupported effect identities', () => {
    expect(() =>
      validateSeasonalPerks({}, { perks: { common: [{ id: 'perk' }], personal: [{ id: 'perk' }] } })
    ).toThrow('Duplicate upstream perk id');
    expect(() =>
      validateSeasonalPerks(
        { perk: { id: 'perk', effects: [{ effectId: 'speed' }] } },
        { perks: { common: [{ id: 'perk', effects: [{ type: 'speed' }] }] } }
      )
    ).toThrow('Expected raw effectId');
  });
  it('rejects changed upstream shapes instead of reporting clean', () => {
    expect(() => validateSeasonalPerks({}, {})).toThrow();
    expect(() => validateProgressionCounters({}, { tasks: [] })).toThrow();
  });
});

describe('supplement coverage orchestration', () => {
  const modes = ['regular', 'pve', 'pvp-season'] as const;
  function counterSource(): string {
    const sourceDir = mkdtempSync(join(tmpdir(), 'supplement-tasks-'));
    mkdirSync(join(sourceDir, 'additions'));
    writeFileSync(
      join(sourceDir, 'additions', 'progressionCounters.json5'),
      JSON.stringify(
        Object.fromEntries(
          modes.map((mode) => [mode, { counter: { derivation: { taskIds: ['exists'] } } }])
        )
      )
    );
    return sourceDir;
  }

  it('reuses the per-mode task snapshots already fetched by the main audit', async () => {
    const sourceDir = counterSource();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchEnvelope = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'endpoints') throw new Error('Duplicate task download');
      return { data: { endpoints: [{ name: 'tasks', path: '/tasks' }] } };
    });
    const tasks = Object.fromEntries(
      modes.map((mode) => [mode, { tasks: [{ id: 'exists', name: 'Task' }] }])
    );
    try {
      expect(await checkSupplements(sourceDir, fetchEnvelope, tasks)).toEqual({
        actionable: 0,
        staleProblems: 0,
      });
      expect(fetchEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      output.mockRestore();
      rmSync(sourceDir, { recursive: true });
    }
  });

  it('fetches independent counter modes concurrently when snapshots are unavailable', async () => {
    const sourceDir = counterSource();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    const fetchEnvelope = async (endpoint: string) => {
      if (endpoint === 'endpoints')
        return { data: { endpoints: [{ name: 'tasks', path: '/tasks' }] } };
      requests.push(endpoint);
      await pending;
      return { data: { tasks: [{ id: 'exists' }] } };
    };
    const run = checkSupplements(sourceDir, fetchEnvelope);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 100 });
    } finally {
      release();
      await run;
      output.mockRestore();
      rmSync(sourceDir, { recursive: true });
    }
  });

  it.each([null, { bad: true }, [null], [{ type: 'globalVariable' }]])(
    'preserves malformed raw counter gates when reusing task snapshots: %j',
    async (otherRequirements) => {
      const sourceDir = counterSource();
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fetchEnvelope = async () => ({
        data: { endpoints: [{ name: 'tasks', path: '/tasks' }] },
      });
      const taskData = Object.fromEntries(
        modes.map((mode) => [
          mode,
          {
            tasks: [{ id: 'exists', otherRequirements }],
          },
        ])
      );
      try {
        await expect(checkSupplements(sourceDir, fetchEnvelope, taskData)).rejects.toThrow(
          'upstream comparison unavailable or malformed'
        );
      } finally {
        output.mockRestore();
        rmSync(sourceDir, { recursive: true });
      }
    }
  );

  it('flags new comparable endpoints and reports discovery failures', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'supplements-'));
    mkdirSync(join(sourceDir, 'additions'));
    writeFileSync(join(sourceDir, 'additions', 'editions.json5'), '{ standard: {} }');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const discovery = async () => ({
        data: { endpoints: [{ name: 'editions', path: '/editions' }] },
      });
      expect(await checkSupplements(sourceDir, discovery)).toEqual({
        actionable: 0,
        staleProblems: 0,
      });
      expect(output.mock.calls.flat().join('\n')).toContain('NEEDS REVIEW');
      const catalogue = async () => ({
        data: { endpoints: [{ name: 'price history', path: '/prices' }] },
      });
      expect(await checkSupplements(sourceDir, catalogue)).toEqual({
        actionable: 0,
        staleProblems: 0,
      });
      await expect(
        checkSupplements(sourceDir, async () => {
          throw new Error('/private/secret/token');
        })
      ).rejects.toThrow('endpoint discovery unavailable or malformed');
      await expect(
        checkSupplements(sourceDir, async () => ({ data: { endpoints: [{}] } }))
      ).rejects.toThrow('endpoint discovery unavailable or malformed');
      writeFileSync(
        join(sourceDir, 'additions', 'seasonalPerks.json5'),
        '{ perk: { id: "perk", effects: [{ effectId: "speed" }] } }'
      );
      await expect(
        checkSupplements(sourceDir, async () => {
          throw new Error('/private/secret/token');
        })
      ).rejects.toThrow('pvp-season: upstream comparison unavailable or malformed');
      await expect(
        checkSupplements(sourceDir, async () => ({ data: { perks: [] } }))
      ).rejects.toThrow('pvp-season: upstream comparison unavailable or malformed');
      expect(output.mock.calls.flat().join('\n')).not.toContain('/private/secret');
    } finally {
      output.mockRestore();
      rmSync(sourceDir, { recursive: true });
    }
  });
});
