import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vite-plus/test';
import { fileHasVisibleDiff } from '../lib/diff.ts';
import type { ReviewSource } from '../types.ts';
import { type RepositoryState } from '../types.ts';
import {
  type GitStateModule,
  git,
  writeRepoFile,
  commitAll,
  withRepo,
} from './helpers/git-state.ts';
import { createTemporaryDirectory, createTemporaryEnvironment } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

const observableFiles = (comparison: RepositoryState) =>
  comparison.files.map((file) => ({
    oldPath: file.oldPath,
    path: file.path,
    sections: file.sections.map((section) => ({
      binary: section.binary,
      newContents: section.newFile?.contents,
      oldContents: section.oldFile?.contents,
      patch: section.patch,
    })),
    status: file.status,
  }));

const require = createRequire(import.meta.url);

const { withBranchSnapshot } = require('../../electron/git-state/branch-snapshot.cjs') as {
  withBranchSnapshot: (
    repo: string,
    run: (snapshot: { env: NodeJS.ProcessEnv; tree: string }) => Promise<void>,
  ) => Promise<void>;
};

const {
  listRepositoryHistory,
  readDiffImageContent,
  readDiffSectionContent,
  readRepositoryState,
  readWalkthroughRepositoryState,
  resolvePullRequestContentRefs,
  validateRepositoryPath,
} = require('../../electron/git-state.cjs') as GitStateModule;

const pullRequestFixture = {
  number: 7,
  owner: 'nkzw-tech',
  repo: 'codiff',
  url: 'https://github.com/nkzw-tech/codiff/pull/7',
};

test('committed comparisons preserve both endpoints in rename patches', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'one\ntwo\nthree\nfour\n');
    await commitAll(repo, 'base');
    const target = (await git(repo, ['branch', '--show-current'])).trim();
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await git(repo, ['mv', 'old.txt', 'new.txt']);
    await commitAll(repo, 'rename');
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const expectedPatch = await git(repo, [
      'diff',
      '--patch',
      '--no-ext-diff',
      '--find-renames',
      base,
      head,
      '--',
      'old.txt',
      'new.txt',
    ]);
    expect(expectedPatch).toContain('similarity index 100%');
    expect(expectedPatch).toContain('rename from old.txt');
    expect(expectedPatch).not.toContain('@@');
    const sources: ReadonlyArray<ReviewSource> = [
      { ref: head, type: 'commit' },
      { base, head, symmetric: false, type: 'range' },
      { ref: target, type: 'branch' },
      { baseRef: base, headRef: head, ref: target, type: 'branch-diff' },
    ];
    for (const source of sources) {
      const state = await readRepositoryState(repo, source);
      expect(state.files[0]).toMatchObject({
        oldPath: 'old.txt',
        path: 'new.txt',
        status: 'renamed',
      });
      expect(state.files[0].sections[0].patch).toBe(expectedPatch);
      const section = await readDiffSectionContent(repo, {
        kind: 'commit',
        path: 'new.txt',
        source: state.source,
      });
      expect(section.patch).toBe(expectedPatch);
    }
  });
});

test.each([false, true])(
  'committed comparisons honor showWhitespace=%s like branch+',
  async (showWhitespace) => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'whitespace.txt', 'const amount = 1;\n');
      await writeRepoFile(repo, 'meaningful.txt', 'const value = 1;\n');
      await commitAll(repo, 'base');
      const target = (await git(repo, ['branch', '--show-current'])).trim();
      const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['checkout', '-b', 'feature']);
      await writeRepoFile(repo, 'whitespace.txt', 'const amount  =  1;\n');
      await writeRepoFile(repo, 'meaningful.txt', 'const value  =  2;\n');
      const combined = await readRepositoryState(
        repo,
        { ref: target, type: 'branch-working-tree' },
        { showWhitespace },
      );
      const expected = new Map(combined.files.map((file) => [file.path, file.sections[0]]));
      expect(expected.get('whitespace.txt')?.patch.includes('@@')).toBe(showWhitespace);
      expect(expected.get('meaningful.txt')?.patch).toContain('@@');
      await commitAll(repo, 'final changes');
      const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      const sources: ReadonlyArray<ReviewSource> = [
        { ref: head, type: 'commit' },
        { base, head, symmetric: false, type: 'range' },
        { ref: target, type: 'branch' },
        { baseRef: base, headRef: head, ref: target, type: 'branch-diff' },
      ];
      for (const source of [...sources, undefined]) {
        const state = source
          ? await readRepositoryState(repo, source, { showWhitespace })
          : await readWalkthroughRepositoryState(repo, undefined, { showWhitespace });
        expect(state.files.map((file) => file.path)).toEqual(
          combined.files.map((file) => file.path),
        );
        for (const file of state.files) {
          const section = expected.get(file.path)!;
          expect(file.sections[0].patch).toBe(section.patch);
          const loaded = await readDiffSectionContent(repo, {
            force: true,
            kind: 'commit',
            path: file.path,
            showWhitespace,
            source: state.source,
          });
          expect(loaded.patch).toBe(section.patch);
          expect(loaded.oldFile?.contents).toBe(section.oldFile?.contents);
          expect(loaded.newFile?.contents).toBe(section.newFile?.contents);
        }
      }
    });
  },
);

test.each(['commit', 'rebase'])(
  'branch+ refreshes resolved endpoints after a %s while lazy reads retain their base',
  async (operation) => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'file.txt', 'base\n');
      await writeRepoFile(repo, 'target.txt', 'base\n');
      await commitAll(repo, 'base');
      const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      await git(repo, ['checkout', '-b', 'feature']);
      await writeRepoFile(repo, 'file.txt', 'feature one\n');
      await commitAll(repo, 'feature one');
      const initial = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
      const source = initial.source as Extract<ReviewSource, { type: 'branch-working-tree' }>;

      if (operation === 'commit') {
        await writeRepoFile(repo, 'file.txt', 'feature two\n');
        await commitAll(repo, 'feature two');
      } else {
        await git(repo, ['checkout', target]);
        await writeRepoFile(repo, 'target.txt', 'target advance\n');
        await commitAll(repo, 'target advance');
        await git(repo, ['checkout', 'feature']);
        await git(repo, ['rebase', target]);
      }

      const lazy = await readDiffSectionContent(repo, {
        kind: 'combined',
        path: 'file.txt',
        source,
      });
      expect(lazy.id).toBe(initial.files[0].sections[0].id);
      const refreshed = await readRepositoryState(repo, source);
      expect(refreshed.source).toMatchObject({
        baseRef: (await git(repo, ['merge-base', target, 'HEAD'])).trim(),
        headRef: (await git(repo, ['rev-parse', 'HEAD'])).trim(),
        ref: target,
        type: 'branch-working-tree',
      });
      expect(refreshed.files.map((file) => file.path)).toEqual(['file.txt']);
      const history = await listRepositoryHistory(repo, 10, refreshed.source);
      expect(history.entries.map((entry) => (entry as { subject: string }).subject)).toEqual(
        operation === 'commit' ? ['feature two', 'feature one'] : ['feature one'],
      );
    });
  },
);

test('branch+ preserves racy-index checks for same-size text and image edits', async () => {
  await withRepo(async (repo) => {
    const originalImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const changedImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs7sAAAAASUVORK5CYII=',
      'base64',
    );
    const cachedTime = new Date('2020-01-01T00:00:00.000Z');
    const paths = ['pixel.png', 'same-size.txt'];
    await git(repo, ['config', 'core.checkStat', 'minimal']);
    await git(repo, ['config', 'core.trustctime', 'false']);
    await writeRepoFile(repo, 'pixel.png', originalImage);
    await writeRepoFile(repo, 'same-size.txt', 'before\n');
    for (const path of paths) {
      await utimes(join(repo, path), cachedTime, cachedTime);
    }
    await commitAll(repo, 'base');
    const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await writeRepoFile(repo, 'pixel.png', changedImage);
    await writeRepoFile(repo, 'same-size.txt', 'after!\n');
    for (const path of paths) {
      await utimes(join(repo, path), cachedTime, cachedTime);
    }
    const indexPath = join(repo, '.git/index');
    await utimes(indexPath, cachedTime, cachedTime);
    const originalIndex = readFileSync(indexPath);
    const originalIndexMtime = (await stat(indexPath)).mtimeMs;
    expect(
      (await git(repo, ['--no-optional-locks', 'diff', '--name-only', 'HEAD'])).trim().split('\n'),
    ).toEqual(paths);

    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    expect(state.files.map((file) => file.path)).toEqual(paths);
    expect(state.files.find((file) => file.path === 'same-size.txt')?.sections[0]).toMatchObject({
      kind: 'combined',
      newFile: { contents: 'after!\n' },
      oldFile: { contents: 'before\n' },
    });
    const image = await readDiffImageContent(repo, {
      kind: 'combined',
      path: 'pixel.png',
      source: state.source,
    });
    expect(image).toMatchObject({
      newImage: { dataUrl: `data:image/png;base64,${changedImage.toString('base64')}` },
      oldImage: { dataUrl: `data:image/png;base64,${originalImage.toString('base64')}` },
      status: 'ready',
    });
    expect(readFileSync(indexPath)).toEqual(originalIndex);
    expect((await stat(indexPath)).mtimeMs).toBe(originalIndexMtime);
  });
});

test.each(['loose', 'packed', 'alternate', 'sparse'])(
  'branch+ preserves original %s object bytes and timestamps across reads',
  async (storage) => {
    await withRepo(async (originalRepo) => {
      const originalImage = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const changedImage = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs7sAAAAASUVORK5CYII=',
        'base64',
      );
      await writeRepoFile(originalRepo, 'file.txt', 'base\n');
      await writeRepoFile(originalRepo, 'pixel.png', originalImage);
      await writeRepoFile(originalRepo, 'stored.png', changedImage);
      await writeRepoFile(originalRepo, 'included/file.txt', 'included\n');
      await writeRepoFile(originalRepo, 'excluded/nested/file.txt', 'excluded\n');
      await commitAll(originalRepo, 'base');
      const base = (await git(originalRepo, ['rev-parse', 'HEAD'])).trim();
      await writeRepoFile(originalRepo, 'file.txt', 'committed\n');
      await commitAll(originalRepo, 'feature');
      if (storage === 'packed') {
        await git(originalRepo, ['repack', '-ad']);
      }
      if (storage === 'sparse') {
        await git(originalRepo, ['sparse-checkout', 'set', '--cone', '--sparse-index', 'included']);
      }
      await using cloneDirectory = await createTemporaryDirectory('codiff-shared-clone-');
      const repo = storage === 'alternate' ? join(cloneDirectory.path, 'checkout') : originalRepo;
      if (storage === 'alternate') {
        await git(originalRepo, ['clone', '--shared', originalRepo, repo]);
      }
      await writeRepoFile(repo, 'file.txt', 'working\n');
      await writeRepoFile(repo, 'copy.txt', 'committed\n');
      await writeRepoFile(repo, 'pixel.png', changedImage);
      const objects = join(originalRepo, '.git/objects');
      const readObjects = async (
        directory = objects,
      ): Promise<
        Array<{
          contents: Buffer;
          ctimeNs: bigint;
          mtimeNs: bigint;
          path: string;
        }>
      > => {
        const entries = await readdir(directory, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              return readObjects(path);
            }
            const metadata = await stat(path, { bigint: true });
            return [
              {
                contents: readFileSync(path),
                ctimeNs: metadata.ctimeNs,
                mtimeNs: metadata.mtimeNs,
                path,
              },
            ];
          }),
        );
        return files.flat().sort((left, right) => left.path.localeCompare(right.path));
      };
      const oldTime = new Date('2020-01-01T00:00:00.000Z');
      for (const { path } of await readObjects()) {
        await utimes(path, oldTime, oldTime);
      }
      const before = await readObjects();
      const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
      expect(await readObjects()).toEqual(before);
      const loaded = await readDiffSectionContent(repo, {
        force: true,
        kind: 'combined',
        path: 'file.txt',
        source: state.source,
      });
      expect(loaded.oldFile?.contents).toBe('base\n');
      expect(loaded.newFile?.contents).toBe('working\n');
      expect(await readObjects()).toEqual(before);
      const image = await readDiffImageContent(repo, {
        kind: 'combined',
        path: 'pixel.png',
        source: state.source,
      });
      expect(image).toMatchObject({
        newImage: { dataUrl: `data:image/png;base64,${changedImage.toString('base64')}` },
        oldImage: { dataUrl: `data:image/png;base64,${originalImage.toString('base64')}` },
        status: 'ready',
      });
      expect(await readObjects()).toEqual(before);
      await readRepositoryState(repo, state.source);
      expect(await readObjects()).toEqual(before);
    });
  },
);

test('branch+ reads C-quoted alternate object paths without changing their timestamps', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await using alternateDirectory = await createTemporaryDirectory('codiff-quoted-alternate-');
    const alternate = join(alternateDirectory.path, 'objects-\u0007\v\u001b\t-\\a-"-雪');
    await rename(join(repo, '.git/objects'), alternate);
    await mkdir(join(repo, '.git/objects/info'), { recursive: true });
    await writeFile(join(repo, '.git/objects/info/alternates'), `${alternate}\n`);
    const object = (await git(repo, ['rev-parse', 'HEAD:file.txt'])).trim();
    const objectPath = join(alternate, object.slice(0, 2), object.slice(2));
    const before = await stat(objectPath, { bigint: true });
    await writeRepoFile(repo, 'file.txt', 'working\n');
    const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
    const loaded = await readDiffSectionContent(repo, {
      force: true,
      kind: 'combined',
      path: 'file.txt',
      source: state.source,
    });
    expect(loaded.oldFile?.contents).toBe('base\n');
    expect(loaded.newFile?.contents).toBe('working\n');
    const after = await stat(objectPath, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'branch+ can snapshot read-only alternate object directories without changing them',
  async () => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'file.txt', 'base\n');
      await commitAll(repo, 'base');
      const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await using alternateDirectory = await createTemporaryDirectory('codiff-readonly-alternate-');
      const alternate = join(alternateDirectory.path, 'objects');
      await rename(join(repo, '.git/objects'), alternate);
      await mkdir(join(repo, '.git/objects/info'), { recursive: true });
      await writeFile(join(repo, '.git/objects/info/alternates'), `${alternate}\n`);
      const directories = [
        alternate,
        ...(await readdir(alternate, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(alternate, entry.name)),
      ];
      await Promise.all(directories.map((directory) => chmod(directory, 0o555)));
      try {
        const before = await Promise.all(
          directories.map(async (directory) => {
            const metadata = await stat(directory, { bigint: true });
            return [metadata.mode, metadata.mtimeNs, metadata.ctimeNs];
          }),
        );
        await writeRepoFile(repo, 'file.txt', 'working\n');
        const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
        const loaded = await readDiffSectionContent(repo, {
          force: true,
          kind: 'combined',
          path: 'file.txt',
          source: state.source,
        });
        expect(loaded.oldFile?.contents).toBe('base\n');
        expect(loaded.newFile?.contents).toBe('working\n');
        const after = await Promise.all(
          directories.map(async (directory) => {
            const metadata = await stat(directory, { bigint: true });
            return [metadata.mode, metadata.mtimeNs, metadata.ctimeNs];
          }),
        );
        expect(after).toEqual(before);
      } finally {
        await Promise.all(directories.map((directory) => chmod(directory, 0o755)));
      }
    });
  },
);

test.skipIf(process.platform !== 'linux')(
  'branch+ preserves non-UTF-8 alternate object paths',
  async () => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'file.txt', 'base\n');
      await commitAll(repo, 'base');
      const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      const object = (await git(repo, ['rev-parse', 'HEAD:file.txt'])).trim();
      await using alternateDirectory = await createTemporaryDirectory('codiff-byte-alternate-');
      const alternate = Buffer.concat([
        Buffer.from(join(alternateDirectory.path, 'objects-')),
        Buffer.from([0xff, 0xfe]),
      ]);
      await rename(join(repo, '.git/objects'), alternate);
      await mkdir(join(repo, '.git/objects/info'), { recursive: true });
      await writeFile(
        join(repo, '.git/objects/info/alternates'),
        Buffer.concat([alternate, Buffer.from('\n')]),
      );
      const objectPath = Buffer.concat([
        alternate,
        Buffer.from(`/${object.slice(0, 2)}/${object.slice(2)}`),
      ]);
      const beforeContents = readFileSync(objectPath);
      const before = await stat(objectPath, { bigint: true });
      expect(await git(repo, ['cat-file', '-p', object])).toBe('base\n');
      await writeRepoFile(repo, 'file.txt', 'working\n');
      const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
      const loaded = await readDiffSectionContent(repo, {
        force: true,
        kind: 'combined',
        path: 'file.txt',
        source: state.source,
      });
      expect(loaded.oldFile?.contents).toBe('base\n');
      expect(loaded.newFile?.contents).toBe('working\n');
      expect(readFileSync(objectPath)).toEqual(beforeContents);
      const after = await stat(objectPath, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).toBe(before.ctimeNs);
    });
  },
);

test('branch+ retries a cache copy interrupted by Git repacking', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const object = (await git(repo, ['rev-parse', 'HEAD:file.txt'])).trim();
    const objectPath = await realpath(
      join(repo, '.git/objects', object.slice(0, 2), object.slice(2)),
    );
    await writeRepoFile(repo, 'file.txt', 'working\n');
    const fsPromises = require('node:fs').promises as typeof import('node:fs/promises');
    const copy = fsPromises.cp;
    let repacked = false;
    const copySpy = vi
      .spyOn(fsPromises, 'cp')
      .mockImplementationOnce((source, destination, options) =>
        copy(source, destination, {
          ...options,
          filter: async (filename, target) => {
            if (filename === objectPath && !repacked) {
              await git(repo, ['repack', '-ad']);
              repacked = true;
            }
            return (await options?.filter?.(filename, target)) ?? true;
          },
        }),
      );
    try {
      const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
      expect(repacked).toBe(true);
      expect(copySpy).toHaveBeenCalledTimes(2);
      expect(state.files[0].sections[0]).toMatchObject({
        newFile: { contents: 'working\n' },
        oldFile: { contents: 'base\n' },
      });
    } finally {
      copySpy.mockRestore();
    }
  });
});

test('branch+ preserves index-only attribute fallbacks', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, '.gitattributes', '*.txt text eol=lf\n');
    await writeRepoFile(repo, 'file.txt', 'base\r\n');
    await writeRepoFile(repo, 'unchanged.bin', 'unchanged binary object\n');
    await commitAll(repo, 'base');
    const unchangedObject = (await git(repo, ['rev-parse', 'HEAD:unchanged.bin'])).trim();
    await git(repo, ['update-index', '--skip-worktree', '.gitattributes']);
    await rm(join(repo, '.gitattributes'));
    await writeRepoFile(repo, 'file.txt', 'working\r\n');
    await withBranchSnapshot(repo, async ({ env, tree }) => {
      const writeEnv = { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined };
      const { stdout: working } = await execFileAsync(
        'git',
        ['-C', repo, 'show', `${tree}:file.txt`],
        {
          encoding: 'utf8',
          env: writeEnv,
        },
      );
      expect(working).toBe('working\n');
      const { stdout: unchanged } = await execFileAsync(
        'git',
        ['-C', repo, 'cat-file', '-p', unchangedObject],
        { encoding: 'utf8', env },
      );
      expect(unchanged).toBe('unchanged binary object\n');
    });
  });
});

test('branch+ does not materialize unavailable unchanged sparse blobs', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'included/file.txt', 'base\n');
    await writeRepoFile(repo, 'excluded/file.txt', 'unavailable\n');
    await commitAll(repo, 'base');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const excludedObject = (await git(repo, ['rev-parse', 'HEAD:excluded/file.txt'])).trim();
    await git(repo, ['sparse-checkout', 'set', '--cone', 'included']);
    const excludedPath = join(
      repo,
      '.git/objects',
      excludedObject.slice(0, 2),
      excludedObject.slice(2),
    );
    await rm(excludedPath);
    await writeRepoFile(repo, 'included/file.txt', 'working\n');
    const state = await readRepositoryState(repo, { ref: base, type: 'branch-working-tree' });
    expect(state.files.map((file) => file.path)).toEqual(['included/file.txt']);
    const loaded = await readDiffSectionContent(repo, {
      force: true,
      kind: 'combined',
      path: 'included/file.txt',
      source: state.source,
    });
    expect(loaded.oldFile?.contents).toBe('base\n');
    expect(loaded.newFile?.contents).toBe('working\n');
    await expect(stat(excludedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('branch+ matches staging and committing all changes without changing the repository', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await writeRepoFile(repo, 'reverted.txt', 'base\n');
    await writeRepoFile(repo, 'deleted.txt', 'base\n');
    await writeRepoFile(repo, 'unchanged.txt', 'base\n');
    await commitAll(repo, 'base');
    const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await writeRepoFile(repo, 'file.txt', 'committed\n');
    await writeRepoFile(repo, 'reverted.txt', 'committed\n');
    await writeRepoFile(repo, 'temporary.txt', 'temporary\n');
    await writeRepoFile(repo, 'committed.txt', 'branch-only\n');
    await commitAll(repo, 'feature');
    await writeRepoFile(repo, 'file.txt', 'staged\n');
    await git(repo, ['add', 'file.txt']);
    await writeRepoFile(repo, 'file.txt', 'final\n');
    await writeRepoFile(repo, 'reverted.txt', 'base\n');
    await rm(join(repo, 'temporary.txt'));
    await rm(join(repo, 'deleted.txt'));
    await writeRepoFile(repo, 'new.txt', 'untracked\n');
    const refreshedTime = new Date(Date.now() + 5000);
    await utimes(join(repo, 'unchanged.txt'), refreshedTime, refreshedTime);
    await git(repo, ['config', 'core.splitIndex', 'true']);
    await git(repo, ['update-index', '--split-index']);
    const index = readFileSync(join(repo, '.git/index'));
    const gitDirectory = (await readdir(join(repo, '.git'))).sort();
    const refs = await git(repo, ['show-ref']);
    const objects = await git(repo, ['count-objects', '-v']);

    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    expect(state.files.map((file) => file.path)).toEqual([
      'committed.txt',
      'deleted.txt',
      'file.txt',
      'new.txt',
    ]);
    expect(state.files.every((file) => file.sections.length === 1)).toBe(true);
    expect(state.files.every((file) => file.sections[0].kind === 'combined')).toBe(true);
    expect(state.files.find((file) => file.path === 'file.txt')?.sections[0]).toMatchObject({
      newFile: { contents: 'final\n' },
      oldFile: { contents: 'base\n' },
    });
    expect(state.source).toMatchObject({
      headRef: (await git(repo, ['rev-parse', 'HEAD'])).trim(),
      ref: target,
      type: 'branch-working-tree',
    });
    expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
    expect((await readdir(join(repo, '.git'))).sort()).toEqual(gitDirectory);
    expect(await git(repo, ['show-ref'])).toBe(refs);
    expect(await git(repo, ['count-objects', '-v'])).toBe(objects);
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('final\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('untracked\n');

    await commitAll(repo, 'commit all pending changes');
    const committed = await readRepositoryState(repo, { ref: target, type: 'branch' });
    expect(observableFiles(state)).toEqual(observableFiles(committed));
  });
});

test('branch+ stages from the real index: cached removals, force-added ignored files, and moves', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, '.gitignore', 'ignored.txt\nforce.txt\n');
    await writeRepoFile(repo, 'ignored.txt', 'ignored\n');
    await writeRepoFile(repo, 'keep.txt', 'keep\n');
    await writeRepoFile(repo, 'force.txt', 'force\n');
    await writeRepoFile(repo, 'old.txt', 'one\ntwo\nthree\nfour\n');
    await writeRepoFile(repo, 'rewrite.txt', 'alpha\nbeta\ngamma\ndelta\n');
    await git(repo, ['add', '--all']);
    await git(repo, ['add', '--force', 'ignored.txt', 'force.txt']);
    await git(repo, ['commit', '-m', 'base']);
    const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await git(repo, ['rm', '--cached', 'ignored.txt', 'keep.txt']);
    await writeRepoFile(repo, 'force.txt', 'force edited on disk\n');
    await rename(join(repo, 'old.txt'), join(repo, 'new.txt'));
    await rm(join(repo, 'rewrite.txt'));
    await writeRepoFile(repo, 'moved.txt', 'completely\ndifferent\ncontents\nnow\n');

    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    const byPath = new Map(state.files.map((file) => [file.path, file]));
    expect([...byPath.keys()]).not.toContain('keep.txt');
    expect([...byPath.keys()]).not.toContain('old.txt');
    expect(byPath.get('ignored.txt')?.status).toBe('deleted');
    expect(byPath.get('force.txt')?.sections[0].newFile?.contents).toBe('force edited on disk\n');
    expect(byPath.get('new.txt')).toMatchObject({ oldPath: 'old.txt', status: 'renamed' });
    expect(byPath.get('new.txt')?.sections[0].patch).toContain('rename from old.txt');
    const renamedSection = await readDiffSectionContent(repo, {
      kind: 'combined',
      path: 'new.txt',
      source: state.source,
    });
    expect(renamedSection.patch).toBe(byPath.get('new.txt')?.sections[0].patch);
    expect(byPath.get('moved.txt')?.status).toBe('added');
    expect(byPath.get('rewrite.txt')?.status).toBe('deleted');

    await commitAll(repo, 'commit all pending changes');
    const committed = await readRepositoryState(repo, { ref: target, type: 'branch' });
    expect(state.files.map(({ oldPath, path, status }) => ({ oldPath, path, status }))).toEqual(
      committed.files.map(({ oldPath, path, status }) => ({ oldPath, path, status })),
    );
    for (const file of state.files) {
      const committedFile = committed.files.find((item) => item.path === file.path);
      expect(file.sections[0].oldFile?.contents).toBe(committedFile?.sections[0].oldFile?.contents);
      expect(file.sections[0].newFile?.contents).toBe(committedFile?.sections[0].newFile?.contents);
      expect(file.sections[0].patch).toBe(
        await git(repo, [
          'diff',
          '--patch',
          '--no-ext-diff',
          '--find-renames',
          target,
          'HEAD',
          '--',
          ...(file.oldPath ? [file.oldPath, file.path] : [file.path]),
        ]),
      );
    }
  });
});

test('branch+ initial and lazy patches use literal paths', async () => {
  await withRepo(async (repo) => {
    const paths = ['a[1].txt', 'a1.txt', 'star*.txt', 'star1.txt'];
    for (const path of paths) {
      await writeRepoFile(repo, path, `base ${path}\n`);
    }
    await commitAll(repo, 'base');
    const target = (await git(repo, ['branch', '--show-current'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    for (const path of paths) {
      await writeRepoFile(repo, path, `final ${path}\n`);
    }
    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    for (const file of state.files) {
      const expectedPatch = await git(repo, [
        'diff',
        '--patch',
        '--no-ext-diff',
        '--find-renames',
        target,
        '--',
        `:(literal)${file.path}`,
      ]);
      expect(file.sections[0].patch).toBe(expectedPatch);
      const section = await readDiffSectionContent(repo, {
        kind: 'combined',
        path: file.path,
        source: state.source,
      });
      expect(section.patch).toBe(expectedPatch);
    }
  });
});

test
  .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
  .each(['unreadable', 'vanished', 'locked'])(
  'branch+ handles %s untracked staging without losing other changes',
  async (failure) => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'tracked.txt', 'base\n');
      await commitAll(repo, 'base');
      const target = (await git(repo, ['branch', '--show-current'])).trim();
      await git(repo, ['checkout', '-b', 'feature']);
      await writeRepoFile(repo, 'tracked.txt', 'final\n');
      await writeRepoFile(repo, 'valid.txt', 'new\n');
      await writeRepoFile(repo, 'bad.txt', 'unavailable\n');
      const index = readFileSync(join(repo, '.git/index'));
      const refs = await git(repo, ['show-ref']);
      await using wrapperDirectory = await createTemporaryDirectory('codiff-racing-git-');
      const wrapperPath = join(wrapperDirectory.path, 'git');
      await writeFile(
        wrapperPath,
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--pathspec-from-file=-') && process.env.CODIFF_TEST_LOCK_UNTRACKED === 'true') {
  writeFileSync(process.env.GIT_INDEX_FILE + '.lock', 'locked');
}
const result = spawnSync('git', args, {
  env: { ...process.env, PATH: process.env.CODIFF_TEST_ORIGINAL_PATH },
  input: args.some(argument => argument.startsWith('--batch') || argument === '--pathspec-from-file=-') ? readFileSync(0) : undefined,
});
if (args.includes('--others') && process.env.CODIFF_TEST_REMOVE_UNTRACKED === 'true') {
  rmSync(join(args[args.indexOf('-C') + 1], 'bad.txt'), { force: true });
}
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
      );
      await chmod(wrapperPath, 0o755);
      using _environment = createTemporaryEnvironment({
        CODIFF_TEST_LOCK_UNTRACKED: String(failure === 'locked'),
        CODIFF_TEST_ORIGINAL_PATH: process.env.PATH ?? '',
        CODIFF_TEST_REMOVE_UNTRACKED: String(failure === 'vanished'),
        PATH: `${wrapperDirectory.path}:${process.env.PATH ?? ''}`,
      });
      if (failure === 'unreadable') {
        await chmod(join(repo, 'bad.txt'), 0);
      }
      if (failure === 'locked') {
        await expect(
          readRepositoryState(repo, { ref: target, type: 'branch-working-tree' }),
        ).rejects.toThrow('.lock');
        expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
        expect(await git(repo, ['show-ref'])).toBe(refs);
        return;
      }
      const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
      expect(state.files.map((file) => file.path)).toEqual(['tracked.txt', 'valid.txt']);
      expect(state.files[0].sections[0].newFile?.contents).toBe('final\n');
      const section = await readDiffSectionContent(repo, {
        kind: 'combined',
        path: 'valid.txt',
        source: state.source,
      });
      expect(section.newFile?.contents).toBe('new\n');
      expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
      expect(await git(repo, ['show-ref'])).toBe(refs);
    });
  },
);

test('branch+ keeps unresolved conflicts visible without resolving the real index', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await writeRepoFile(repo, 'same.txt', 'base\n');
    await commitAll(repo, 'base');
    const baseBranch = (await git(repo, ['branch', '--show-current'])).trim();
    await git(repo, ['checkout', '-b', 'other']);
    await writeRepoFile(repo, 'file.txt', 'theirs\n');
    await git(repo, ['rm', 'same.txt']);
    await commitAll(repo, 'theirs');
    await git(repo, ['checkout', baseBranch]);
    await writeRepoFile(repo, 'file.txt', 'ours\n');
    await writeRepoFile(repo, 'same.txt', 'ours\n');
    await commitAll(repo, 'ours');
    await expect(git(repo, ['merge', 'other'])).rejects.toThrow();
    await writeRepoFile(repo, 'same.txt', 'base\n');
    const unmerged = await git(repo, ['ls-files', '--unmerged']);
    const index = readFileSync(join(repo, '.git/index'));

    const state = await readRepositoryState(repo, { ref: 'other', type: 'branch-working-tree' });
    expect(state.files.map((file) => [file.path, file.status])).toEqual([
      ['file.txt', 'conflicted'],
      ['same.txt', 'conflicted'],
    ]);
    expect(state.files[0].sections[0]).toMatchObject({
      kind: 'combined',
      oldFile: { contents: 'base\n' },
    });
    expect(state.files[0].sections[0].newFile?.contents).toContain('<<<<<<< HEAD');
    expect(state.files[1].sections[0]).toMatchObject({ kind: 'combined', patch: '' });
    expect(fileHasVisibleDiff(state.files[1], true)).toBe(true);
    expect(await git(repo, ['ls-files', '--unmerged'])).toBe(unmerged);
    expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
  });
});

test('branch+ preserves untracked limits without substituting a capped cached removal', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'zzz.txt', 'base\n');
    await commitAll(repo, 'base');
    const target = (await git(repo, ['branch', '--show-current'])).trim();
    await git(repo, ['rm', '--cached', 'zzz.txt']);
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        writeRepoFile(repo, `new-${String(index).padStart(4, '0')}.txt`, 'untracked\n'),
      ),
    );
    await writeRepoFile(repo, 'dist/generated.txt', 'generated\n');

    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    expect(state.files.some((file) => file.path === 'zzz.txt')).toBe(false);
    expect(state.files.filter((file) => file.path.startsWith('new-'))).toHaveLength(1000);
    expect(state.files.find((file) => file.path === 'dist')?.sections[0]).toMatchObject({
      kind: 'combined',
      loadState: 'directory',
    });
    expect(state.files.some((file) => file.path.startsWith('Untracked files not shown'))).toBe(
      true,
    );
  });
});

test('branch+ lazy reads compare the base with the final contents and keep limits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));
    await writeRepoFile(repo, 'pixel.png', Uint8Array.from([137, 80, 78, 71, 1]));
    await commitAll(repo, 'base');
    const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const committedLines = 'large committed line\n'.repeat(60_000);
    await writeRepoFile(repo, 'large.txt', committedLines);
    await commitAll(repo, 'large commit');
    const finalContents = `${committedLines}end\n`;
    await writeRepoFile(repo, 'large.txt', finalContents);
    await writeRepoFile(repo, 'huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 9, 2, 3]));
    await writeRepoFile(repo, 'pixel.png', Uint8Array.from([137, 80, 78, 71, 1, 2, 3]));

    const state = await readRepositoryState(repo, { ref: target, type: 'branch-working-tree' });
    const section = (path: string) => state.files.find((file) => file.path === path)?.sections[0];
    expect(section('large.txt')).toMatchObject({
      kind: 'combined',
      loadState: 'deferred',
      patch: '',
    });
    expect(section('large.txt')?.newFile).toBeUndefined();
    expect(section('huge.txt')).toMatchObject({
      loadState: 'too-large',
      summary: { canLoad: false },
    });
    expect(section('raw.bin')).toMatchObject({ binary: true, loadState: 'binary' });

    const loaded = await readDiffSectionContent(repo, {
      force: true,
      kind: 'combined',
      path: 'large.txt',
      source: state.source,
    });
    expect(loaded).toMatchObject({
      kind: 'combined',
      loadState: 'ready',
      oldFile: { contents: '' },
    });
    expect(loaded.newFile?.contents).toBe(finalContents);
    expect(loaded.patch).toContain('+end');

    const image = await readDiffImageContent(repo, {
      kind: 'combined',
      path: 'pixel.png',
      source: state.source,
    });
    expect(image).toMatchObject({ newImage: { size: 7 }, oldImage: { size: 5 }, status: 'ready' });

    const previous = state.files.find((file) => file.path === 'large.txt')!;
    await writeRepoFile(repo, 'large.txt', `${committedLines}new\n`);
    const refreshed = await readRepositoryState(repo, state.source);
    const updated = refreshed.files.find((file) => file.path === 'large.txt')!;
    expect(updated.sections[0].id).toBe(previous.sections[0].id);
    expect(updated.fingerprint).not.toBe(previous.fingerprint);
    const refreshedContents = await readDiffSectionContent(repo, {
      force: true,
      kind: 'combined',
      path: 'large.txt',
      source: state.source,
    });
    expect(refreshedContents.newFile?.contents).toBe(`${committedLines}new\n`);
  });
});

test('branch+ disposes its snapshot and leaves the repository untouched when a read fails', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const target = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await writeRepoFile(repo, 'file.txt', 'edited\n');
    await writeRepoFile(repo, 'new.txt', 'untracked\n');
    const index = readFileSync(join(repo, '.git/index'));
    const objects = await git(repo, ['count-objects', '-v']);
    await using temporaryRoot = await createTemporaryDirectory('codiff-branch-plus-tmp-');
    using _environment = createTemporaryEnvironment({
      TEMP: temporaryRoot.path,
      TMP: temporaryRoot.path,
      TMPDIR: temporaryRoot.path,
    });

    await expect(
      readDiffSectionContent(repo, {
        kind: 'combined',
        path: 'missing.txt',
        source: { ref: target, type: 'branch-working-tree' },
      }),
    ).rejects.toThrow('File is not part of this branch.');
    expect(await readdir(temporaryRoot.path)).toEqual([]);
    expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
    expect(await git(repo, ['count-objects', '-v'])).toBe(objects);
    expect(await git(repo, ['status', '--porcelain'])).toBe(' M file.txt\n?? new.txt\n');
  });
});

test('validateRepositoryPath returns normalized repository paths', () => {
  expect(validateRepositoryPath('src/./file.ts')).toBe('src/file.ts');
  expect(validateRepositoryPath('src//nested/file.ts')).toBe('src/nested/file.ts');
});

test('resolvePullRequestContentRefs resolves the diff against the merge base', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const mergeBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    // The pull request head branches off the merge base.
    await writeRepoFile(repo, 'file.txt', 'head change\n');
    await commitAll(repo, 'head');
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/head', headSha]);

    // The base branch advances past the merge base after the PR was opened.
    await git(repo, ['checkout', '-q', mergeBase]);
    await writeRepoFile(repo, 'file.txt', 'base advanced\n');
    await commitAll(repo, 'base advanced');
    const baseTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/base', baseTip]);

    const refs = await resolvePullRequestContentRefs(repo, pullRequestFixture, {
      base: { ref: 'main' },
      head: { sha: headSha },
    });

    expect(refs).toEqual({ base: mergeBase, head: headSha });
    // The base tip is intentionally not used; only the PR's own changes show.
    expect(refs?.base).not.toBe(baseTip);
  });
});
