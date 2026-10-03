import { realpath } from 'node:fs/promises';
import { expect, test } from 'vite-plus/test';
import { git, createGitHistory, readGitFiles } from './helpers/git-files.ts';
import { createTemporaryDirectory } from './helpers/resources.ts';

test('Git blob availability distinguishes empty files from absent and deferred files', async () => {
  await using directory = await createTemporaryDirectory('codiff-git-files-');
  const repo = await realpath(directory.path);
  await git(repo, ['init']);
  await createGitHistory(repo);
  const head = (await git(repo, ['rev-parse', 'refs/heads/head'])).trim();
  const files = await readGitFiles(repo, head, [
    'empty.txt',
    'missing.txt',
    'medium.txt',
    'huge.txt',
  ]);
  expect(files.get('empty.txt')).toMatchObject({ available: true, file: { contents: '' } });
  expect(files.get('missing.txt')).toMatchObject({ available: false });
  expect(files.get('medium.txt')).toMatchObject({ available: true, loadState: 'deferred' });
  expect(files.get('huge.txt')).toMatchObject({ available: true, loadState: 'too-large' });
});
