import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);

const { getCommandLineLaunchOptions, getCommandLineRepositoryPath } =
  require('../main/command-line.cjs') as {
    getCommandLineLaunchOptions: (
      commandLine: ReadonlyArray<string>,
      fallbackPath?: string,
    ) => {
      applyUpdate?: boolean;
      codexSessionId?: string;
      planFile?: string;
      planResultFile?: string;
      repositoryPathProvided: boolean;
      source?:
        | { ref: string; type: 'branch-working-tree' }
        | { ref: string; type: 'commit' }
        | { base: string; head: string; symmetric: boolean; type: 'range' }
        | { type: 'pull-request'; url: string };
      walkthrough: boolean;
      walkthroughContext?: unknown;
    };
    getCommandLineRepositoryPath: (commandLine: ReadonlyArray<string>) => string | null;
    getInitialRepositoryPath: (
      launchPath: string,
      launchOptions: {
        codexSessionId?: string;
        planFile?: string;
        planResultFile?: string;
        repositoryPathProvided: boolean;
        source?:
          | { ref: string; type: 'branch-working-tree' }
          | { ref: string; type: 'commit' }
          | { base: string; head: string; symmetric: boolean; type: 'range' }
          | { type: 'pull-request'; url: string };
        walkthrough: boolean;
        walkthroughContext?: unknown;
      },
      lastRepositoryPath: string,
      environment?: NodeJS.ProcessEnv,
    ) => string;
  };

const readCommandLine = (commandLine: ReadonlyArray<string>) => ({
  launchOptions: getCommandLineLaunchOptions(commandLine),
  pullRequestNumber: null,
  repositoryPath: getCommandLineRepositoryPath(commandLine),
});

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
};

test('reads base...head and base..head positionals as a range source', async () => {
  await using directory = await createTemporaryDirectory('codiff-range-');

  await git(directory.path, ['init']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'first']);
  await git(directory.path, ['branch', 'base']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'second']);
  await git(directory.path, ['branch', 'head']);

  expect(readCommandLine(['codiff', 'base...head', directory.path]).launchOptions.source).toEqual({
    base: 'base',
    head: 'head',
    symmetric: true,
    type: 'range',
  });

  expect(readCommandLine(['codiff', 'base..head', directory.path]).launchOptions.source).toEqual({
    base: 'base',
    head: 'head',
    symmetric: false,
    type: 'range',
  });

  expect(readCommandLine(['codiff', 'nope...nada', directory.path]).launchOptions.source).toEqual({
    base: 'nope',
    head: 'nada',
    symmetric: true,
    type: 'range',
  });
});
