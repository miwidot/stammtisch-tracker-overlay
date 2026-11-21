import { describe, expect, it } from './test-support.js';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import {
  assertDisjointCounterGroups,
  counterGroups,
  evaluateTaskProgression,
  normalizeTaskStatus,
  type ProgressionCounterDefinition,
  type TaskProgressionOptions,
  type TaskData,
  type TaskUnlockState,
} from '../src/lib/index.js';

const mapping: ProgressionCounterDefinition = {
  revision: 'test-revision',
  verification: 'verified',
  coverage: 'complete',
  derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'b', 'c'] },
  proof: ['https://example.com/verified-rule'],
};
const options: TaskProgressionOptions = {
  mode: 'pve',
  revision: 'test-revision',
  counters: { pve: { pool: mapping } },
};
const task: TaskData = {
  id: 'target',
  name: 'Target',
  trader: { id: 'trader', name: 'Trader' },
  otherRequirements: [
    { id: 'gate', type: 'globalVariable', variableId: 'pool', compareMethod: '>=', value: 2 },
  ],
};
const state: TaskUnlockState = {
  traderUnlocked: { trader: true },
  taskStatuses: { a: 4, b: 'complete', c: 'active' },
};

describe('progress-based task eligibility', () => {
  it('accepts optional pool descriptions without changing legacy evaluation', () => {
    const counters = {
      pve: { pool: { ...mapping, pool: { traderId: 'mechanic', loyaltyLevel: 2 } } },
    };
    expect(evaluateTaskProgression(task, state, { ...options, counters })).toEqual(
      evaluateTaskProgression(task, state, options)
    );
  });
  it.each([
    null,
    {},
    { traderId: '', loyaltyLevel: 2 },
    { traderId: 'm', loyaltyLevel: 0 },
    { traderId: 'm', loyaltyLevel: 5 },
    { traderId: 'm', loyaltyLevel: 2.5 },
    { traderId: 'm', loyaltyLevel: '2' },
    { traderId: 'm', loyaltyLevel: 2, extra: true },
  ])('rejects malformed informational pool metadata at runtime: %j', (pool) => {
    const counters = {
      pve: { pool: { ...mapping, pool } },
    } as unknown as TaskProgressionOptions['counters'];
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });
  it('recomputes verified distinct completions without mutating progress', () => {
    const before = structuredClone(state);
    expect(evaluateTaskProgression(task, state, options)).toMatchObject({
      status: 'available',
      counters: {
        pool: { source: 'tasks', value: 2, completedTaskIds: ['a', 'b'], incompleteTaskIds: ['c'] },
      },
    });
    const changed = { ...state, taskStatuses: { ...state.taskStatuses, b: 'active' } };
    expect(evaluateTaskProgression(task, changed, options)).toMatchObject({
      status: 'blocked',
      counters: { pool: { value: 1 } },
    });
    expect(state).toEqual(before);
  });

  it.each([
    { mode: 'regular' },
    { revision: 'another-patch' },
    { revision: undefined },
    { counters: {} },
  ])('does not borrow a mapping across scope: %j', (override) => {
    expect(
      evaluateTaskProgression(task, state, { ...options, ...override } as TaskProgressionOptions)
        .status
    ).toBe('unknown');
  });

  it.each([
    { verification: 'unresolved' },
    { coverage: 'partial' },
    { proof: [] },
    { proof: ['not a link'] },
    { proof: ['https://example.com/rule', 'https://example.com/rule'] },
    { derivation: { type: 'sum', taskIds: ['a'] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'a'] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: [] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: new Array(2) } },
    { derivation: { type: 'taskGroupCompletions', groups: [] } },
    { derivation: { type: 'taskGroupCompletions', groups: [[]] } },
    { derivation: { type: 'taskGroupCompletions', groups: [['a', 'a']] } },
    {
      derivation: {
        type: 'taskGroupCompletions',
        groups: [
          ['a', 'b'],
          ['b', 'c'],
        ],
      },
    },
    { derivation: { type: 'taskGroupCompletions', groups: [['a'], ['']] } },
    { derivation: { type: 'taskGroupCompletions', groups: ['a', 'b'] } },
    { derivation: { type: 'taskGroupCompletions', taskIds: ['a'] } },
    { derivation: { type: 'taskGroupCompletions', groups: [['a']], taskIds: ['a'] } },
    { unknownSemantics: true },
  ])('fails closed for an incomplete/untrusted rule: %j', (override) => {
    const counters = {
      pve: { pool: { ...mapping, ...override } },
    } as unknown as TaskProgressionOptions['counters'];
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it.each([undefined, 'unsupported', ['complete', 'active'], [], new Array(1)])(
    'does not infer zero for missing or ambiguous history: %j',
    (status) => {
      const incomplete = {
        ...state,
        taskStatuses: { a: 'complete', b: status, c: 'active' },
      } as TaskUnlockState;
      expect(evaluateTaskProgression(task, incomplete, options)).toMatchObject({
        status: 'unknown',
        counters: { pool: { source: 'unresolved', unknownTaskIds: ['b'] } },
      });
    }
  );

  describe('task-group derivations', () => {
    const grouped: TaskProgressionOptions = {
      ...options,
      counters: {
        pve: {
          pool: {
            ...mapping,
            derivation: { type: 'taskGroupCompletions', groups: [['a', 'b'], ['c']] },
          },
        },
      },
    };
    const withStatuses = (taskStatuses: Record<string, unknown>) =>
      ({ ...state, taskStatuses }) as TaskUnlockState;

    it('counts a group once, and only when every member is complete', () => {
      const pair = evaluateTaskProgression(
        task,
        withStatuses({ a: 4, b: 4, c: 'active' }),
        grouped
      );
      expect(pair.counters.pool).toMatchObject({
        source: 'tasks',
        value: 1,
        completedTaskIds: ['a', 'b'],
        incompleteTaskIds: ['c'],
      });
      expect(pair.status).toBe('blocked');
      const half = evaluateTaskProgression(
        task,
        withStatuses({ a: 4, b: 'active', c: 4 }),
        grouped
      );
      expect(half.counters.pool).toMatchObject({
        source: 'tasks',
        value: 1,
        completedTaskIds: ['a', 'c'],
        incompleteTaskIds: ['b'],
      });
      expect(
        evaluateTaskProgression(task, withStatuses({ a: 4, b: 4, c: 4 }), grouped).status
      ).toBe('available');
    });

    it('settles a group with an incomplete member even when a sibling is unknown', () => {
      expect(
        evaluateTaskProgression(task, withStatuses({ b: 'active', c: 4 }), grouped).counters.pool
      ).toMatchObject({ source: 'tasks', value: 1, unknownTaskIds: ['a'] });
      expect(
        evaluateTaskProgression(task, withStatuses({ b: 4, c: 4 }), grouped).counters.pool
      ).toMatchObject({ source: 'unresolved', unknownTaskIds: ['a'] });
    });

    describe('anyOf groups', () => {
      const alternatives: TaskProgressionOptions = {
        ...options,
        counters: {
          pve: {
            pool: {
              ...mapping,
              derivation: { type: 'taskGroupCompletions', groups: [{ anyOf: ['a', 'b'] }, ['c']] },
            },
          },
        },
      };
      const pool = (taskStatuses: Record<string, unknown>) =>
        evaluateTaskProgression(task, withStatuses(taskStatuses), alternatives).counters.pool;

      it('earns one point once any member is complete, never more', () => {
        expect(pool({ a: 4, b: 'active', c: 'active' })).toMatchObject({
          source: 'tasks',
          value: 1,
        });
        expect(pool({ a: 'active', b: 4, c: 4 })).toMatchObject({ source: 'tasks', value: 2 });
        expect(pool({ a: 4, b: 4, c: 'active' })).toMatchObject({ source: 'tasks', value: 1 });
        expect(pool({ a: 'active', b: 'active', c: 4 })).toMatchObject({
          source: 'tasks',
          value: 1,
        });
      });

      it('is settled by a complete member, and unknown while only unknown members could decide', () => {
        expect(pool({ a: 4, c: 'active' })).toMatchObject({
          source: 'tasks',
          value: 1,
          unknownTaskIds: ['b'],
        });
        expect(pool({ a: 'active', c: 4 })).toMatchObject({
          source: 'unresolved',
          unknownTaskIds: ['b'],
        });
      });

      it.each([
        [[{ anyOf: ['a'] }]],
        [[{ anyOf: ['a', 'a'] }]],
        [[{ anyOf: ['a', 'b'], extra: true }]],
        [[{ allOf: ['a', 'b'] }]],
        [[{ anyOf: ['a', 'b'] }, ['b']]],
      ])('rejects a malformed or overlapping anyOf group: %j', (groups) => {
        const derivation = { type: 'taskGroupCompletions', groups };
        expect(counterGroups(derivation)).toBeUndefined();
      });
    });

    it('rejects a source registry that puts one task in two groups', () => {
      const derivation = { type: 'taskGroupCompletions' as const, groups: [['a', 'b'], ['b']] };
      expect(() =>
        assertDisjointCounterGroups({ pve: { pool: { ...mapping, derivation } } })
      ).toThrow('pve/pool: malformed derivation, or a task appears in more than one group');
      expect(() => assertDisjointCounterGroups(grouped.counters!)).not.toThrow();
    });

    it('rejects a source entry whose derivation is only inherited', () => {
      const { derivation, ...rest } = mapping;
      const inherited = Object.assign(Object.create({ derivation }), rest);
      expect(() => assertDisjointCounterGroups({ pve: { pool: inherited } })).toThrow(
        'pve/pool: malformed derivation'
      );
    });
  });

  it('counts synonymous completion statuses once and keeps definite non-completion at zero', () => {
    const supplied = {
      ...state,
      taskStatuses: { a: [4, 'completed'], b: ['active', 'locked'], c: 'failed' },
    };
    expect(evaluateTaskProgression(task, supplied, options).counters.pool.value).toBe(1);
  });

  it('prefers resolved account values without adding computed counts', () => {
    const result = evaluateTaskProgression(
      task,
      { ...state, globalVariables: { pool: 0 } },
      options
    );
    expect(result).toMatchObject({
      status: 'blocked',
      counters: { pool: { source: 'account', value: 0 } },
    });
    expect(
      evaluateTaskProgression(task, { ...state, globalVariables: { pool: 2 } }, { mode: 'pve' })
        .status
    ).toBe('available');
  });

  it.each([NaN, Infinity, null, '2', undefined])(
    'does not replace an invalid explicit value with an inferred one: %j',
    (value) => {
      const supplied = { ...state, globalVariables: { pool: value } } as unknown as TaskUnlockState;
      expect(evaluateTaskProgression(task, supplied, options).status).toBe('unknown');
    }
  );

  it('does not use profile children as a parent value or inherit status entries', () => {
    expect(
      evaluateTaskProgression(task, { ...state, globalVariables: { child: 2 } }, { mode: 'pve' })
        .status
    ).toBe('unknown');
    const taskStatuses = Object.create(state.taskStatuses!);
    expect(evaluateTaskProgression(task, { ...state, taskStatuses }, options).status).toBe(
      'unknown'
    );
  });

  it('does not derive a parent from an inherited mapping', () => {
    const counters = { pve: Object.create({ pool: mapping }) };
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it('does not accept prototype-supplied definition fields', () => {
    const inherited = { pve: { pool: Object.create(mapping) } };
    expect(evaluateTaskProgression(task, state, { ...options, counters: inherited }).status).toBe(
      'unknown'
    );
    const polluted: Record<string, unknown> = Object.assign(
      Object.create({ verification: 'verified' }),
      mapping
    );
    delete polluted.verification;
    const counters = { pve: { pool: polluted } } as unknown as TaskProgressionOptions['counters'];
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it('does not read state or registry containers from a polluted prototype', () => {
    const polluted = {
      globalVariables: { pool: 999 },
      counters: { pve: { pool: mapping } },
      revision: 'test-revision',
      taskStatuses: { a: 'complete', b: 'complete', c: 'complete' },
    };
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      Object.assign(proto, polluted);
      // Only `mode` is supplied; every container must come from own properties.
      const result = evaluateTaskProgression(task, { traderUnlocked: { trader: true } }, {
        mode: 'pve',
      } as TaskProgressionOptions);
      expect(result.status).toBe('unknown');
      expect(result.counters.pool).toMatchObject({ source: 'unresolved' });
      expect(result.counters.pool.value).toBeUndefined();
      expect(result.recordedStatus).toBeUndefined();
    } finally {
      Object.keys(polluted).forEach((key) => delete proto[key]);
    }
    expect(Object.keys(Object.prototype)).toHaveLength(0);
  });

  it('retains other account gates and recorded lifecycle status', () => {
    const supplied = {
      ...state,
      taskStatuses: { ...state.taskStatuses, target: 'active' },
      traderUnlocked: { trader: false },
    };
    expect(evaluateTaskProgression(task, supplied, options)).toMatchObject({
      status: 'blocked',
      recordedStatus: 'active',
    });
    expect(
      evaluateTaskProgression(task, { taskStatuses: state.taskStatuses }, options).status
    ).toBe('unknown');
  });

  it('preserves AND/OR requirements and never marks predecessors complete', () => {
    const gated: TaskData = {
      ...task,
      taskRequirements: [{ task: { id: 'pre', name: 'Previous' }, status: ['active', 'complete'] }],
    };
    const supplied = { ...state, taskStatuses: { ...state.taskStatuses, pre: 'active' } };
    expect(evaluateTaskProgression(gated, supplied, options).status).toBe('available');
    expect(supplied.taskStatuses.pre).toBe('active');
  });

  it('supports BSG equality without changing missing values to zero', () => {
    const equality: TaskData = {
      ...task,
      otherRequirements: [{ ...task.otherRequirements![0], compareMethod: '==', value: 0 }],
    };
    expect(evaluateTaskProgression(equality, state, { mode: 'pve' }).status).toBe('unknown');
    expect(
      evaluateTaskProgression(equality, { ...state, globalVariables: { pool: 0 } }, options).status
    ).toBe('available');
    expect(
      evaluateTaskProgression(equality, { ...state, globalVariables: { pool: 1 } }, options).status
    ).toBe('blocked');
  });
});

describe('lossless task lifecycle statuses', () => {
  const gated: TaskData = {
    ...task,
    otherRequirements: [],
    taskRequirements: [{ task: { id: 'pre', name: 'Previous' }, status: ['active'] }],
  };
  it.each([0, 1, 3, 4, 5, 6, 7, 8, 9, 'availableForStart', 'availableAfter'])(
    'does not treat %s as started',
    (status) => {
      expect(
        evaluateTaskProgression(gated, { ...state, taskStatuses: { pre: status } }, options).status
      ).toBe('blocked');
    }
  );
  it.each([2, 'active', 'started', 'accepted'])('accepts the started state %s', (status) => {
    expect(
      evaluateTaskProgression(gated, { ...state, taskStatuses: { pre: status } }, options).status
    ).toBe('available');
  });
  it('preserves every BSG code and accepts its string form', () => {
    const names = [
      'locked',
      'availableForStart',
      'active',
      'availableForFinish',
      'complete',
      'failed',
      'failedRestartable',
      'markedFailed',
      'expired',
      'availableAfter',
    ];
    names.forEach((name, code) => {
      expect(normalizeTaskStatus(code)).toBe(name);
      expect(normalizeTaskStatus(name)).toBe(name);
    });
  });
});

describe('published counter schema', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../src/schemas/progression-counter.schema.json', import.meta.url), 'utf8')
  );
  const validate = new Ajv({ strict: true }).compile(schema);
  it('allows an empty registry and mode-scoped evidence', () => {
    expect(validate({})).toBe(true);
    expect(
      validate({ pve: { pool: { ...mapping, pool: { traderId: 'mechanic', loyaltyLevel: 2 } } } })
    ).toBe(true);
    expect(validate(options.counters)).toBe(true);
    const derivation = { type: 'taskGroupCompletions', groups: [['a', 'b'], ['c']] };
    expect(validate({ pve: { pool: { ...mapping, derivation } } })).toBe(true);
    const alternatives = { type: 'taskGroupCompletions', groups: [{ anyOf: ['a', 'b'] }, ['c']] };
    expect(validate({ pve: { pool: { ...mapping, derivation: alternatives } } })).toBe(true);
  });
  it.each([
    ...[
      null,
      {},
      { traderId: '', loyaltyLevel: 2 },
      { traderId: 'm', loyaltyLevel: 0 },
      { traderId: 'm', loyaltyLevel: 5 },
      { traderId: 'm', loyaltyLevel: 2.5 },
      { traderId: 'm', loyaltyLevel: '2' },
      { traderId: 'm', loyaltyLevel: 2, extra: true },
    ].map((pool) => ({ pve: { pool: { ...mapping, pool } } })),
    { pvp: { pool: mapping } },
    { pve: { pool: { ...mapping, coverage: 'maybe' } } },
    {
      pve: {
        pool: { ...mapping, derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'a'] } },
      },
    },
    { pve: { pool: { ...mapping, derivation: { type: 'taskGroupCompletions', groups: [] } } } },
    { pve: { pool: { ...mapping, derivation: { type: 'taskGroupCompletions', groups: [[]] } } } },
    {
      pve: {
        pool: { ...mapping, derivation: { type: 'taskGroupCompletions', groups: [['a', 'a']] } },
      },
    },
    {
      pve: {
        pool: { ...mapping, derivation: { type: 'taskGroupCompletions', taskIds: ['a'] } },
      },
    },
    ...[[{ anyOf: ['a'] }], [{ anyOf: ['a', 'a'] }], [{ anyOf: ['a', 'b'], extra: true }]].map(
      (groups) => ({
        pve: { pool: { ...mapping, derivation: { type: 'taskGroupCompletions', groups } } },
      })
    ),
    { pve: { pool: { ...mapping, proof: ['not a link'] } } },
    { pve: { pool: { ...mapping, proof: ['https://example.com/r', 'https://example.com/r'] } } },
  ])('rejects malformed published definitions: %j', (registry) =>
    expect(validate(registry)).toBe(false)
  );
});
