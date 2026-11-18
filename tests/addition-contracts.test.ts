import { describe, expect, it } from './test-support.js';
import {
  validateAdditionContracts,
  type AdditionContractContext,
} from '../src/lib/addition-contracts.js';

const catalog = (values: Record<string, Record<string, unknown>> = {}) =>
  new Map(Object.entries(values));

function context(overrides: Partial<AdditionContractContext> = {}): AdditionContractContext {
  return {
    items: catalog({
      input: { id: 'input', name: 'Input' },
      output: { id: 'output', name: 'Output' },
    }),
    tasks: catalog({ unlock: { id: 'unlock', name: 'Unlock' } }),
    stations: catalog({ station: { id: 'station', levels: [{ level: 1 }, { level: 2 }] } }),
    traders: catalog({ trader: { id: 'trader', name: 'Trader' } }),
    maps: catalog({ map: { id: 'map', name: 'Map' } }),
    categories: catalog({ category: { id: 'category' } }),
    perks: catalog({ perk: { id: 'perk' }, other: { id: 'other' } }),
    ...overrides,
  };
}

function craft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recipe',
    station: 'station',
    level: 2,
    duration: 60,
    requiredItems: [{ item: 'input', count: 1, attributes: { tool: true } }],
    productItem: { item: 'output', count: 2, attributes: {} },
    requiredQuestItems: [],
    gameEditions: [],
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synthetic_task',
    name: 'Task',
    wikiLink: 'https://example.com/task',
    trader: { id: 'trader', name: 'Trader' },
    objectives: [],
    ...overrides,
  };
}

describe('addition contracts', () => {
  it.each([
    ['globalVariable', ['variableId', 'compareMethod', 'value']],
    ['dialogue', ['traders']],
    ['storyObjective', ['storyChapter', 'objective']],
  ])('checks applicable allOf conditional requirements for %s task gates', (type, required) => {
    const result = validateAdditionContracts(
      'tasksAdd',
      { synthetic_task: task({ otherRequirements: [{ id: 'gate', type }] }) },
      context()
    );
    expect(
      result.filter((entry) => entry.status === 'invalid').map((entry) => entry.field)
    ).toEqual((required as string[]).map((field) => `otherRequirements.0.${field}`));
  });

  it('does not apply unrelated conditional task-gate branches', () => {
    const result = validateAdditionContracts(
      'tasksAdd',
      {
        synthetic_task: task({
          otherRequirements: [
            { id: 'gate', type: 'globalVariable', variableId: 'v', compareMethod: '>=', value: 0 },
          ],
        }),
      },
      context()
    );
    expect(result.filter((entry) => entry.status === 'invalid')).toEqual([]);
    expect(
      validateAdditionContracts(
        'tasksAdd',
        { synthetic_task: task({ otherRequirements: [{ id: 'gate' }] }) },
        context()
      )
        .filter((entry) => entry.status === 'invalid')
        .map((entry) => entry.field)
    ).toEqual(['otherRequirements.0.type']);
  });

  it('requires complete replacement-array gates inside partial task patches', () => {
    const result = validateAdditionContracts(
      'tasksAdd',
      { task: { otherRequirements: [{ id: 'gate', type: 'globalVariable' }] } },
      context({ partial: true })
    );
    expect(
      result.filter((entry) => entry.status === 'invalid').map((entry) => entry.field)
    ).toEqual([
      'otherRequirements.0.variableId',
      'otherRequirements.0.compareMethod',
      'otherRequirements.0.value',
    ]);
  });
  it('accepts raw crafts without requiring the entire stale upstream recipe format', () => {
    const crafts = catalog({ older: { ...craft(), extraOldField: 'old' } });
    expect(
      validateAdditionContracts('craftsAdd', { recipe: craft() }, context({ crafts }))
    ).toEqual([]);
  });

  it('checks raw craft references, station levels, positive finite integers and tool booleans', () => {
    const result = validateAdditionContracts(
      'craftsAdd',
      {
        recipe: craft({
          station: 'missing',
          level: 2,
          duration: 0,
          requiredItems: [{ item: 'unknown', count: Infinity, attributes: { tool: 'true' } }],
          productItem: { item: { id: 'output' }, count: 0 },
          taskUnlock: 'unknown_task',
        }),
      },
      context()
    );
    expect(
      result.filter((entry) => entry.status === 'invalid').map((entry) => entry.field)
    ).toEqual(
      expect.arrayContaining([
        'station',
        'duration',
        'requiredItems.0.item',
        'requiredItems.0.count',
        'requiredItems.0.attributes.tool',
        'productItem.item',
        'productItem.count',
        'taskUnlock',
      ])
    );
    expect(
      validateAdditionContracts('craftsAdd', { recipe: craft({ level: 3 }) }, context())
    ).toEqual([expect.objectContaining({ field: 'level', status: 'invalid' })]);
  });

  it('does not infer a station maximum when its level list is unavailable', () => {
    const result = validateAdditionContracts(
      'craftsAdd',
      { recipe: craft() },
      context({
        stations: catalog({ station: { id: 'station', levels: [{ id: 'opaque' }] } }),
      })
    );
    expect(result).toEqual([expect.objectContaining({ field: 'level', status: 'unverified' })]);
  });

  it('preserves unknown task unlocks as unverified and permits overlay item/task aliases', () => {
    expect(
      validateAdditionContracts(
        'craftsAdd',
        {
          recipe: craft({ taskUnlock: null }),
        },
        context()
      )
    ).toEqual([expect.objectContaining({ field: 'taskUnlock', status: 'unverified' })]);
    const union = context({
      items: catalog({ input: {}, output: {} }),
      tasks: catalog({ overlay_alias: {} }),
    });
    expect(
      validateAdditionContracts(
        'craftsAdd',
        {
          recipe: craft({ taskUnlock: 'overlay_alias' }),
        },
        union
      )
    ).toEqual([]);
  });

  it('models the union of raw fields across the same item family including nullable fields', () => {
    const items = catalog({
      first: { id: 'first', name: 'First', weight: 1, properties: { slots: [{ name: 'slot' }] } },
      second: { id: 'second', name: 'Second', properties: { capacity: 2 }, imageLink: null },
      third: { id: 'third', name: 'Third', imageLink: 'https://example.com/item.png' },
    });
    const valid = {
      id: 'added',
      name: 'Added',
      weight: 2,
      imageLink: null,
      properties: { capacity: 3, slots: [{ name: 'new slot' }] },
    };
    expect(validateAdditionContracts('itemsAdd', { added: valid }, context({ items }))).toEqual([]);
    const invalid = { ...valid, weight: 'heavy', properties: { capacity: 'large' } };
    expect(validateAdditionContracts('itemsAdd', { added: invalid }, context({ items }))).toEqual([
      expect.objectContaining({ field: 'weight', status: 'invalid' }),
      expect.objectContaining({ field: 'properties.capacity', status: 'invalid' }),
    ]);
  });

  it('reports each unknown leaf, including extensions and empty containers, as unverified', () => {
    const result = validateAdditionContracts(
      'itemsAdd',
      {
        added: {
          id: 'added',
          name: 'Added',
          provenance: { source: 'capture', version: 1 },
          future: [{ value: true }],
          empty: [],
        },
      },
      context()
    );
    expect(result.map((entry) => [entry.field, entry.status])).toEqual([
      ['provenance.source', 'unverified'],
      ['provenance.version', 'unverified'],
      ['future.0.value', 'unverified'],
      ['empty', 'unverified'],
    ]);
  });

  it('does not use all-null fields or empty upstream arrays as proof of the supplied type', () => {
    const items = catalog({
      existing: { id: 'existing', name: 'Existing', future: null, values: [] },
    });
    const result = validateAdditionContracts(
      'itemsAdd',
      {
        added: { id: 'added', name: 'Added', future: { value: 3 }, values: ['new'] },
      },
      context({ items })
    );
    expect(result.map((entry) => [entry.field, entry.status])).toEqual([
      ['future.value', 'unverified'],
      ['values.0', 'unverified'],
    ]);
  });

  it('checks known display field types even when no upstream record exposes them', () => {
    expect(
      validateAdditionContracts(
        'itemsAdd',
        {
          added: {
            id: 'added',
            name: 42,
            shortName: false,
            description: [],
          },
        },
        context({ items: catalog() })
      ).map((entry) => entry.field)
    ).toEqual(['name', 'shortName', 'description']);
  });

  it('validates adapted task references while preserving synthetic identities and task-add aliases', () => {
    const additions = {
      synthetic_task: task({
        map: { id: 'map', name: 'Map' },
        objectives: [
          {
            id: 'own_obj',
            type: 'giveItem',
            description: 'Give',
            count: 1,
            items: [{ id: 'input', name: 'Input' }],
            maps: [{ id: 'map', name: 'Map' }],
          },
        ],
        taskRequirements: [{ task: { id: 'next_task', name: 'Next' }, status: ['complete'] }],
        finishRewards: { items: [{ count: 2, item: { id: 'output', name: 'Output' } }] },
      }),
      next_task: task({ id: 'next_task' }),
    };
    expect(validateAdditionContracts('tasksAdd', additions, context())).toEqual([]);
    const broken = task({
      trader: { id: 'missing', name: 'Trader' },
      map: 'map',
      finishRewards: { items: [{ count: 1, item: { id: 'missing', name: 'Input' } }] },
    });
    expect(
      validateAdditionContracts('tasksAdd', { synthetic_task: broken }, context()).map(
        (entry) => entry.field
      )
    ).toEqual(expect.arrayContaining(['trader.id', 'map', 'finishRewards.items.0.item.id']));
  });

  it('checks missing catalogs without declaring their references invalid', () => {
    const result = validateAdditionContracts(
      'tasksAdd',
      {
        synthetic_task: task({ trader: { id: 'trader', name: 'Trader' } }),
      },
      context({ traders: undefined })
    );
    expect(result).toEqual([expect.objectContaining({ field: 'trader.id', status: 'unverified' })]);
  });

  it('checks every seasonal raw field without guessing builtin effect/skill catalogs', () => {
    const result = validateAdditionContracts(
      'seasonalPerks',
      {
        perk: {
          id: 'perk',
          effects: [
            {
              effectId: 'builtin_effect',
              multiplicator: 1.2,
              skillIds: ['Crafting'],
              itemFilter: { allowedItems: ['input'], allowedCategories: ['category'] },
            },
          ],
        },
      },
      context()
    );
    expect(result.map((entry) => [entry.field, entry.status])).toEqual([
      ['effects.0.effectId', 'unverified'],
      ['effects.0.multiplicator', 'unverified'],
      ['effects.0.skillIds.0', 'unverified'],
    ]);
  });

  it('rejects malformed seasonal effects and unknown exposed filter references', () => {
    const result = validateAdditionContracts(
      'seasonalPerks',
      {
        perk: {
          id: 'perk',
          effects: [
            {
              effectId: 'stub',
              multiplicator: 'fast',
              intValue: 1.5,
              itemFilter: { allowedItems: ['missing'], excludedCategories: ['missing'] },
            },
          ],
        },
      },
      context()
    );
    expect(
      result.filter((entry) => entry.status === 'invalid').map((entry) => entry.field)
    ).toEqual([
      'effects.0.effectId',
      'effects.0.multiplicator',
      'effects.0.intValue',
      'effects.0.itemFilter.allowedItems.0',
      'effects.0.itemFilter.excludedCategories.0',
    ]);
  });

  it('reports opaque craft fields instead of accepting objects without evidence', () => {
    const result = validateAdditionContracts(
      'craftsAdd',
      {
        recipe: craft({
          requiredQuestItems: [{ questItem: 'quest_template', count: 1 }],
          gameEditions: ['edition'],
        }),
      },
      context()
    );
    expect(
      result.filter((entry) => entry.status === 'unverified').map((entry) => entry.field)
    ).toEqual(
      expect.arrayContaining(['requiredQuestItems.0.questItem', 'requiredQuestItems.0.count'])
    );
  });

  it('accepts partial item and ID-keyed task objective patches while checking supplied values', () => {
    const partial = context({ partial: true });
    expect(
      validateAdditionContracts('itemsAdd', { input: { shortName: 'Input' } }, partial)
    ).toEqual([]);
    const valid = {
      objectives: { objective_id: { count: 2 } },
      objectivesAdd: [
        {
          id: 'new_obj',
          description: 'Give',
          type: 'giveItem',
          items: [{ id: 'input', name: 'Input' }],
        },
      ],
    };
    expect(validateAdditionContracts('tasksAdd', { unlock: valid }, partial)).toEqual([]);
    const result = validateAdditionContracts(
      'tasksAdd',
      {
        unlock: {
          objectives: { objective_id: { count: 0, items: [{ id: 'missing' }] } },
        },
      },
      partial
    );
    expect(result.map((entry) => entry.field)).toEqual([
      'objectives.objective_id.count',
      'objectives.objective_id.items.0.id',
    ]);
  });

  it('requires addition fields and matching identities only for complete additions', () => {
    expect(
      validateAdditionContracts('itemsAdd', { added: { id: 'different' } }, context()).map(
        (entry) => entry.field
      )
    ).toEqual(['id', 'name']);
    expect(validateAdditionContracts('craftsAdd', { recipe: null }, context())).toEqual([
      expect.objectContaining({ field: 'entity', status: 'invalid' }),
    ]);
  });

  it('does not turn reference-only overlay records into evidence for invented field types', () => {
    const additions = {
      first: { id: 'first', name: 'First', invented: true },
      second: { id: 'second', name: 'Second', invented: 'different shape' },
    };
    const result = validateAdditionContracts(
      'itemsAdd',
      additions,
      context({
        itemsAdd: catalog(additions),
      })
    );
    expect(result.map((entry) => [entry.id, entry.field, entry.status])).toEqual([
      ['first', 'invented', 'unverified'],
      ['second', 'invented', 'unverified'],
    ]);
    expect(
      validateAdditionContracts(
        'craftsAdd',
        {
          recipe: craft({ productItem: { item: 'first', count: 1 }, taskUnlock: 'alias' }),
        },
        context({
          itemsAdd: catalog(additions),
          tasksAdd: catalog({ alias: { id: 'added_task' } }),
        })
      )
    ).toEqual([]);
  });

  it('distinguishes unresolved raw game filters from consumer item references', () => {
    const template = '6ab60a4d5c0779ba1e0aabad';
    const result = validateAdditionContracts(
      'seasonalPerks',
      {
        perk: {
          id: 'perk',
          effects: [
            {
              effectId: 'builtin',
              itemFilter: {
                allowedItems: [template],
                excludedCategories: [template],
              },
            },
          ],
        },
      },
      context()
    );
    expect(
      result.filter((entry) => entry.field.includes('itemFilter')).map((entry) => entry.status)
    ).toEqual(['unverified', 'unverified']);
    expect(
      validateAdditionContracts(
        'craftsAdd',
        {
          recipe: craft({
            productItem: { item: template, count: 1 },
          }),
        },
        context()
      )
    ).toEqual([expect.objectContaining({ field: 'productItem.item', status: 'invalid' })]);
  });

  it('checks actual seasonal exclusions and preserves the legacy field as an extension', () => {
    const result = validateAdditionContracts(
      'seasonalPerks',
      {
        perk: {
          id: 'perk',
          effects: [{ effectId: 'builtin' }],
          exclusiveToPerks: ['missing'],
          mutuallyExclusiveSeasonalPerkIds: ['other'],
        },
      },
      context()
    );
    expect(result).toEqual([
      expect.objectContaining({ field: 'effects.0.effectId', status: 'unverified' }),
      expect.objectContaining({ field: 'exclusiveToPerks.0', status: 'invalid' }),
      expect.objectContaining({
        field: 'mutuallyExclusiveSeasonalPerkIds.0',
        status: 'unverified',
      }),
    ]);
  });

  it('enforces finite inferred numeric fields and complete adapted map references', () => {
    expect(
      validateAdditionContracts(
        'itemsAdd',
        {
          added: {
            id: 'added',
            name: 'Added',
            weight: Infinity,
          },
        },
        context({ items: catalog({ existing: { id: 'existing', name: 'Existing', weight: 1 } }) })
      )
    ).toEqual([expect.objectContaining({ field: 'weight', status: 'invalid' })]);
    expect(
      validateAdditionContracts('tasksAdd', { synthetic_task: task({ map: {} }) }, context()).map(
        (entry) => entry.field
      )
    ).toEqual(['map.id', 'map.name']);
  });

  it('enforces trader loyalty semantics while permitting supplied partial threshold fields', () => {
    const invalid = task({
      traderRequirements: [
        {
          id: 'overlay.000000000000000000000000.111111111111111111111111.level.>=.1',
          requirementType: 'level',
          compareMethod: '=',
          value: 5,
          trader: { id: 'trader', name: 'Trader' },
        },
      ],
    });
    expect(
      validateAdditionContracts('tasksAdd', { synthetic_task: invalid }, context()).map(
        (entry) => entry.field
      )
    ).toEqual(['traderRequirements.0.value', 'traderRequirements.0.compareMethod']);
    expect(
      validateAdditionContracts(
        'tasksAdd',
        {
          unlock: {
            traderRequirements: [{ requirementType: 'level', value: 2 }],
          },
        },
        context({ partial: true })
      )
    ).toEqual([]);
  });
  it('reports empty opaque quest objects and edition IDs as unverified', () => {
    expect(
      validateAdditionContracts(
        'craftsAdd',
        {
          recipe: craft({
            requiredQuestItems: [{}],
            gameEditions: ['edition'],
          }),
        },
        context()
      ).map((entry) => [entry.field, entry.status])
    ).toEqual([
      ['requiredQuestItems.0', 'unverified'],
      ['gameEditions.0', 'unverified'],
    ]);
  });

  it('rejects empty reference IDs even when the target catalog is unavailable', () => {
    expect(
      validateAdditionContracts(
        'tasksAdd',
        {
          synthetic_task: task({
            trader: { id: '', name: 'Trader' },
          }),
        },
        context({ traders: undefined })
      )
    ).toEqual([expect.objectContaining({ field: 'trader.id', status: 'invalid' })]);
  });

  it('does not widen declared adapted references when an upstream example uses a raw shape', () => {
    const upstream = catalog({
      raw: {
        id: 'raw',
        trader: 'trader',
        objectives: [{ type: 'giveItem', items: ['input'] }],
      },
    });
    const result = validateAdditionContracts(
      'tasksAdd',
      {
        synthetic_task: task({
          trader: 'trader',
          objectives: [
            { id: 'objective', type: 'giveItem', description: 'Give', items: ['input'] },
          ],
        }),
      },
      context({ tasks: upstream })
    );
    expect(result.map((entry) => [entry.field, entry.status])).toEqual([
      ['trader', 'invalid'],
      ['objectives.0.items.0', 'invalid'],
    ]);
  });
});

it('checks requirement merge IDs against the published literal pattern', () => {
  const diagnostics = validateAdditionContracts(
    'tasksAdd',
    {
      task: {
        traderRequirements: [
          {
            id: 'invalid_merge_id',
            trader: { id: 'trader', name: 'Trader' },
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
          },
        ],
      },
    },
    context({ partial: true })
  );
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: 'traderRequirements.0.id', status: 'invalid' }),
    ])
  );
});

it('accepts placeholder-task synthetic merge IDs under the published literal pattern', () => {
  const diagnostics = validateAdditionContracts(
    'tasksAdd',
    {
      placeholder_some_quest: {
        traderRequirements: [
          {
            id: 'overlay.placeholder_some_quest.54cb50c76803fa8b248b4571.level.>=.2',
            trader: { id: 'trader', name: 'Trader' },
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
          },
        ],
      },
    },
    context({ partial: true })
  );
  expect(diagnostics).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ field: 'traderRequirements.0.id' })])
  );
});
