// @ts-check

const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join, resolve } = require('node:path');
const { git, gitBufferWithInput, parseStatus } = require('./common.cjs');
const { listUntrackedItems } = require('./working-tree.cjs');

/**
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {{
 *   conflictedPaths: ReadonlyArray<string>;
 *   env: NodeJS.ProcessEnv;
 *   tree: string;
 *   untrackedPlaceholders: ReadonlyArray<StatusItem>;
 * }} BranchSnapshot
 */

const addArgs = ['-c', 'core.splitIndex=false', 'add'];

/**
 * @template T
 * @param {string} repoRoot
 * @param {(snapshot: BranchSnapshot) => Promise<T>} run
 */
const withBranchSnapshot = async (repoRoot, run) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-branch-snapshot-'));

  try {
    const [indexPath, objectsPath] = (
      await git(repoRoot, ['rev-parse', '--git-path', 'index', '--git-path', 'objects'])
    )
      .trim()
      .split('\n')
      .map((path) => resolve(repoRoot, path));
    const configCount = Number(process.env.GIT_CONFIG_COUNT || 0);
    const env = {
      ...process.env,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        JSON.stringify(objectsPath),
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(delimiter),
      GIT_CONFIG_COUNT: String(configCount + 1),
      [`GIT_CONFIG_KEY_${configCount}`]: 'lfs.storage',
      [`GIT_CONFIG_VALUE_${configCount}`]: join(directory, 'lfs'),
      GIT_INDEX_FILE: join(directory, 'index'),
      GIT_OBJECT_DIRECTORY: join(directory, 'objects'),
    };
    await fs.mkdir(env.GIT_OBJECT_DIRECTORY);
    try {
      await fs.copyFile(indexPath, env.GIT_INDEX_FILE);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    const [untracked, originalStatus] = await Promise.all([
      listUntrackedItems(repoRoot),
      git(repoRoot, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uno'], { env }),
    ]);
    const status = parseStatus(originalStatus);
    const cachedRemovals = status.filter((item) => item.staged && item.status === 'deleted');
    const removedUntracked = cachedRemovals.length
      ? (
          await git(
            repoRoot,
            [
              'ls-files',
              '--others',
              '--exclude-standard',
              '-z',
              '--',
              ...cachedRemovals.map((item) => `:(literal)${item.path}`),
            ],
            { env },
          )
        )
          .split('\0')
          .filter(Boolean)
      : [];
    const untrackedPaths = [
      ...new Set([
        ...untracked.filter((item) => !item.directory).map((item) => item.path),
        ...removedUntracked,
      ]),
    ];
    await git(repoRoot, [...addArgs, '--update'], { env });
    if (untrackedPaths.length > 0) {
      await gitBufferWithInput(
        repoRoot,
        [...addArgs, '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'],
        Buffer.from(`${untrackedPaths.map((path) => `:(literal)${path}`).join('\0')}\0`),
        { env },
      );
    }

    const tree = (await git(repoRoot, ['write-tree'], { env })).trim();
    return await run({
      conflictedPaths: status
        .filter((item) => item.status === 'conflicted')
        .map((item) => item.path),
      env,
      tree,
      untrackedPlaceholders: untracked.filter((item) => item.directory),
    });
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
};

module.exports = { withBranchSnapshot };
