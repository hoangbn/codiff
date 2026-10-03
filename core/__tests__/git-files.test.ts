import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { git, createGitHistory, readGitFiles } from './helpers/git-files.ts';
import { removeGitTestDirectory } from './helpers/git.ts';
import { createTemporaryEnvironment } from './helpers/resources.ts';

const batchCases = [
  { fileCount: 20, maximumProcesses: 6 },
  { fileCount: 160, maximumProcesses: 6 },
  { fileCount: 500, maximumProcesses: 10 },
] as const;

let base = '';
let head = '';
let repo = '';

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'codiff-git-files-')));
  await git(repo, ['init']);
  await createGitHistory(repo);
  base = (await git(repo, ['rev-parse', 'refs/heads/base'])).trim();
  head = (await git(repo, ['rev-parse', 'refs/heads/head'])).trim();
});

afterAll(async () => {
  if (repo) {
    await removeGitTestDirectory(repo);
  }
});

test('batched Git file reads preserve text, binary, rename, missing, and size behavior', async () => {
  const oldPaths = [
    'modified.txt',
    'renamed-old.txt',
    'deleted.txt',
    'added.txt',
    'binary.bin',
    'medium.txt',
    'huge.txt',
    'missing.txt',
    'literal-:(name).txt',
  ];
  const newPaths = [
    'modified.txt',
    'renamed-new.txt',
    'deleted.txt',
    'added.txt',
    'binary.bin',
    'medium.txt',
    'huge.txt',
    'missing.txt',
    'literal-:(name).txt',
  ];
  const [oldFiles, newFiles] = await Promise.all([
    readGitFiles(repo, base, oldPaths, { refScopedEmptyCacheKey: true }),
    readGitFiles(repo, head, newPaths, { refScopedEmptyCacheKey: true }),
  ]);

  expect(oldFiles.get('modified.txt')?.file?.contents).toBe('before\n');
  expect(newFiles.get('modified.txt')?.file?.contents).toBe('after\n');
  expect(oldFiles.get('renamed-old.txt')?.file?.contents).toBe('rename before\n');
  expect(newFiles.get('renamed-new.txt')?.file?.contents).toBe('rename after\n');
  expect(oldFiles.get('deleted.txt')?.file?.contents).toBe('deleted\n');
  expect(newFiles.get('deleted.txt')?.file).toEqual({
    cacheKey: `${head}:deleted.txt:empty`,
    contents: '',
    name: 'deleted.txt',
  });
  expect(oldFiles.get('added.txt')?.file).toEqual({
    cacheKey: `${base}:added.txt:empty`,
    contents: '',
    name: 'added.txt',
  });
  expect(newFiles.get('added.txt')?.file?.contents).toBe('added\n');
  expect(oldFiles.get('binary.bin')).toMatchObject({ binary: true });
  expect(newFiles.get('binary.bin')).toMatchObject({ binary: true });
  expect(newFiles.get('binary.bin')?.fingerprint).not.toBe(oldFiles.get('binary.bin')?.fingerprint);
  expect(newFiles.get('medium.txt')).toMatchObject({
    binary: false,
    loadState: 'deferred',
    summary: { canLoad: true, size: 1024 * 1024 + 1 },
  });
  expect(newFiles.get('medium.txt')?.file).toBeUndefined();
  expect(newFiles.get('huge.txt')).toMatchObject({
    binary: false,
    loadState: 'too-large',
    summary: { canLoad: false, size: 2 * 1024 * 1024 + 1 },
  });
  expect(newFiles.get('huge.txt')?.file).toBeUndefined();
  expect(newFiles.get('missing.txt')?.file?.cacheKey).toBe(`${head}:missing.txt:empty`);
  expect(oldFiles.get('literal-:(name).txt')?.file?.contents).toBe('literal before\n');
  expect(newFiles.get('literal-:(name).txt')?.file?.contents).toBe('literal after\n');
});

test.each(batchCases)(
  'batches pull request content reads for $fileCount files',
  async ({ fileCount, maximumProcesses }) => {
    const tracePath = join(repo, `trace-${fileCount}.jsonl`);
    await using _environment = createTemporaryEnvironment({ GIT_TRACE2_EVENT: tracePath });

    const paths = Array.from(
      { length: fileCount },
      (_, index) => `src/file-${index.toString().padStart(3, '0')}.ts`,
    );
    const [oldFiles, newFiles] = await Promise.all([
      readGitFiles(repo, base, paths, { refScopedEmptyCacheKey: true }),
      readGitFiles(repo, head, paths, { refScopedEmptyCacheKey: true }),
    ]);

    expect(oldFiles).toHaveLength(fileCount);
    expect(newFiles).toHaveLength(fileCount);

    const processCount = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter(({ event }) => event === 'version').length;
    expect(processCount).toBeLessThanOrEqual(maximumProcesses);
  },
);
