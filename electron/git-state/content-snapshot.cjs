// @ts-check

const { constants, promises: fs } = require('node:fs');
const { dirname, join } = require('node:path');
const {
  getImageMimeType,
  git,
  gitBufferWithInput,
  IMAGE_FILE_LIMIT,
  validateRepositoryPath,
} = require('./common.cjs');
const { withBranchSnapshot } = require('./branch-snapshot.cjs');
const { readComparisonImageContent, readComparisonSectionContent } = require('./comparison.cjs');
const workingTree = require('./working-tree.cjs');

/**
 * Freeze changed raw revisions in a caller-owned directory. The native readers
 * retain their text/image limits and build patches only when requested.
 * @param {import('../../core/types.ts').RepositoryState} state
 * @param {string} directory
 */
const captureRepositoryContent = async (state, directory) => {
  if (state.source.type !== 'working-tree' && state.source.type !== 'branch-working-tree') {
    throw new Error('Only local mutable comparisons need a content snapshot.');
  }
  const worktree = join(directory, 'worktree');
  const gitDirectory = join(directory, 'git');
  const cleanEnvironment = { ...process.env };
  for (const key of (await git(state.root, ['rev-parse', '--local-env-vars'])).trim().split('\n')) {
    delete cleanEnvironment[key];
  }
  const objectFormat = (await git(state.root, ['rev-parse', '--show-object-format'])).trim();
  await git(
    directory,
    [
      'init',
      '--template=',
      `--object-format=${objectFormat}`,
      `--separate-git-dir=${gitDirectory}`,
      worktree,
    ],
    { env: cleanEnvironment },
  );
  const env = {
    ...cleanEnvironment,
    GIT_AUTHOR_EMAIL: 'snapshot@codiff.local',
    GIT_AUTHOR_NAME: 'Codiff Snapshot',
    GIT_COMMITTER_EMAIL: 'snapshot@codiff.local',
    GIT_COMMITTER_NAME: 'Codiff Snapshot',
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: worktree,
    GIT_INDEX_FILE: join(gitDirectory, 'index'),
  };
  const files = state.files.filter(
    (file) =>
      file.sections.some((section) => section.summary?.canLoad !== false) ||
      Boolean(getImageMimeType(file.path)),
  );
  const paths = [
    ...new Set(files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])])),
  ];
  for (const path of paths) {
    validateRepositoryPath(path);
    if (path.split('/').some((part) => part.toLowerCase() === '.git')) {
      throw new Error('Git metadata cannot be captured as review content.');
    }
  }
  /** @type {Map<string, string>} */
  const imported = new Map();
  const oversized = new Set();
  /** @type {Map<string, import('../../core/types.ts').DiffImageContentResult>} */
  const unavailableImages = new Map();
  /** @param {string} repo @param {string} raw @param {boolean} tree @param {NodeJS.ProcessEnv} [sourceEnv] */
  const importEntries = async (repo, raw, tree, sourceEnv) => {
    const records = [];
    for (const record of raw.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const path = record.slice(tab + 1);
      const [mode, second, third] = record.slice(0, tab).split(' ');
      const object = tree ? third : second;
      const stage = tree ? '0' : third;
      if (!paths.includes(path) || (tree ? second !== 'blob' : mode === '160000')) continue;
      const size = Number((await git(repo, ['cat-file', '-s', object], { env: sourceEnv })).trim());
      if (size > IMAGE_FILE_LIMIT) {
        oversized.add(path);
        continue;
      }
      let retained = imported.get(object);
      if (!retained) {
        const bytes = await gitBufferWithInput(repo, ['cat-file', 'blob', object], '', {
          env: sourceEnv,
        });
        retained = (
          await gitBufferWithInput(worktree, ['hash-object', '-w', '--stdin'], bytes, { env })
        )
          .toString()
          .trim();
        imported.set(object, retained);
      }
      records.push(`${mode} ${retained} ${stage}\t${path}\0`);
    }
    return records.join('');
  };
  /** @param {string} records */
  const writeIndex = async (records) => {
    await git(worktree, ['read-tree', '--empty'], { env });
    if (records)
      await gitBufferWithInput(worktree, ['update-index', '-z', '--index-info'], records, { env });
  };
  /** @param {string} repo @param {string} ref @param {NodeJS.ProcessEnv} [sourceEnv] */
  const retainTree = async (repo, ref, sourceEnv) => {
    const raw = paths.length
      ? await git(
          repo,
          ['ls-tree', '-rz', ref, '--', ...paths.map((path) => `:(literal)${path}`)],
          { env: sourceEnv },
        )
      : '';
    await writeIndex(await importEntries(repo, raw, true, sourceEnv));
    return (await git(worktree, ['write-tree'], { env })).trim();
  };
  const source = state.source;
  if (source.type === 'branch-working-tree') {
    if (!source.baseRef) throw new Error('The combined comparison must have a resolved base.');
    const oldRef = source.baseRef;
    const retained = await withBranchSnapshot(state.root, async (snapshot) => ({
      oldTree: await retainTree(state.root, oldRef, snapshot.env),
      newTree: await retainTree(state.root, snapshot.tree, snapshot.env),
    }));
    for (const file of files) {
      if (oversized.has(file.path) || oversized.has(file.oldPath)) {
        unavailableImages.set(file.path, {
          status: 'unavailable',
          reason: 'Image exceeds the Codiff image size limit.',
        });
      }
    }
    return {
      /** @param {import('../../core/types.ts').DiffSectionContentRequest} request */
      readSection: (request) =>
        readComparisonSectionContent(
          worktree,
          retained.newTree,
          retained.oldTree,
          files,
          request.path,
          'captured comparison',
          {
            env,
            force: request.force,
            showWhitespace: request.showWhitespace,
            literalPaths: true,
            blobCacheKeys: true,
            section: { kind: 'combined', ref: `combined:${oldRef}` },
          },
        ),
      /** @param {import('../../core/types.ts').DiffImageContentRequest} request */
      readImage: async (request) =>
        unavailableImages.get(request.path) ||
        (await readComparisonImageContent(
          worktree,
          retained.newTree,
          retained.oldTree,
          files,
          request.path,
          'captured comparison',
          env,
        )),
    };
  }
  const head = await git(state.root, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
  if (head.trim()) {
    const tree = await retainTree(state.root, head.trim());
    const commit = (
      await git(
        worktree,
        ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Captured revisions'],
        { env },
      )
    ).trim();
    await git(worktree, ['update-ref', 'HEAD', commit], { env });
  }
  const index = paths.length
    ? await git(state.root, [
        'ls-files',
        '--stage',
        '-z',
        '--',
        ...paths.map((path) => `:(literal)${path}`),
      ])
    : '';
  await writeIndex(await importEntries(state.root, index, false));
  for (const file of files) {
    const original = join(state.root, file.path);
    const stat = await fs.lstat(original).catch(() => undefined);
    if (stat?.isFile() || stat?.isSymbolicLink()) {
      if (stat.size > IMAGE_FILE_LIMIT) {
        oversized.add(file.path);
      } else {
        const destination = join(worktree, file.path);
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.cp(original, destination, {
          mode: constants.COPYFILE_FICLONE,
          verbatimSymlinks: true,
        });
      }
    }
    if (oversized.has(file.path) || oversized.has(file.oldPath)) {
      for (const section of file.sections) {
        unavailableImages.set(
          `${file.path}:${section.kind}`,
          await workingTree.readDiffImageContent(state.root, {
            kind: section.kind,
            path: file.path,
            source,
          }),
        );
      }
    }
  }
  return {
    /** @param {import('../../core/types.ts').DiffSectionContentRequest} request */
    readSection: (request) => workingTree.readDiffSectionContent(worktree, request, env),
    /** @param {import('../../core/types.ts').DiffImageContentRequest} request */
    readImage: async (request) =>
      unavailableImages.get(`${request.path}:${request.kind}`) ||
      (await workingTree.readDiffImageContent(worktree, request, env)),
  };
};

module.exports = { captureRepositoryContent };
