import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import JSON5 from 'json5';

it.each([20000, 8000])('preserves Tour corrections and parents at USD count %i', (usdCount) => {
  const dir = mkdtempSync(join(tmpdir(), 'story-tour-details-'));
  const questId = '6895bfa355ad4ab76001a1c9';
  const objectives = [
    ['6895d2d18f186d19d54d102c', 'HandoverItem', 'Hand over the cash to Mechanic'],
    ['68cd005720baf6092be731c8', 'FindItem', 'Collect the required amount in USD'],
  ];
  const details = [
    [
      '6895c24ec097ed522295a05d',
      'Hand over the cash to Therapist',
      'Hand over 250,000 RUB to Therapist',
      false,
    ],
    [
      '68ccffb395ec3bc6eddfc3e3',
      'Collect the required amount in RUB',
      'Collect the required 250,000 RUB',
      true,
    ],
    [
      '6895c4a6b9a96237b73e15a1',
      'Hand over any Building materials items to Skier',
      'Hand over any 5 building materials or tools found in raid to Skier',
      false,
    ],
    [
      '68cd000e66cfbf075021bbb4',
      'Find any item in raid from the Building materials category',
      'Find any 5 building materials or tools in raid',
      true,
    ],
    [
      '6895daa6f935f3dbe1de0a9d',
      'Hand over any weapon to Mechanic',
      'Hand over any 2 weapons found in raid to Mechanic',
      false,
    ],
    ['68cd03317ad9451d1d306448', 'Find any weapon in raid', 'Find any 2 weapons in raid', true],
    [
      '68c42742aba9a345346af424',
      'Eliminate any target on Woods',
      'Eliminate any 3 targets on Woods',
      false,
    ],
    [
      '6896020e3af3adc94b263d60',
      'Hand over the item to Prapor: PMC dogtag',
      'Hand over 5 PMC dogtags to Prapor',
      false,
    ],
    [
      '68cd008705dec39938e316d1',
      'Find the item in raid: PMC dogtag',
      'Find 5 PMC dogtags in raid',
      true,
    ],
    ['68c41dde2ddd4581cfc7531c', 'Talk to Mechanic', 'Talk to Mechanic', false],
    ['68c15e129c0090b717977bd4', 'Talk to Ragman', 'Talk to Ragman', false],
  ] as const;
  const wikiTexts = [
    'Hand over the cash to Therapist',
    'Collect the required 250,000 Roubles',
    'Hand over any 5 found in raid building materials items to Skier',
    'Find any 5 items in raid from the building materials category',
    'Hand over any 2 found in raid weapons to Mechanic',
    'Find any 2 weapons in raid',
    'Eliminate any 3 targets on Woods',
    'Hand over 5 PMC dogtags to Prapor',
    'Find 5 PMC dogtags in raid',
    'Talk to Mechanic',
    'Talk to Ragman',
  ];
  const metadata = JSON.parse(
    readFileSync(new URL('../scripts/story-chapter-meta.json', import.meta.url), 'utf8')
  );
  try {
    for (const path of ['scripts', 'eft', 'data/eft', 'src/schemas'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, 'src/schemas/story-chapter.schema.json'),
      readFileSync(new URL('../src/schemas/story-chapter.schema.json', import.meta.url))
    );
    writeFileSync(
      join(dir, 'scripts/story-chapter-meta.json'),
      JSON.stringify({ tour: metadata.tour })
    );
    writeFileSync(
      join(dir, 'data/eft/story-wiki-objectives.json'),
      JSON.stringify({
        tour: [
          ...objectives.map(([, , text], index) => ({ text, optional: index === 1 })),
          ...details.map(([, , , optional], index) => ({ text: wikiTexts[index], optional })),
        ],
      })
    );
    writeFileSync(
      join(dir, 'eft/quest_list.json'),
      JSON.stringify({
        request: {
          url: 'https://gw-pve.example/client/quest/list',
          headers: { 'App-Version': 'test' },
        },
        response: {
          body_response: {
            data: [
              {
                _id: '68cbd33676fe74b1e80bfd91',
                conditions: { AvailableForFinish: [{ conditionType: 'Quest', target: questId }] },
              },
              {
                _id: questId,
                conditions: {
                  AvailableForFinish: [
                    ...objectives,
                    ...details.map(([id, text]) => [id, 'FindItem', text]),
                  ].map(([id, conditionType]) => ({
                    id,
                    conditionType,
                    value: usdCount,
                    ...(id === objectives[1][0] ? { parentId: objectives[0][0] } : {}),
                  })),
                },
                localization: {
                  en: Object.fromEntries([
                    ...objectives.map(([id, , text]) => [id, text]),
                    ...details.map(([id, text]) => [id, text]),
                  ]),
                },
              },
            ],
          },
        },
      })
    );
    const output = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../scripts/eft-story-generate.ts', import.meta.url)),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          STORY_REFERENCE_UPDATE_LOCK: '1',
          STORY_REFERENCE: 'eft/quest_list.json',
          STORY_REFERENCE_SUPPLEMENTS: '[]',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(output.status).toBe(0);
    expect(output.stderr).toContain('warning: tour curated objective IDs unresolved in reference');
    expect(output.stderr).toContain('6895bc04162304804bdc056e');
    expect(JSON.parse(output.stdout).tour.objectives).toEqual(
      [
        {
          id: objectives[0][0],
          sourceQuestId: questId,
          type: 'main',
          description: 'Hand over 8,000 USD to Mechanic',
        },
        {
          id: objectives[1][0],
          sourceQuestId: questId,
          type: 'optional',
          description: 'Collect the required 8,000 USD',
          parentObjectiveId: objectives[0][0],
        },
        ...details.map(([id, , description, optional]) => ({
          id,
          sourceQuestId: questId,
          type: optional ? 'optional' : 'main',
          description,
        })),
      ]
        .map((objective) => ({
          ...objective,
          ...(metadata.tour.objectiveUnlocks[objective.id]
            ? { unlocks: metadata.tour.objectiveUnlocks[objective.id] }
            : {}),
        }))
        .sort(
          (a, b) =>
            metadata.tour.objectiveOrder.indexOf(a.id) - metadata.tour.objectiveOrder.indexOf(b.id)
        )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('regenerates every Tour objective in narrative order with stage rewards and unchanged IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-tour-stages-'));
  const metadata = JSON.parse(
    readFileSync(new URL('../scripts/story-chapter-meta.json', import.meta.url), 'utf8')
  );
  const tour = JSON5.parse(
    readFileSync(new URL('../src/additions/storyChapters.json5', import.meta.url), 'utf8')
  ).tour;
  const questIds = [
    ...new Set<string>(
      tour.objectives.map((objective: { sourceQuestId: string }) => objective.sourceQuestId)
    ),
  ];
  try {
    for (const path of ['scripts', 'eft', 'data/eft', 'src/schemas'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, 'src/schemas/story-chapter.schema.json'),
      readFileSync(new URL('../src/schemas/story-chapter.schema.json', import.meta.url))
    );
    writeFileSync(
      join(dir, 'scripts/story-chapter-meta.json'),
      JSON.stringify({ tour: metadata.tour })
    );
    writeFileSync(
      join(dir, 'data/eft/story-wiki-objectives.json'),
      JSON.stringify({
        tour: tour.objectives.map(
          (objective: { id: string; description: string; type: string }) => ({
            text: objective.description,
            optional: metadata.tour.objectiveOptionalCorrections[objective.id]
              ? false
              : objective.type === 'optional',
          })
        ),
      })
    );
    writeFileSync(
      join(dir, 'eft/quest_list.json'),
      JSON.stringify({
        request: {
          url: 'https://gw-pve.example/client/quest/list',
          headers: { 'App-Version': 'test' },
        },
        response: {
          body_response: {
            data: [
              {
                _id: '68cbd33676fe74b1e80bfd91',
                conditions: {
                  AvailableForFinish: questIds
                    .slice()
                    .reverse()
                    .map((target) => ({ conditionType: 'Quest', target })),
                },
              },
              ...questIds.map((_id) => {
                const objectives = tour.objectives
                  .filter((objective: { sourceQuestId: string }) => objective.sourceQuestId === _id)
                  .reverse();
                return {
                  _id,
                  conditions: {
                    AvailableForFinish: objectives.map(
                      (objective: { id: string; parentObjectiveId?: string }) => ({
                        id: objective.id,
                        conditionType: 'FindItem',
                        parentId: objective.parentObjectiveId,
                      })
                    ),
                  },
                  localization: {
                    en: Object.fromEntries(
                      objectives.map((objective: { id: string; description: string }) => [
                        objective.id,
                        metadata.tour.objectiveOptionalCorrections[objective.id]
                          ? objective.description.replace(/ 3 times$/, '')
                          : objective.description,
                      ])
                    ),
                  },
                };
              }),
            ],
          },
        },
      })
    );
    const run = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL('../scripts/eft-story-generate.ts', import.meta.url)),
          ],
          {
            cwd: dir,
            env: {
              ...process.env,
              STORY_REFERENCE_UPDATE_LOCK: '1',
              STORY_REFERENCE: 'eft/quest_list.json',
              STORY_REFERENCE_SUPPLEMENTS: '[]',
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
      ).tour;
    const generated = run();
    expect(generated.objectives.map((objective: { id: string }) => objective.id)).toEqual(
      metadata.tour.objectiveOrder
    );
    expect(generated.objectives).toEqual(tour.objectives);
    expect(generated.rewards).toEqual({ description: 'Unlocks achievement Pathfinder' });
    const objectiveIds = generated.objectives.map((objective: { id: string }) => objective.id);
    for (const [collection, handover] of [
      ['68ccffb395ec3bc6eddfc3e3', '6895c24ec097ed522295a05d'],
      ['68cd000e66cfbf075021bbb4', '6895c4a6b9a96237b73e15a1'],
      ['68cd03317ad9451d1d306448', '6895daa6f935f3dbe1de0a9d'],
      ['68cd008705dec39938e316d1', '6896020e3af3adc94b263d60'],
      ['68cd005720baf6092be731c8', '6895d2d18f186d19d54d102c'],
    ]) {
      expect(objectiveIds.indexOf(collection)).toBe(objectiveIds.indexOf(handover) - 1);
    }

    expect(generated).toEqual(run());
    expect(
      generated.objectives
        .filter(
          (objective: { id: string }) => metadata.tour.objectiveOptionalCorrections[objective.id]
        )
        .map((objective: { type: string }) => objective.type)
    ).toEqual(Array(5).fill('optional'));
    expect(
      Object.fromEntries(
        generated.objectives
          .filter((objective: { unlocks?: unknown[] }) => objective.unlocks)
          .map((objective: { id: string; unlocks: { name: string }[] }) => [
            objective.id,
            objective.unlocks.map((unlock) => unlock.name),
          ])
      )
    ).toEqual({
      '6895bc04162304804bdc056e': ['Therapist', 'Ragman', 'Interchange'],
      '6895c24ec097ed522295a05d': ['Streets of Tarkov'],
      '68cc123af7f4373ce2365213': ['Skier', 'Customs'],
      '6895c4a6b9a96237b73e15a1': ['Mechanic', 'Factory'],
      '6895daa6f935f3dbe1de0a9d': ['Prapor', 'Woods'],
      '69bd84d0e08ef0a8d3a85950': ['Peacekeeper', 'Shoreline'],
      '6896020e3af3adc94b263d60': ['Reserve'],
      '6895d2d18f186d19d54d102c': ['Lighthouse'],
      '68c6aa4040bb6d7ff66c0abb': ['The Lab'],
    });
    expect(generated.traderUnlocks).toContainEqual({
      id: '54cb57776803fa99248b456e',
      name: 'Therapist',
    });
    expect(
      generated.objectives
        .find((objective: { id: string }) => objective.id === '69bd84d0e08ef0a8d3a85950')
        .unlocks.map((unlock: { name: string }) => unlock.name)
    ).toEqual(['Peacekeeper', 'Shoreline']);
    expect(
      generated.objectives.find(
        (objective: { id: string }) => objective.id === '68c427c12529fc8fe8d2ded6'
      ).description
    ).toBe('Talk to Skier');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
