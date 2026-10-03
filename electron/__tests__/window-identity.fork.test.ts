import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);

const { getWindowIdentity } = require('../window-identity.cjs') as {
  findMatchingWindowIdentity: (
    identity: { key: string } | null,
    existingIdentities: ReadonlyMap<number, { key: string } | null>,
  ) => number | null;
  getWindowIdentity: (
    repositoryPath: string,
    launchOptions?: {
      source?:
        | { type: 'working-tree' }
        | { ref: string; type: 'branch' }
        | { baseRef: string; headRef: string; ref: string; type: 'branch-diff' }
        | { ref: string; type: 'commit' }
        | {
            number?: number;
            owner?: string;
            repo?: string;
            type: 'pull-request';
            url: string;
          };
      walkthrough?: boolean;
      walkthroughFile?: string;
      planFile?: string;
      planResultFile?: string;
    },
  ) => { key: string; repositoryRoot: string; sourceKey: string } | null;
  getWindowIdentityForRepositoryState: (state: {
    root: string;
    source:
      | { type: 'working-tree' }
      | { ref: string; type: 'commit' }
      | { baseRef: string; headRef: string; ref: string; type: 'branch-diff' };
  }) => { key: string; repositoryRoot: string; sourceKey: string } | null;
};

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const result = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
  return result.stdout.trim();
};

const initRepository = async (path: string) => {
  await git(path, ['init']);
  await git(path, ['commit', '--allow-empty', '-m', 'initial']);
};

test('window identities resolve commit-search expressions to the commit SHA', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-identity-');
  await initRepository(directory.path);
  const head = await git(directory.path, ['rev-parse', 'HEAD']);

  expect(
    getWindowIdentity(directory.path, {
      source: { ref: ':/initial', type: 'commit' },
    })?.sourceKey,
  ).toBe(`commit:${head}`);
});
