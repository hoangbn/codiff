import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { DefinitionSearchRequest } from '../../core/types.ts';
import { type DefinitionSearchResult } from '../../core/types.ts';
import { createDefinitionNavigationRepository } from '../../examples/definition-navigation/create-repository.mjs';

const require = createRequire(import.meta.url);

const { findDefinitions } = require('../definition-search.cjs') as {
  classifyDefinition: (
    identifier: string,
    path: string,
    line: string,
  ) => { kind: string; strength: number } | null;
  createDefinitionSearchCoordinator: (searchDefinitions?: typeof findDefinitions) => {
    cancel: (key: number) => void;
    find: (
      key: number,
      repositoryPath: string,
      request: DefinitionSearchRequest,
    ) => Promise<DefinitionSearchResult>;
  };
  findDefinitions: (
    repositoryPath: string,
    request: DefinitionSearchRequest,
  ) => Promise<DefinitionSearchResult>;
  parseGrepOutput: (
    output: string,
    revision: string | null,
  ) => Array<{ line: string; lineNumber: number; path: string }>;
  runBoundedGitGrep: (
    repositoryPath: string,
    args: ReadonlyArray<string>,
    options?: {
      maxMatches?: number;
      maxOutputBytes?: number;
      signal?: AbortSignal;
      spawnProcess?: typeof import('node:child_process').spawn;
      timeoutMs?: number;
    },
  ) => Promise<string>;
};

const request = {
  identifier: 'formatGreeting',
  kind: 'unstaged',
  lineNumber: 3,
  path: 'src/main.ts',
  side: 'additions',
  source: { type: 'working-tree' },
} satisfies DefinitionSearchRequest;

test('combined sections search current additions in the working tree', async () => {
  await using directory = await createTemporaryDirectory('codiff-definitions-combined-');
  createDefinitionNavigationRepository(directory.path);
  await writeFile(
    join(directory.path, 'src/farewell.ts'),
    'export function formatFarewell(name: string) {\n  return `Bye, ${name}!`;\n}\n',
  );
  const source = {
    baseRef: 'HEAD',
    headRef: 'HEAD',
    ref: 'main',
    type: 'branch-working-tree',
  } satisfies DefinitionSearchRequest['source'];

  const additions = await findDefinitions(directory.path, {
    ...request,
    identifier: 'formatFarewell',
    kind: 'combined',
    source,
  });
  expect(additions).toMatchObject({
    candidates: [{ canOpenInEditor: true, lineNumber: 1, path: 'src/farewell.ts' }],
    status: 'ready',
  });

  const deletions = await findDefinitions(directory.path, {
    ...request,
    kind: 'combined',
    side: 'deletions',
    source,
  });
  expect(deletions).toMatchObject({
    candidates: [{ canOpenInEditor: false, path: 'src/greeting.ts' }],
    status: 'ready',
  });
});
