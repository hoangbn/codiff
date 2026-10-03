import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getGitTestEnvironment } from './git.ts';
import { createTemporaryWorkingDirectory } from './resources.ts';

const execFileAsync = promisify(execFile);

export const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
};

export const withCwd = async <T>(cwd: string, callback: () => T | Promise<T>) => {
  using _workingDirectory = createTemporaryWorkingDirectory(cwd);
  return await callback();
};

export const createCliReferenceRepository = async () => {
  const refRepositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-refs-')));
  await git(refRepositoryPath, ['init']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'first']);
  await git(refRepositoryPath, ['branch', 'base']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'second']);
  await git(refRepositoryPath, ['branch', 'feature']);
  const { stdout } = await execFileAsync('git', ['-C', refRepositoryPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  const refRepositoryShortHash = stdout.trim().slice(0, 8);
  await git(refRepositoryPath, ['branch', refRepositoryShortHash]);
  await git(refRepositoryPath, ['branch', 'target']);
  return { path: refRepositoryPath, shortHash: refRepositoryShortHash };
};
