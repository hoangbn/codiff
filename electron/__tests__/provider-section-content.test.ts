import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironmentForSubprocess } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import type {
  DiffSection,
  DiffSectionContentRequest,
  RepositoryState,
  ReviewSource,
} from '../../core/types.ts';

const require = createRequire(import.meta.url);
type ProviderSource = Extract<ReviewSource, { type: 'pull-request' }>;
type SectionReader = (
  launchPath: string,
  source: ProviderSource,
  path: string,
  options?: { force?: boolean },
) => Promise<DiffSection>;
const { readDiffSectionContent, readRepositoryState } = require('../git-state.cjs') as {
  readDiffSectionContent: (
    launchPath: string,
    request: DiffSectionContentRequest,
  ) => Promise<DiffSection>;
  readRepositoryState: (launchPath: string, source: ProviderSource) => Promise<RepositoryState>;
};
const { readPullRequestSectionContent } = require('../git-state/pull-request.cjs') as {
  readPullRequestSectionContent: SectionReader;
};
const { readMergeRequestSectionContent } = require('../git-state/merge-request.cjs') as {
  readMergeRequestSectionContent: SectionReader;
};
const execFileAsync = promisify(execFile);
const git = async (repo: string, args: ReadonlyArray<string>) =>
  (
    await execFileAsync('git', ['-C', repo, ...args], {
      env: getGitTestEnvironmentForSubprocess(),
    })
  ).stdout.trim();
const eagerLimit = 1024 * 1024;
const manualLimit = 2 * eagerLimit;

const withProvider = async (
  provider: 'github' | 'gitlab',
  callback: (fixture: {
    repo: string;
    source: ProviderSource & { baseSha: string };
    reader: SectionReader;
    calls: () => Promise<string>;
    updateResponses: (overrides: Record<string, unknown>) => Promise<void>;
  }) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-provider-section-');
  const repo = join(directory.path, 'repo');
  const command = join(directory.path, 'provider-cli');
  const responsesPath = join(directory.path, 'responses.json');
  const callsPath = join(directory.path, 'calls.jsonl');
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, ['init', '--initial-branch=main']);
  const oldFiles = {
    'before.txt': 'provider old\n',
    'deleted.txt': 'provider deleted\n',
    'large.txt': 'a'.repeat(eagerLimit + 1),
    'over-limit.txt': 'a'.repeat(eagerLimit + 1),
    'binary.dat': Buffer.from([0, 1]),
    'empty-before.txt': '',
    'empty-mode.txt': '',
    'empty-deleted.txt': '',
    'src/nested.txt': 'nested old\n',
  };
  for (const [path, contents] of Object.entries(oldFiles)) {
    await writeFile(join(repo, path), contents);
  }
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'provider base']);
  const base = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['mv', 'before.txt', 'after.txt']);
  await git(repo, ['rm', 'deleted.txt']);
  await git(repo, ['mv', 'empty-before.txt', 'empty-after.txt']);
  await git(repo, ['rm', 'empty-deleted.txt']);
  await writeFile(join(repo, 'empty-added.txt'), '');
  await writeFile(join(repo, 'src/nested.txt'), 'nested new\n');
  await writeFile(join(repo, 'after.txt'), 'provider new\n');
  await writeFile(join(repo, 'added.txt'), 'provider added\n');
  await writeFile(join(repo, 'large.txt'), 'b'.repeat(eagerLimit + 1));
  await writeFile(join(repo, 'over-limit.txt'), 'b'.repeat(manualLimit + 1));
  await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 2]));
  await git(repo, ['add', '.']);
  await git(repo, ['update-index', '--chmod=+x', 'empty-mode.txt']);
  await git(repo, ['commit', '-m', 'provider head']);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const refPrefix = provider === 'github' ? 'pull-requests' : 'merge-requests';
  await git(repo, ['update-ref', `refs/codiff/${refPrefix}/42/base`, base]);
  await git(repo, ['update-ref', `refs/codiff/${refPrefix}/42/head`, head]);
  await git(repo, ['remote', 'add', 'origin', `git@${provider}.com:acme/widgets.git`]);
  await writeFile(join(repo, 'after.txt'), 'LOCAL WORKING TREE MUST NOT BE READ\n');
  const files = [
    { filename: 'after.txt', previous_filename: 'before.txt', status: 'renamed' },
    { filename: 'added.txt', status: 'added' },
    { filename: 'deleted.txt', status: 'removed' },
    { filename: 'large.txt', status: 'modified' },
    { filename: 'over-limit.txt', status: 'modified' },
    { filename: 'binary.dat', status: 'modified' },
    { filename: 'empty-after.txt', previous_filename: 'empty-before.txt', status: 'renamed' },
    { filename: 'empty-mode.txt', status: 'modified' },
    { filename: 'empty-added.txt', status: 'added' },
    { filename: 'empty-deleted.txt', status: 'removed' },
    { filename: 'src/nested.txt', status: 'modified' },
  ].map((file) => ({
    ...file,
    patch: file.filename.startsWith('empty-') ? '' : '@@ -1 +1 @@\n-provider old\n+provider new\n',
  }));
  const responses = {
    metadata:
      provider === 'github'
        ? { base: { ref: 'main', sha: base }, head: { sha: head } }
        : { target_branch: 'main', sha: head, diff_refs: { base_sha: base } },
    files:
      provider === 'github'
        ? [files]
        : files.map((file) => ({
            new_path: file.filename,
            old_path: file.previous_filename || file.filename,
            new_file: file.status === 'added',
            deleted_file: file.status === 'removed',
            renamed_file: file.status === 'renamed',
            diff: file.filename === 'large.txt' ? '' : file.patch,
          })),
    diff: await git(repo, [
      'diff',
      base,
      head,
      '--',
      'after.txt',
      'before.txt',
      'empty-*',
      'src/nested.txt',
    ]),
  };
  await writeFile(responsesPath, JSON.stringify(responses));
  await writeFile(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, 'utf8'));
if (responses.error) { process.stderr.write(responses.error); process.exit(1); }
const endpoint = args.find((argument) => /^(repos|projects)\\//.test(argument)) || '';
const value = endpoint.includes('/files?') || endpoint.includes('/diffs?')
  ? JSON.stringify(responses.files)
  : endpoint.includes('/comments') || endpoint.includes('/discussions') || args.includes('graphql')
    ? '[]'
    : args.some((argument) => argument.includes('application/vnd.github.v3.diff'))
      ? responses.diff
      : JSON.stringify(responses.metadata);
if (responses.nextMetadata && value === JSON.stringify(responses.metadata)) {
  writeFileSync(${JSON.stringify(responsesPath)}, JSON.stringify({ ...responses, metadata: responses.nextMetadata, nextMetadata: undefined }));
}
process.stdout.write(value);
`,
  );
  await chmod(command, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: command,
    CODIFF_GLAB_PATH: command,
    SHELL: undefined,
  });
  await callback({
    repo,
    source: {
      baseSha: base,
      headSha: head,
      provider,
      type: 'pull-request',
      url:
        provider === 'github'
          ? 'https://github.com/acme/widgets/pull/42'
          : 'https://gitlab.com/acme/widgets/-/merge_requests/42',
    },
    reader: provider === 'github' ? readPullRequestSectionContent : readMergeRequestSectionContent,
    calls: () => readFile(callsPath, 'utf8'),
    updateResponses: (overrides) =>
      writeFile(responsesPath, JSON.stringify({ ...responses, ...overrides })),
  });
};

for (const provider of ['github', 'gitlab'] as const) {
  test(`${provider} section dispatcher reads provider revisions, including renames and one-sided files`, async () => {
    await withProvider(provider, async ({ repo, source, reader, calls }) => {
      expect(reader).toBeTypeOf('function');
      for (const [path, oldContents, newContents] of [
        ['after.txt', 'provider old\n', 'provider new\n'],
        ['added.txt', '', 'provider added\n'],
        ['deleted.txt', 'provider deleted\n', ''],
      ]) {
        const section = await readDiffSectionContent(repo, {
          source,
          kind: 'pull-request',
          path,
          force: true,
        });
        expect(section).toMatchObject({
          id: `${path}:pull-request:42`,
          kind: 'pull-request',
          loadState: 'ready',
        });
        expect(section.oldFile?.contents).toBe(oldContents);
        expect(section.newFile?.contents).toBe(newContents);
      }
      expect(await calls()).toContain(
        provider === 'github'
          ? 'repos/acme/widgets/pulls/42'
          : 'projects/acme%2Fwidgets/merge_requests/42',
      );
      if (provider === 'gitlab') {
        expect(await calls()).toContain('"--hostname","gitlab.com"');
        expect(
          await readDiffSectionContent(repo, {
            source: { ...source, provider: undefined },
            kind: 'pull-request',
            path: 'after.txt',
          }),
        ).toMatchObject({ newFile: { contents: 'provider new\n' } });
      }
    });
  });

  test(`${provider} deferred sections force-load native text without exceeding the manual limit`, async () => {
    await withProvider(provider, async ({ repo, source, reader }) => {
      const state = await readRepositoryState(repo, source);
      expect(state.source).toMatchObject({ provider, type: 'pull-request', url: source.url });
      expect(state.files.find((file) => file.path === 'large.txt')?.sections[0]).toMatchObject(
        provider === 'github'
          ? { loadState: 'ready', summary: { canLoad: false } }
          : {
              loadState: 'deferred',
              summary: { canLoad: true, limit: eagerLimit, size: eagerLimit + 1 },
            },
      );
      const deferred = await reader(repo, source, 'large.txt');
      expect(deferred).toMatchObject(
        provider === 'github'
          ? { loadState: 'ready', summary: { canLoad: false } }
          : { loadState: 'deferred', summary: { canLoad: true } },
      );
      expect(deferred.newFile).toBeUndefined();
      const forced = await readDiffSectionContent(repo, {
        source,
        kind: 'pull-request',
        path: 'large.txt',
        force: true,
      });
      expect(forced.loadState).toBe('ready');
      expect(forced.oldFile?.contents).toBe('a'.repeat(eagerLimit + 1));
      expect(forced.newFile?.contents).toBe('b'.repeat(eagerLimit + 1));
      expect(state.files.find((file) => file.path === 'over-limit.txt')?.sections[0]).toMatchObject(
        {
          loadState: 'ready',
          summary: { canLoad: false },
        },
      );
      expect(await reader(repo, source, 'over-limit.txt', { force: true })).toMatchObject({
        loadState: 'ready',
        summary: { canLoad: false },
      });
      expect(await reader(repo, source, 'binary.dat', { force: true })).toMatchObject({
        binary: true,
        loadState: 'binary',
        summary: { canLoad: false },
      });
    });
  });

  test(`${provider} section reads reject invalid paths, nonmembers, auth failures, and unavailable refs`, async () => {
    await withProvider(provider, async ({ repo, source, updateResponses }) => {
      const read = (path: string) =>
        readDiffSectionContent(repo, { source, kind: 'pull-request', path, force: true });
      await expect(read('../outside.txt')).rejects.toThrow('Invalid repository path.');
      await expect(read('not-in-review.txt')).rejects.toThrow('File is not part of this');
      await updateResponses({ error: 'provider authorization denied' });
      await expect(read('after.txt')).rejects.toThrow('provider authorization denied');
      await updateResponses({
        files:
          provider === 'github'
            ? [[{ filename: 'missing.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+missing\n' }]]
            : [
                {
                  new_path: 'missing.txt',
                  old_path: 'missing.txt',
                  new_file: true,
                  deleted_file: false,
                  renamed_file: false,
                  diff: '@@ -0,0 +1 @@\n+missing\n',
                },
              ],
      });
      await expect(read('missing.txt')).rejects.toThrow('could not load full contents');
      await updateResponses({});
      const prefix = provider === 'github' ? 'pull-requests' : 'merge-requests';
      await git(repo, ['update-ref', '-d', `refs/codiff/${prefix}/42/head`]);
      await using _transportEnvironment = createTemporaryEnvironment({
        GIT_ALLOW_PROTOCOL: 'file',
      });
      await expect(read('after.txt')).rejects.toThrow(
        provider === 'github' ? 'could not resolve full contents' : /fatal:/,
      );
      const fallback = await readRepositoryState(repo, source);
      expect(fallback.files.every((file) => file.sections[0].summary?.canLoad === false)).toBe(
        true,
      );
    });
  });

  test(`${provider} keeps usable patches for deferred and over-limit files`, async () => {
    await withProvider(provider, async ({ repo, source, reader, updateResponses }) => {
      if (provider === 'gitlab') {
        await updateResponses({
          files: ['large.txt', 'over-limit.txt'].map((path) => ({
            new_path: path,
            old_path: path,
            new_file: false,
            deleted_file: false,
            renamed_file: false,
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          })),
        });
      }
      const state = await readRepositoryState(repo, source);
      for (const path of ['large.txt', 'over-limit.txt']) {
        const section = state.files.find((file) => file.path === path)?.sections[0];
        expect(section).toMatchObject({
          binary: false,
          loadState: 'ready',
          summary: { canLoad: false },
        });
        expect(section?.patch).toContain('@@');
        expect(section?.oldFile).toBeUndefined();
        expect((await reader(repo, source, path)).loadState).toBe('ready');
      }
    });
  });

  test(`${provider} reads empty blobs for renames, modes, additions and deletions`, async () => {
    await withProvider(provider, async ({ repo, source, reader }) => {
      const state = await readRepositoryState(repo, source);
      for (const path of [
        'empty-after.txt',
        'empty-mode.txt',
        'empty-added.txt',
        'empty-deleted.txt',
      ]) {
        const section = await reader(repo, source, path, { force: true });
        expect(section).toMatchObject({
          binary: false,
          loadState: 'ready',
          oldFile: { contents: '' },
          newFile: { contents: '' },
        });
        expect(state.files.find((file) => file.path === path)?.sections[0]).toMatchObject({
          binary: false,
          loadState: 'ready',
        });
        if (provider === 'github' && path === 'empty-mode.txt') {
          expect(section.patch).toContain('new mode 100755');
        }
      }
    });
  });

  test(`${provider} rejects stale heads and bases and keys refreshed contents by immutable SHAs`, async () => {
    await withProvider(provider, async ({ repo, source, reader, updateResponses }) => {
      const original = await reader(repo, source, 'after.txt', { force: true });
      expect(original.newFile?.cacheKey).toBe(`${source.headSha}:after.txt`);
      await expect(
        reader(repo, { ...source, headSha: '0'.repeat(40) }, 'after.txt'),
      ).rejects.toThrow('Refresh the review');
      const staleBase = { ...source, baseSha: '0'.repeat(40) };
      await expect(reader(repo, staleBase, 'after.txt')).rejects.toThrow('Refresh the review');
      await writeFile(join(repo, 'after.txt'), 'provider newest\n');
      await git(repo, ['add', 'after.txt']);
      await git(repo, ['commit', '-m', 'new provider head']);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const prefix = provider === 'github' ? 'pull-requests' : 'merge-requests';
      await git(repo, ['update-ref', `refs/codiff/${prefix}/42/head`, head]);
      await updateResponses({
        metadata:
          provider === 'github'
            ? { base: { ref: 'main', sha: source.baseSha }, head: { sha: head } }
            : { target_branch: 'main', sha: head, diff_refs: { base_sha: source.baseSha } },
      });
      await expect(reader(repo, source, 'after.txt')).rejects.toThrow('Refresh the review');
      const refreshed = await reader(repo, { ...source, headSha: head }, 'after.txt', {
        force: true,
      });
      expect(refreshed.newFile?.contents).toBe('provider newest\n');
      expect(refreshed.newFile?.cacheKey).toBe(`${head}:after.txt`);
      expect(refreshed.newFile?.cacheKey).not.toBe(original.newFile?.cacheKey);
      expect(original.newFile?.contents).toBe('provider new\n');
    });
  });

  test(`${provider} rejects a review that moves during content reconstruction`, async () => {
    await withProvider(provider, async ({ repo, source, reader, updateResponses }) => {
      await updateResponses({
        nextMetadata:
          provider === 'github'
            ? { base: { ref: 'main', sha: source.baseSha }, head: { sha: '0'.repeat(40) } }
            : {
                target_branch: 'main',
                sha: '0'.repeat(40),
                diff_refs: { base_sha: source.baseSha },
              },
      });
      await expect(reader(repo, source, 'after.txt', { force: true })).rejects.toThrow(
        'Refresh the review',
      );
    });
  });

  test(`${provider} never advertises loading when either required side is missing`, async () => {
    await withProvider(provider, async ({ repo, source, reader, updateResponses }) => {
      for (const [oldPath, newPath] of [
        ['missing.txt', 'large.txt'],
        ['large.txt', 'missing.txt'],
      ]) {
        await updateResponses({
          files:
            provider === 'github'
              ? [
                  [
                    {
                      filename: newPath,
                      previous_filename: oldPath,
                      status: 'renamed',
                      patch: '@@ -1 +1 @@\n-old\n+new\n',
                    },
                  ],
                ]
              : [
                  {
                    new_path: newPath,
                    old_path: oldPath,
                    new_file: false,
                    deleted_file: false,
                    renamed_file: true,
                    diff: '',
                  },
                ],
        });
        const state = await readRepositoryState(repo, source);
        expect(state.files[0].sections[0].summary?.canLoad).toBe(false);
        await expect(reader(repo, source, newPath, { force: true })).rejects.toThrow(
          'could not load full contents',
        );
      }
    });
  });

  test(`${provider} validates metadata and diff records at the API boundary`, async () => {
    await withProvider(provider, async ({ repo, source, reader, updateResponses }) => {
      for (const metadata of [null, provider === 'github' ? { head: { sha: 42 } } : { sha: 42 }]) {
        await updateResponses({ metadata });
        await expect(reader(repo, source, 'after.txt')).rejects.toMatchObject({ name: 'ZodError' });
      }
      await updateResponses({ files: provider === 'github' ? [[null]] : [null] });
      await expect(reader(repo, source, 'after.txt')).rejects.toMatchObject({ name: 'ZodError' });
      await updateResponses({
        files:
          provider === 'github'
            ? [[{ filename: '../outside.txt', status: 'modified' }]]
            : [
                {
                  new_path: '../outside.txt',
                  old_path: 'after.txt',
                  new_file: false,
                  deleted_file: false,
                  renamed_file: false,
                  diff: '',
                },
              ],
      });
      await expect(reader(repo, source, 'after.txt')).rejects.toThrow('Invalid repository path');
    });
  });

  test(`${provider} loads nested POSIX provider paths`, async () => {
    await withProvider(provider, async ({ repo, source, reader }) => {
      const section = await reader(repo, source, 'src/nested.txt', { force: true });
      expect(section.oldFile?.contents).toBe('nested old\n');
      expect(section.newFile?.contents).toBe('nested new\n');
    });
  });
}

test('provider paths stay POSIX under Windows while filesystem paths stay native', async () => {
  const simulatedModule = {
    exports: {} as {
      validateProviderPath: (path: string) => string;
      validateRepositoryPath: (path: string) => string;
    },
  };
  runInNewContext(await readFile(resolve('electron/git-state/common.cjs'), 'utf8'), {
    module: simulatedModule,
    require: (specifier: string) => (specifier === 'node:path' ? win32 : require(specifier)),
    Buffer,
    process,
  });
  expect(simulatedModule.exports.validateProviderPath('src/nested.txt')).toBe('src/nested.txt');
  expect(simulatedModule.exports.validateRepositoryPath('src/nested.txt')).toBe('src\\nested.txt');
  expect(() => simulatedModule.exports.validateProviderPath('../outside.txt')).toThrow(
    'Invalid repository path',
  );
});
