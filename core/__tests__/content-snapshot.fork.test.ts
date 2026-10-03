import { createRequire } from 'node:module';
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
const { captureRepositoryContent, readRepositoryState } =
  require('../../electron/git-state.cjs') as {
    captureRepositoryContent: (
      state: RepositoryState,
      directory: string,
    ) => Promise<{
      readImage: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
      readSection: (request: DiffSectionContentRequest) => Promise<DiffSection>;
    }>;
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
