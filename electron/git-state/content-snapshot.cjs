// @ts-check

const { constants, promises: fs } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const {
  createSection,
  getImageMimeType,
  git,
  gitBufferWithInput,
  IMAGE_FILE_LIMIT,
  parseStatus,
  validateRepositoryPath,
} = require('./common.cjs');
const { withBranchSnapshot } = require('./branch-snapshot.cjs');
const { readComparisonImageContent, readComparisonSectionContent } = require('./comparison.cjs');
const workingTree = require('./working-tree.cjs');

/**
 * Freeze changed raw revisions in a caller-owned directory. The native readers
 * retain their text/image limits. External conversions are frozen while their
 * source execution context exists; ordinary patches are built on demand.
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
  // Freeze rendering settings, without importing source repository locations,
  // hooks, credentials or includes into the private repository.
  const configuration = (await git(state.root, ['config', '--null', '--list']))
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const newline = record.indexOf('\n');
      return newline === -1
        ? [record, 'true']
        : [record.slice(0, newline), record.slice(newline + 1)];
    })
    .filter(([key]) =>
      /^(core\.(filemode|symlinks|autocrlf|eol|safecrlf|ignorecase|quotepath|precomposeunicode)$|diff\.|filter\.)/i.test(
        key,
      ),
    );
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
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(directory, 'empty-config'),
  };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, '');
  for (const [key, value] of configuration) {
    // Programs can depend on arbitrary unchanged files. Retain their native
    // patch results below instead of replaying them in an incomplete checkout.
    if (key.startsWith('filter.') || /^diff\..*\.textconv$/i.test(key)) continue;
    let retainedValue = value;
    if (key.toLowerCase() === 'diff.orderfile' && value) {
      const orderPath = (await git(state.root, ['config', '--path', '--get', key])).trim();
      retainedValue = join(gitDirectory, 'diff-order');
      await fs.copyFile(resolve(state.root, orderPath), retainedValue, constants.COPYFILE_FICLONE);
    }
    await git(worktree, ['config', '--local', '--replace-all', key, retainedValue], { env });
  }
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
  // Resolve hierarchy, macros, index fallback and info/global attributes now.
  // Exact path rules in info/attributes take precedence over mutable inputs.
  const attributes = paths.length
    ? (await git(state.root, ['check-attr', '-z', '--all', '--', ...paths])).split('\0')
    : [];
  const rules = [];
  const externalPaths = new Set();
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const [path, attribute, value] = attributes.slice(index, index + 3);
    if (
      configuration.some(
        ([key]) =>
          (attribute === 'diff' && key === `diff.${value}.textconv`) ||
          (attribute === 'filter' &&
            (key === `filter.${value}.clean` || key === `filter.${value}.process`)),
      )
    ) {
      externalPaths.add(path);
    }
    const pattern = JSON.stringify(`/${path.replace(/[\\*?\[\]]/g, '\\$&')}`);
    const setting =
      value === 'set'
        ? attribute
        : value === 'unset'
          ? `-${attribute}`
          : value === 'unspecified'
            ? `!${attribute}`
            : `${attribute}=${value}`;
    rules.push(`${pattern} ${setting}\n`);
  }
  await fs.mkdir(join(gitDirectory, 'info'), { recursive: true });
  await fs.writeFile(join(gitDirectory, 'info', 'attributes'), rules.join(''));
  /** @type {Map<string, string>} */
  const nativePatches = new Map();
  /** @param {import('../../core/types.ts').DiffSectionContentRequest} request */
  const patchKey = (request) =>
    JSON.stringify([request.path, request.kind, request.showWhitespace !== false]);
  /** @param {(request: import('../../core/types.ts').DiffSectionContentRequest) => Promise<import('../../core/types.ts').DiffSection>} readSection */
  const captureNativePatches = async (readSection) => {
    for (const file of files) {
      if (!externalPaths.has(file.path) && !externalPaths.has(file.oldPath)) continue;
      for (const section of file.sections) {
        if (section.summary?.canLoad === false) continue;
        for (const showWhitespace of [false, true]) {
          const request = { force: true, kind: section.kind, path: file.path, showWhitespace };
          const native = await readSection(request);
          if (native.loadState !== 'ready') continue;
          const path = join(directory, `patch-${nativePatches.size}`);
          await fs.writeFile(path, JSON.stringify({ binary: native.binary, patch: native.patch }));
          nativePatches.set(patchKey(request), path);
        }
      }
    }
  };
  /** @param {import('../../core/types.ts').DiffSectionContentRequest} request */
  const readNativePatch = async (request) => {
    const path = nativePatches.get(patchKey(request));
    return path ? JSON.parse(await fs.readFile(path, 'utf8')) : undefined;
  };
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
    const retained = await withBranchSnapshot(state.root, async (snapshot) => {
      await captureNativePatches((request) =>
        readComparisonSectionContent(
          state.root,
          snapshot.tree,
          oldRef,
          files,
          request.path,
          'captured comparison',
          {
            env: snapshot.env,
            force: request.force,
            showWhitespace: request.showWhitespace,
            literalPaths: true,
            section: { kind: 'combined', ref: `combined:${oldRef}` },
          },
        ),
      );
      return {
        oldTree: await retainTree(state.root, oldRef, snapshot.env),
        newTree: await retainTree(state.root, snapshot.tree, snapshot.env),
      };
    });
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
      readSection: async (request) => {
        const section = await readComparisonSectionContent(
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
        );
        const patch = section.loadState === 'ready' ? await readNativePatch(request) : undefined;
        return patch ? { ...section, ...patch } : section;
      },
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
  const originalItems = new Map(
    externalPaths.size
      ? parseStatus(await git(state.root, ['status', '--porcelain=v1', '-z', '-uno'])).map(
          (item) => [item.path, item],
        )
      : [],
  );
  await captureNativePatches((request) =>
    workingTree.readDiffSectionContent(state.root, { ...request, source }),
  );
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
    readSection: async (request) => {
      const patch = await readNativePatch(request);
      if (!patch) return workingTree.readDiffSectionContent(worktree, request, env);
      const item = originalItems.get(request.path) || {
        path: request.path,
        staged: false,
        status: 'untracked',
        unstaged: true,
        untracked: true,
      };
      return createSection(worktree, item, /** @type {'staged' | 'unstaged'} */ (request.kind), {
        env,
        force: request.force,
        patch,
        showWhitespace: request.showWhitespace,
      });
    },
    /** @param {import('../../core/types.ts').DiffImageContentRequest} request */
    readImage: async (request) =>
      unavailableImages.get(`${request.path}:${request.kind}`) ||
      (await workingTree.readDiffImageContent(worktree, request, env)),
  };
};

module.exports = { captureRepositoryContent };
