import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHistory, RepositoryHistoryContext, ReviewSource } from '../types.ts';
import { commitAll, git, withRepo, writeRepoFile } from './helpers/git-state.ts';
import { createTemporaryEnvironment } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const { listRepositoryHistory } = require('../../electron/git-state.cjs') as {
  listRepositoryHistory: (
    repo: string,
    limit: number,
    source: ReviewSource,
    context: RepositoryHistoryContext | { type: 'capture' },
  ) => Promise<RepositoryHistory>;
};

const providers = ['github', 'gitlab'] as const;
const sourceFor = (
  provider: (typeof providers)[number],
): Extract<ReviewSource, { type: 'pull-request' }> => ({
  type: 'pull-request',
  url:
    provider === 'github'
      ? 'https://github.com/fixture/repo/pull/7'
      : 'https://gitlab.example.test/fixture/repo/-/merge_requests/7',
});

async function withProviderApi(
  repo: string,
  provider: (typeof providers)[number],
  data: {
    advanceBase?: boolean;
    baseRefs: Array<string>;
    baseSha?: string;
    headSha?: string;
    nextHeadSha?: string;
  },
  run: () => Promise<void>,
) {
  const executable = join(repo, '.git', 'provider.cjs');
  const counter = join(repo, '.git', 'metadata-count');
  await writeFile(
    executable,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const data = ${JSON.stringify(data)};
const provider = ${JSON.stringify(provider)};
const counter = ${JSON.stringify(counter)};
const endpoint = process.argv.find(arg => /^(repos|projects)\//.test(arg));
const record = sha => provider === 'github'
  ? {sha,commit:{author:{name:'Fixture',date:'2026-10-03T00:00:00Z'},message:'Commit '+sha},parents:[]}
  : {id:sha,author_name:'Fixture',committed_date:'2026-10-03T00:00:00Z',message:'Commit '+sha,parent_ids:[]};
let result;
if (endpoint.includes('/pulls/7/commits?')) result = [[record(data.nextHeadSha || data.headSha)]];
else if (endpoint.includes('/merge_requests/7/commits?')) result = [record(data.nextHeadSha || data.headSha)];
else if (endpoint.includes('/commits?')) {
  const url = new URL(endpoint, 'https://fixture.test/');
  const count = Number(url.searchParams.get('per_page'));
  const page = Number(url.searchParams.get('page'));
  const refs = data.advanceBase && url.searchParams.get('ref_name') === 'main' && page > 1
    ? ['f'.repeat(40), ...data.baseRefs] : data.baseRefs;
  result = refs.slice((page - 1) * count, page * count).map(record);
} else {
  const reads = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
  fs.writeFileSync(counter, String(reads+1));
  const head = reads > 0 ? data.nextHeadSha || data.headSha : data.headSha;
  result = provider === 'github'
    ? {base:{sha:data.baseSha},head:{sha:head},number:7,title:'Fixture PR'}
    : {diff_refs:{base_sha:data.baseSha,head_sha:head,start_sha:data.baseSha},sha:head,iid:7,target_branch:data.advanceBase ? 'main' : undefined};
}

process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o700 },
  );
  using _environment = createTemporaryEnvironment({
    [provider === 'github' ? 'CODIFF_GH_PATH' : 'CODIFF_GLAB_PATH']: executable,
    SHELL: undefined,
  });
  await run();
}

for (const provider of providers) {
  test(`${provider} pinned base history pages retain every commit across a partial second page`, async () => {
    await withRepo(async (repo) => {
      const baseRefs = Array.from({ length: 250 }, (_, index) =>
        (index + 1).toString(16).padStart(40, '0'),
      );
      await withProviderApi(repo, provider, { baseRefs }, async () => {
        const history = await listRepositoryHistory(repo, 121, sourceFor(provider), {
          baseRef: baseRefs[0],
          entries: [],
          type: 'provider',
        });
        expect(history.entries.map((entry) => entry.ref)).toEqual(baseRefs.slice(0, 121));
      });
    });
  });

  test(`${provider} capture rejects a review that advances while its commits are read`, async () => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'file.txt', 'base\n');
      await commitAll(repo, 'base');
      const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await writeRepoFile(repo, 'file.txt', 'review\n');
      await commitAll(repo, 'review');
      const headSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await writeRepoFile(repo, 'file.txt', 'advanced\n');
      await commitAll(repo, 'advanced');
      const nextHeadSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
      await git(repo, ['config', `url.${repo}.insteadOf`, 'https://github.com/fixture/repo.git']);
      await git(repo, ['update-ref', 'refs/pull/7/head', nextHeadSha]);
      await withProviderApi(
        repo,
        provider,
        { baseRefs: [], baseSha, headSha, nextHeadSha },
        async () => {
          await expect(
            listRepositoryHistory(
              repo,
              30,
              { ...sourceFor(provider), baseSha, headSha },
              { type: 'capture' },
            ),
          ).rejects.toThrow('review changed');
        },
      );
    });
  });
}

test('GitLab fresh capture pins the target tip before reading later base pages', async () => {
  await withRepo(async (repo) => {
    const baseRefs = Array.from({ length: 250 }, (_, index) =>
      (index + 1).toString(16).padStart(40, '0'),
    );
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    await withProviderApi(
      repo,
      'gitlab',
      { advanceBase: true, baseRefs, baseSha, headSha },
      async () => {
        const history = await listRepositoryHistory(
          repo,
          121,
          { ...sourceFor('gitlab'), baseSha, headSha },
          { type: 'capture' },
        );
        expect(
          history.entries.filter((entry) => entry.scope === 'base').map((entry) => entry.ref),
        ).toEqual(baseRefs.slice(0, 121));
        expect(history.context).toMatchObject({ baseRef: baseRefs[0] });
      },
    );
  });
});

test.each(['branch', 'branch-working-tree'] as const)(
  '%s captured History remains pinned when symbolic endpoints advance',
  async (type) => {
    await withRepo(async (repo) => {
      await writeRepoFile(repo, 'file.txt', 'base\n');
      await commitAll(repo, 'base');
      await git(repo, ['branch', 'target']);
      await writeRepoFile(repo, 'file.txt', 'review\n');
      await commitAll(repo, 'review');
      const source = { ref: 'target', type };
      const captured = await listRepositoryHistory(repo, 1, source, { type: 'capture' });
      await writeRepoFile(repo, 'file.txt', 'advanced\n');
      await commitAll(repo, 'advanced');
      await git(repo, ['branch', '--force', 'target', 'HEAD']);
      const page = await listRepositoryHistory(repo, 30, source, captured.context!);
      expect(page.entries.map((entry) => entry.subject)).toEqual(['review']);
    });
  },
);
