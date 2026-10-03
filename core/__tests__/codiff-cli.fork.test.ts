import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { getReviewSource, parseArguments } from '../../bin/arguments.js';
import { git, withCwd } from './helpers/cli-repository.ts';
import { createCliReferenceRepository } from './helpers/cli-repository.ts';
import { createFakeOpenLogger } from './helpers/cli.ts';
import { removeGitTestDirectory } from './helpers/git.ts';
import { createTemporaryDirectory } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

let refRepositoryPath = '';

test.each(['..', '...'])('packaged helper delivers native %s range content', async (separator) => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await writeFile(join(repositoryPath, 'shared.txt'), 'shared\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'common']);
  await git(repositoryPath, ['checkout', '-b', 'base']);
  await writeFile(join(repositoryPath, 'base-only.txt'), 'base\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'base']);
  await git(repositoryPath, ['checkout', '-b', 'target', 'HEAD~']);
  await writeFile(join(repositoryPath, 'target-only.txt'), 'target\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'target']);
  await writeFile(join(repositoryPath, 'untracked.txt'), 'not part of range\n');

  await execFileAsync(resolve('bin/codiff-app'), [`base${separator}target`, repositoryPath], {
    env: logger.env,
  });
  const args = ['Codiff', ...(await logger.readArgs()).slice(3)];
  const require = createRequire(import.meta.url);
  const {
    getCommandLineLaunchOptions,
    getCommandLineRepositoryPath,
  } = require('../../electron/main/command-line.cjs');
  const { readRepositoryState } = require('../../electron/git-state.cjs');
  const launchOptions = getCommandLineLaunchOptions(args);
  expect(launchOptions.source).toEqual({
    base: 'base',
    head: 'target',
    symmetric: separator === '...',
    type: 'range',
  });
  const state = await readRepositoryState(getCommandLineRepositoryPath(args), launchOptions.source);
  expect(state.files.map((file: { path: string }) => file.path).sort()).toEqual(
    separator === '..' ? ['base-only.txt', 'target-only.txt'] : ['target-only.txt'],
  );
});

test.each([
  ':/feature..message',
  ':/feature..message|fallback',
  'HEAD^{/..}',
  'HEAD^{/.. }',
  'HEAD^{/.*.. .*}',
  'HEAD~1..HEAD^{/..}',
  'HEAD~1..HEAD^{/.. }',
  'HEAD~1..HEAD^{/.*.. .*}',
  'HEAD~1..:/feature..message',
  'HEAD~1...HEAD^{/..}',
  'HEAD~1...HEAD^{/.. }',
  'HEAD~1...HEAD^{/.*.. .*}',
  'HEAD~1...:/feature..message',
])(
  'dotted revision %s preserves native source content through every launch entry',
  async (target) => {
    await using logger = await createFakeOpenLogger();
    const repositoryPath = join(logger.directory, 'repo');
    await mkdir(repositoryPath);
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial']);
    await writeFile(join(repositoryPath, 'feature.txt'), 'feature\n');
    await git(repositoryPath, ['add', '.']);
    await git(repositoryPath, ['commit', '-m', 'feature..message change']);
    await writeFile(join(repositoryPath, 'local.txt'), 'must not substitute local changes\n');
    const require = createRequire(import.meta.url);
    const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
    const { readRepositoryState } = require('../../electron/git-state.cjs');
    const range = target.startsWith('HEAD~1..');
    const separator = target.startsWith('HEAD~1...') ? '...' : '..';
    const head = range ? target.slice(`HEAD~1${separator}`.length) : target;
    await git(repositoryPath, ['rev-parse', '--verify', head]);
    if (range) {
      await git(repositoryPath, ['rev-parse', '--symbolic', target]);
    }
    const expectedSource = range
      ? { base: 'HEAD~1', head, symmetric: separator === '...', type: 'range' }
      : { ref: target, type: 'commit' };
    for (const targets of range ? [[target]] : [[target], ['--commit', target]]) {
      const parsed = parseArguments([...targets, repositoryPath]);
      const nodeSource = getReviewSource({
        branchRef: parsed.branchRef ?? null,
        commitRef: parsed.commitRef,
        pullRequestProvider: parsed.pullRequestProvider ?? null,
        pullRequestUrl: parsed.pullRequestUrl,
        range: parsed.range ?? null,
      });
      await logger.reset();
      await execFileAsync(resolve('bin/codiff-app'), [...targets, repositoryPath], {
        env: logger.env,
      });
      const sources = [
        nodeSource,
        getCommandLineLaunchOptions(['Codiff', ...targets, repositoryPath]).source,
        getCommandLineLaunchOptions(['Codiff', ...(await logger.readArgs()).slice(3)]).source,
      ];
      for (const source of sources) {
        expect(source).toEqual(expectedSource);
        const state = await readRepositoryState(repositoryPath, source);
        expect(state.files.map((file: { path: string }) => file.path)).toEqual(['feature.txt']);
      }
    }
  },
);

test.each([
  { selectors: ['--commit', 'HEAD', '--branch', 'base'] },
  { selectors: ['base..target', 'https://github.com/owner/repo/pull/42'] },
  { selectors: ['--commit'] },
  { selectors: ['--branch'] },
  { selectors: ['--commit='] },
  { selectors: ['--branch='] },
  { selectors: ['--commit', 'HEAD', '<repo>', 'base..target'] },
  { selectors: ['base..target', '--commit', 'HEAD', '<repo>'] },
  { selectors: ['--branch', 'base', '<repo>', 'base...target'] },
  { selectors: ['base...target', '--branch', 'base', '<repo>'] },
  { selectors: ['base..target', '<repo>', 'base...target'] },
  { selectors: ['--commit', 'HEAD', '<repo>', 'HEAD~1'] },
  { selectors: ['--branch', 'base', '<repo>', 'target'] },
  { selectors: ['--commit', '   '] },
  { selectors: ['--branch= \t'] },
  { selectors: ['--commit', '--branch', 'base'] },
  { selectors: ['--branch', '--commit', 'HEAD'] },
  { selectors: ['--commit=--branch'] },
  { selectors: ['--commit=HEAD', '--commit=HEAD~1'] },
  { selectors: ['--branch=base', '--branch=target'] },
  { selectors: ['--commit=', '--commit=HEAD'] },
  { selectors: ['--branch=   ', '--branch=base'] },
  { selectors: ['mr'] },
  { selectors: ['mr', ''] },
  { selectors: ['mr', 'base'] },
  { selectors: ['mr', '--commit', 'HEAD'] },
  { selectors: ['mr', '--branch', 'base'] },
  { selectors: ['pr', 'base', 'pr', 'target'] },
  { selectors: ['pr', 'base', '#2'] },
  { selectors: ['pr', 'base', 'https://github.com/o/r/pull/2'] },
])(
  'invalid review selectors %j fail before launching another comparison',
  async ({ selectors }) => {
    const require = createRequire(import.meta.url);
    const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
    const args = selectors.map((selector) =>
      selector === '<repo>' ? refRepositoryPath : selector,
    );
    const missingRevision =
      selectors.length === 1 && ['--commit', '--branch'].includes(selectors[0] ?? '');
    if (!selectors.includes('<repo>') && !missingRevision) {
      args.push(refRepositoryPath);
    }
    expect(() => parseArguments(args)).toThrow(/revision|review source/);
    expect(() => getCommandLineLaunchOptions(['Codiff', ...args])).toThrow(
      /revision|review source/,
    );
    await using logger = await createFakeOpenLogger();
    await logger.reset();
    await expect(
      execFileAsync(resolve('bin/codiff-app'), args, { env: logger.env }),
    ).rejects.toThrow(/revision|review source/);
    expect(await logger.readArgs()).toEqual(['']);
  },
);

test('a branch matching a local directory still conflicts with a provider source', async () => {
  await using logger = await createFakeOpenLogger();
  await logger.reset();
  await mkdir(join(logger.directory, 'base'));
  const args = ['base', 'https://github.com/owner/repo/pull/42', refRepositoryPath];
  const require = createRequire(import.meta.url);
  const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
  await withCwd(logger.directory, async () => {
    expect(() => parseArguments(args)).toThrow(/review source/);
    expect(() => getCommandLineLaunchOptions(['Codiff', ...args])).toThrow(/review source/);
    await expect(
      execFileAsync(resolve(import.meta.dirname, '../../bin/codiff-app'), args, {
        cwd: logger.directory,
        env: logger.env,
      }),
    ).rejects.toThrow(/review source/);
  });
  expect(await logger.readArgs()).toEqual(['']);
});

test('relative checkout selection resolves a directory-shaped branch against that checkout', async () => {
  await using logger = await createFakeOpenLogger();
  await mkdir(join(logger.directory, 'base'));
  await symlink(refRepositoryPath, join(logger.directory, 'repo'), 'dir');
  const require = createRequire(import.meta.url);
  const {
    getCommandLineLaunchOptions,
    getCommandLineRepositoryPath,
  } = require('../../electron/main/command-line.cjs');
  await withCwd(logger.directory, async () => {
    const requestedPath = join(process.cwd(), 'repo');
    expect(parseArguments(['base', 'repo'])).toMatchObject({
      branchRef: 'base',
      requestedPath,
    });
    expect(getCommandLineLaunchOptions(['Codiff', 'base', 'repo']).source).toMatchObject({
      ref: 'base',
      type: 'branch-working-tree',
    });
    expect(getCommandLineRepositoryPath(['Codiff', 'base', 'repo'])).toBe('repo');
    await execFileAsync(resolve(import.meta.dirname, '../../bin/codiff-app'), ['base', 'repo'], {
      cwd: logger.directory,
      env: logger.env,
    });
  });
  expect(await logger.readArgs()).toContain('--branch');
  expect(await logger.readArgs()).toContain('base');
});

test.each(['HEAD~1..HEAD', 'HEAD~1...HEAD', 'missing..HEAD'])(
  'range-shaped directory %s does not erase an explicit comparison',
  async (target) => {
    await mkdir(join(refRepositoryPath, target));
    await using logger = await createFakeOpenLogger();
    await logger.reset();
    const require = createRequire(import.meta.url);
    const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
    await withCwd(refRepositoryPath, async () => {
      expect(parseArguments([target]).range).toBeDefined();
      expect(getCommandLineLaunchOptions(['Codiff', target]).source.type).toBe('range');
      const launch = execFileAsync(resolve(import.meta.dirname, '../../bin/codiff-app'), [target], {
        cwd: refRepositoryPath,
        env: logger.env,
      });
      if (target.startsWith('missing')) {
        await expect(launch).rejects.toThrow(/invalid range/);
        expect(await logger.readArgs()).toEqual(['']);
      } else {
        await launch;
        expect(await logger.readArgs()).toContain(target);
      }
      expect(parseArguments([`./${target}`]).range).toBeUndefined();
    });
  },
);

test('Git-invalid dotted-left composite rejects without substituting local content', async () => {
  await using logger = await createFakeOpenLogger();
  await logger.reset();
  const repositoryPath = join(logger.directory, 'repo');
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial']);
  await writeFile(join(repositoryPath, 'local.txt'), 'must not substitute local changes\n');
  const target = 'HEAD^{/..}..HEAD';
  await git(repositoryPath, ['rev-parse', '--verify', 'HEAD^{/..}^{commit}']);
  await expect(git(repositoryPath, ['rev-parse', '--symbolic', target])).rejects.toThrow();
  const require = createRequire(import.meta.url);
  const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
  const { readRepositoryState } = require('../../electron/git-state.cjs');
  const parsed = parseArguments([target, repositoryPath]);
  for (const source of [
    getReviewSource({
      branchRef: parsed.branchRef ?? null,
      commitRef: parsed.commitRef,
      pullRequestProvider: parsed.pullRequestProvider ?? null,
      pullRequestUrl: parsed.pullRequestUrl,
      range: parsed.range ?? null,
    }),
    getCommandLineLaunchOptions(['Codiff', target, repositoryPath]).source,
  ]) {
    expect(source.type).toBe('range');
    await expect(readRepositoryState(repositoryPath, source)).rejects.toThrow();
  }
  await expect(
    execFileAsync(resolve('bin/codiff-app'), [target, repositoryPath], { env: logger.env }),
  ).rejects.toThrow('invalid range');
  expect(await logger.readArgs()).toEqual(['']);
});

test.each(['node', 'electron'])(
  '%s range entry rejects missing endpoints instead of local content',
  async (entry) => {
    await using directory = await createTemporaryDirectory('codiff-missing-range-');
    await git(directory.path, ['init']);
    await git(directory.path, ['commit', '--allow-empty', '-m', 'initial']);
    await writeFile(join(directory.path, 'local.txt'), 'must not substitute local changes\n');
    const require = createRequire(import.meta.url);
    const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
    const { readRepositoryState } = require('../../electron/git-state.cjs');
    for (const range of [
      { base: 'definitely-missing', head: 'HEAD', symmetric: false },
      { base: 'HEAD', head: 'definitely-missing', symmetric: true },
    ]) {
      const target = `${range.base}${range.symmetric ? '...' : '..'}${range.head}`;
      const parsed = parseArguments([target, directory.path]);
      const source =
        entry === 'node'
          ? getReviewSource({
              branchRef: parsed.branchRef ?? null,
              commitRef: parsed.commitRef,
              pullRequestProvider: parsed.pullRequestProvider ?? null,
              pullRequestUrl: parsed.pullRequestUrl,
              range: parsed.range ?? null,
            })
          : getCommandLineLaunchOptions(['Codiff', target, directory.path]).source;
      await expect(readRepositoryState(directory.path, source)).rejects.toThrow();
      expect(source).toEqual({ ...range, type: 'range' });
    }
  },
);

test.each(['..', '...'])(
  'packaged helper preserves %s source when a ref disappears before Electron',
  async (separator) => {
    await using logger = await createFakeOpenLogger();
    const repositoryPath = join(logger.directory, 'repo');
    await mkdir(repositoryPath);
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repositoryPath, ['branch', 'disappearing']);
    await writeFile(join(repositoryPath, 'local.txt'), 'must not substitute local changes\n');
    await execFileAsync(
      resolve('bin/codiff-app'),
      [`HEAD${separator}disappearing`, repositoryPath],
      {
        env: logger.env,
      },
    );
    await git(repositoryPath, ['branch', '-D', 'disappearing']);
    const args = ['Codiff', ...(await logger.readArgs()).slice(3)];
    const require = createRequire(import.meta.url);
    const { getCommandLineLaunchOptions } = require('../../electron/main/command-line.cjs');
    const { readRepositoryState } = require('../../electron/git-state.cjs');
    const { source } = getCommandLineLaunchOptions(args);
    await expect(readRepositoryState(repositoryPath, source)).rejects.toThrow();
    expect(source).toEqual({
      base: 'HEAD',
      head: 'disappearing',
      symmetric: separator === '...',
      type: 'range',
    });
  },
);

test.each(['bin/codiff-app', 'bin/codiff.js'])(
  'desktop executable %s advertises its launch contract without opening',
  async (entry) => {
    await using logger = await createFakeOpenLogger();
    const command = entry.endsWith('.js') ? process.execPath : resolve(entry);
    const prefix = entry.endsWith('.js') ? [resolve(entry)] : [];
    const help = await execFileAsync(command, [...prefix, '--help'], { env: logger.env });
    expect(help.stdout).toContain('--capabilities');
    expect(help.stdout).toContain('desktop-source-v1');
    const result = await execFileAsync(command, [...prefix, '--capabilities'], { env: logger.env });
    expect(JSON.parse(result.stdout)).toEqual({
      sources: ['working-tree', 'commit', 'branch-working-tree', 'range', 'pull-request'],
      version: 1,
    });
    await expect(readFile(join(logger.directory, 'open-args.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

test('parseArguments reads base...target and base..target as a range', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['-w', 'base...target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: true },
      requestedPath: refRepositoryPath,
    });
    expect(parseArguments(['base..target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: false },
    });
    expect(parseArguments(['nope...nada']).range).toEqual({
      base: 'nope',
      head: 'nada',
      symmetric: true,
    });
  });
});

beforeAll(async () => {
  const repository = await createCliReferenceRepository();
  refRepositoryPath = repository.path;
});

afterAll(async () => {
  if (refRepositoryPath) {
    await removeGitTestDirectory(refRepositoryPath);
  }
});
