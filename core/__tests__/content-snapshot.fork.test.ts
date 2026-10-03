import { chmod, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import type {
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
  RepositoryState,
} from '../types.ts';
import { commitAll, git, withRepo, writeRepoFile } from './helpers/git-state.ts';
import { createTemporaryDirectory } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const { captureRepositoryContent, readDiffSectionContent, readRepositoryState } =
  require('../../electron/git-state.cjs') as {
    captureRepositoryContent: (
      state: RepositoryState,
      directory: string,
    ) => Promise<{
      readImage: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
      readSection: (request: DiffSectionContentRequest) => Promise<DiffSection>;
    }>;
    readDiffSectionContent: (
      repo: string,
      request: DiffSectionContentRequest,
    ) => Promise<DiffSection>;
    readRepositoryState: (
      repo: string,
      source: RepositoryState['source'],
    ) => Promise<RepositoryState>;
  };

test.each(['working-tree', 'branch-working-tree'] as const)(
  '%s captured content keeps staged, working and renamed revisions after the original changes',
  async (type) => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'report.md', 'base\n');
      await writeRepoFile(repo, 'old.txt', 'renamed content\n');
      await commitAll(repo, 'base');
      const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['mv', 'old.txt', 'new.txt']);
      await writeRepoFile(repo, 'report.md', 'staged\n');
      await git(repo, ['add', 'report.md']);
      await writeRepoFile(repo, 'report.md', 'working\n');
      const state = await readRepositoryState(repo, { ref: base, type });
      await using directory = await createTemporaryDirectory('codiff-content-snapshot-');
      const captured = await captureRepositoryContent(state, directory.path);
      await writeRepoFile(repo, 'report.md', 'newer\n');
      await commitAll(repo, 'advance original');
      for (const [kind, oldContents, newContents] of type === 'working-tree'
        ? ([
            ['staged', 'base\n', 'staged\n'],
            ['unstaged', 'staged\n', 'working\n'],
          ] as const)
        : ([['combined', 'base\n', 'working\n']] as const)) {
        const section = await captured.readSection({
          force: true,
          kind,
          path: 'report.md',
          source: state.source,
        });
        expect(section.oldFile?.contents).toBe(oldContents);
        expect(section.newFile?.contents).toBe(newContents);
        expect(section.patch).toContain(`+${newContents.trim()}`);
      }
      const rename = await captured.readSection({
        kind: type === 'working-tree' ? 'staged' : 'combined',
        path: 'new.txt',
        source: state.source,
      });
      expect(rename.oldFile?.name).toBe('old.txt');
      expect(rename.newFile?.contents).toBe('renamed content\n');
      expect(rename.patch).toContain('rename from old.txt');
    });
  },
);

const renderingCases = [
  ['filemode', 'working-tree'],
  ['symlinks', 'working-tree'],
  ['attributes-eol', 'working-tree'],
  ['attributes-info', 'working-tree'],
  ['autocrlf', 'working-tree'],
  ['attributes-driver', 'working-tree'],
  ['attributes-driver', 'branch-working-tree'],
] as const;

test.each(renderingCases)(
  '%s retains native %s patch semantics after source settings and bytes change',
  async (scenario, type) => {
    await withRepo(async (repo) => {
      const path = 'nested/report[1]*?.txt';
      const base =
        'SECTION chosen\n' + Array.from({ length: 30 }, (_, i) => `body ${i}\n`).join('');
      const changed = base.replace('body 20\n', 'changed 20\n');
      const attributePath =
        scenario === 'attributes-info' ? '.git/info/attributes' : 'nested/.gitattributes';
      if (scenario.startsWith('attributes-')) {
        await writeRepoFile(
          repo,
          attributePath,
          scenario === 'attributes-driver' ? '*.txt diff=custom\n' : '*.txt text eol=lf\n',
        );
      }
      if (scenario === 'attributes-driver') {
        await git(repo, ['config', 'diff.custom.xfuncname', '^SECTION.*']);
      }
      if (scenario === 'autocrlf') {
        await git(repo, ['config', 'core.autocrlf', 'true']);
      }
      await writeRepoFile(repo, path, base);
      if (scenario === 'filemode') {
        await chmod(join(repo, path), 0o755);
      }
      if (scenario === 'symlinks') {
        await unlink(join(repo, path));
        await symlink('old-target', join(repo, path));
      }
      await commitAll(repo, 'base');
      const ref = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      if (scenario === 'filemode') {
        await git(repo, ['config', 'core.filemode', 'false']);
        await chmod(join(repo, path), 0o644);
      }
      if (scenario === 'symlinks') {
        await git(repo, ['config', 'core.symlinks', 'false']);
        await unlink(join(repo, path));
      }
      await writeRepoFile(
        repo,
        path,
        scenario === 'symlinks'
          ? 'new-target'
          : scenario === 'attributes-driver' || scenario === 'filemode'
            ? changed
            : changed.replaceAll('\n', '\r\n'),
      );
      const state = await readRepositoryState(repo, { ref, type });
      const request: DiffSectionContentRequest = {
        force: true,
        kind: type === 'working-tree' ? 'unstaged' : 'combined',
        path,
        source: state.source,
      };
      const native = await readDiffSectionContent(repo, request);
      expect(native.patch).toContain(scenario === 'symlinks' ? '+new-target' : '+changed 20');
      if (scenario === 'attributes-driver') {
        expect(native.patch).toContain('@@ -19,7 +19,7 @@ SECTION chosen');
      }
      await using directory = await createTemporaryDirectory('codiff-content-snapshot-');
      const captured = await captureRepositoryContent(state, directory.path);
      await writeRepoFile(repo, path, 'later bytes\n');
      await writeRepoFile(repo, attributePath, '# later attributes\n');
      await git(repo, ['config', 'core.filemode', 'true']);
      await git(repo, ['config', 'core.symlinks', 'true']);
      await git(repo, ['config', 'core.autocrlf', 'false']);
      await git(repo, ['config', 'diff.custom.xfuncname', '^later.*']);
      const frozen = await captured.readSection(request);
      expect(frozen.patch).toBe(native.patch);
      expect(frozen.oldFile?.contents).toBe(native.oldFile?.contents);
      expect(frozen.newFile?.contents).toBe(native.newFile?.contents);
    });
  },
);
