import { describe, expect, it } from './test-support.js';
import { compileNeutralOverlay, overlayStringKey } from '../src/lib/neutral-overlay.js';
import type { OverlayOutput } from '../src/lib/types.js';

const fixture = (sections: Record<string, unknown>): OverlayOutput =>
  ({
    modes: { regular: {}, pve: {}, 'pvp-season': {} },
    ...sections,
    $meta: { version: '1.0', generated: '2026-11-18T00:00:00Z' },
  }) as OverlayOutput;

describe('neutral overlay producer', () => {
  it('keeps identity and mechanical names while separating addition text', () => {
    const source = fixture({
      tasksAdd: {
        quest: { id: 'quest', name: 'Quest', objectives: [{ id: 'step', description: 'Escape' }] },
      },
      extractRequirements: { maps: { map: { exit: { name: 'ex_internal' } } } },
    });
    const output = compileNeutralOverlay(source);
    const task = (output.tasksAdd as Record<string, Record<string, unknown>>).quest!;
    const objectives = task.objectives as Array<Record<string, unknown>>;
    expect(task.id).toBe('quest');
    expect(task.name).toBe('@tt:overlay:/tasks/quest/name');
    expect(objectives[0]).toEqual({
      id: 'step',
      description: '@tt:overlay:/tasks/quest/objectives/step/description',
    });
    expect(output.$strings.en).toEqual({
      '@tt:overlay:/tasks/quest/name': 'Quest',
      '@tt:overlay:/tasks/quest/objectives/step/description': 'Escape',
    });
    expect(output.extractRequirements).toEqual(source.extractRequirements);
    expect(source.tasksAdd?.quest?.name).toBe('Quest');
  });

  it('binds locale-only corrections and localized links without inventing English defaults', () => {
    const output = compileNeutralOverlay(
      fixture({
        locales: {
          de: {
            tasks: {
              quest: {
                name: 'Aufgabe',
                wikiLink: 'https://example.com/de',
                objectives: { step: { description: 'Entkommen' } },
              },
            },
          },
        },
      })
    );
    const key = overlayStringKey(['tasks', 'quest', 'wikiLink']);
    expect(output.$strings.de?.[key]).toBe('https://example.com/de');
    expect(output.$strings.en?.[key]).toBeUndefined();
    expect(output.$localeTargets[key]).toEqual(['tasks', 'quest', 'wikiLink']);
    expect(output.locales).toBeUndefined();
  });

  it('extracts narrative and target display text while preserving status discriminators', () => {
    const output = compileNeutralOverlay(
      fixture({
        storyChapters: {
          chapter: { notes: 'A note', activation: { summary: 'Visit the trader' } },
        },
        tasksAdd: {
          quest: {
            objectives: [
              { id: 'step', targetNames: ['Any boss'], exitStatus: ['ExpBonusmarathon Name'] },
            ],
          },
        },
      })
    );
    expect(output.$strings.en?.['@tt:overlay:/storyChapters/chapter/notes']).toBe('A note');
    expect(output.$strings.en?.['@tt:overlay:/storyChapters/chapter/activation/summary']).toBe(
      'Visit the trader'
    );
    expect(output.$strings.en?.['@tt:overlay:/tasks/quest/objectives/step/targetNames/0']).toBe(
      'Any boss'
    );
    const tasks = output.tasksAdd as Record<
      string,
      { objectives: Array<{ exitStatus: string[] }> }
    >;
    expect(tasks.quest?.objectives[0]?.exitStatus).toEqual(['ExpBonusmarathon Name']);
  });

  it('rejects locale corrections whose semantics cannot be represented by strings', () => {
    expect(() =>
      compileNeutralOverlay(
        fixture({
          locales: { de: { tasks: { quest: { minPlayerLevel: 12 } } } },
        })
      )
    ).toThrow('Unsupported locale correction at /tasks/quest/minPlayerLevel');
    expect(() =>
      compileNeutralOverlay(
        fixture({
          locales: { de: { tasks: { quest: { imageLink: 'https://example.com/image' } } } },
        })
      )
    ).toThrow('Unsupported locale correction at /tasks/quest/imageLink');
  });

  it('preserves shared and mode-specific extract addition names used for identity matching', () => {
    const extractsAdd = [
      { id: 'exit', name: 'ex_internal', faction: 'pmc', position: { x: 0, y: 0, z: 0 } },
    ];
    const output = compileNeutralOverlay(
      fixture({
        maps: { map: { name: 'Display map', extractsAdd } },
        modes: { regular: {}, pve: { maps: { map: { extractsAdd } } }, 'pvp-season': {} },
      })
    );
    expect((output.maps as Record<string, unknown>).map).toEqual({
      name: '@tt:overlay:/maps/map/name',
      extractsAdd,
    });
    expect((output.modes as Record<string, unknown>).pve).toEqual({
      maps: { map: { extractsAdd } },
    });
    expect(Object.values(output.$strings.en!)).toEqual(['Display map']);
  });

  it('separates mode defaults and uses stable objective identities across reordering', () => {
    const chapter = (ids: string[]) => ({
      chapter: { objectives: ids.map((id) => ({ id, description: id.toUpperCase() })) },
    });
    const first = compileNeutralOverlay(
      fixture({
        storyChapters: chapter(['a', 'b']),
        modes: {
          regular: { tasks: { quest: { name: 'Regular' } } },
          pve: { tasks: { quest: { name: 'PvE' } } },
          'pvp-season': {},
        },
      })
    );
    const second = compileNeutralOverlay(fixture({ storyChapters: chapter(['b', 'a']) }));
    expect(first.$strings.en?.['@tt:overlay:/modes/regular/tasks/quest/name']).toBe('Regular');
    expect(first.$strings.en?.['@tt:overlay:/modes/pve/tasks/quest/name']).toBe('PvE');
    expect(
      second.$strings.en?.['@tt:overlay:/storyChapters/chapter/objectives/a/description']
    ).toBe(first.$strings.en?.['@tt:overlay:/storyChapters/chapter/objectives/a/description']);
    expect(overlayStringKey(['tasks', 'a/b~c', 'name'])).toBe('@tt:overlay:/tasks/a~1b~0c/name');
  });
});
