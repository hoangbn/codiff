import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  type DiffImageContentRequest,
  type DiffImageContentResult,
  type DiffSection,
  type DiffSectionContentRequest,
  type RepositoryState,
  type ReviewSource,
} from '../../types.ts';
import { getGitTestEnvironmentForSubprocess, withGitTestEnvironment } from './git.ts';
import { createTemporaryDirectory } from './resources.ts';

type StatusEntry = {
  conflictStage?: 1 | 2 | 3;
  oldPath?: string;
  path: string;
  staged: boolean;
  status: string;
  unstaged: boolean;
  untracked: boolean;
};

const execFileAsync = promisify(execFile);

export type PullRequestFileContent = {
  available?: boolean;
  binary: boolean;
  file?: { cacheKey?: string; contents: string; name: string };
  fingerprint?: string;
  loadState?: string;
  summary?: unknown;
};

export type GitStateModule = {
  collectResolvedReviewCommentIds: (
    threads: ReadonlyArray<{
      comments?: { nodes?: ReadonlyArray<{ databaseId?: number | null }> } | null;
      isResolved?: boolean;
    }>,
  ) => Set<number>;
  createPullRequestHistoryFetchRefspecs: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: { base?: { ref?: string; sha?: string } },
  ) => ReadonlyArray<string>;
  createPullRequestSection: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    file: { filename: string; patch?: string; previous_filename?: string; status: string },
    patch: string,
    oldFile?: PullRequestFileContent,
    newFile?: PullRequestFileContent,
  ) => DiffSection;
  createPullRequestSource: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: {
      body?: string | null;
      head?: { sha?: string };
      title?: string;
      user?: { avatar_url?: string; html_url?: string; login?: string };
    },
  ) => Extract<ReviewSource, { type: 'pull-request' }>;
  getPullRequestHeadImageSource: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: {
      head?: {
        ref?: string;
        repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null;
        sha?: string;
      };
    },
  ) => { owner: string; ref: string; repo: string };
  listRepositoryHistory: (
    launchPath: string,
    limit?: number,
    source?: ReviewSource,
  ) => Promise<{ entries: ReadonlyArray<unknown>; root: string }>;
  normalizeGitHubPullRequestCommit: (commit: Record<string, unknown>) => unknown;
  normalizeGitHubReviewComment: (comment: Record<string, unknown>) => unknown;
  normalizePullRequestComment: (comment: Record<string, unknown>) => Record<string, unknown>;
  parseGitHubPullRequestUrl: (value: string) => {
    number: number;
    owner: string;
    repo: string;
    url: string;
  };
  parseStatus: (raw: string) => Array<StatusEntry>;
  PENDING_REVIEW_COMMENT_ERROR: string;
  readDiffImageContent: (
    launchPath: string,
    request: DiffImageContentRequest,
  ) => Promise<DiffImageContentResult>;
  readDiffSectionContent: (
    launchPath: string,
    request: DiffSectionContentRequest,
  ) => Promise<DiffSection>;
  readRepositoryChangeSignature: (
    launchPath: string,
  ) => Promise<{ root: string; signature: string }>;
  readRepositoryState: (
    launchPath: string,
    source?: ReviewSource,
    options?: { showWhitespace?: boolean },
  ) => Promise<RepositoryState>;
  readWalkthroughRepositoryState: (
    launchPath: string,
    source?: ReviewSource,
    options?: { showWhitespace?: boolean },
  ) => Promise<RepositoryState>;
  readWorkingTreeState: (
    launchPath: string,
    options?: { eagerContents?: boolean; showWhitespace?: boolean },
  ) => Promise<RepositoryState>;
  resolvePullRequestContentRefs: (
    repoRoot: string,
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: { base?: { ref?: string; sha?: string }; head?: { ref?: string; sha?: string } },
  ) => Promise<{ base: string; head: string } | null>;
  selectUnresolvedReviewComments: (
    comments: ReadonlyArray<Record<string, unknown>>,
    resolvedCommentIds: ReadonlySet<number>,
  ) => Array<Record<string, unknown>>;
  submitPullRequestComment: (
    launchPath: string,
    request: {
      comment: {
        body: string;
        filePath: string;
        lineNumber: number;
        side: 'additions' | 'deletions';
      };
      source: Extract<ReviewSource, { type: 'pull-request' }>;
    },
  ) => Promise<Record<string, unknown>>;
  validateRepositoryPath: (path: unknown) => string;
};

export const git = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironmentForSubprocess(),
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout;
};

export const writeRepoFile = async (repo: string, path: string, contents: string | Uint8Array) => {
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

export const commitAll = async (repo: string, message: string) => {
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
};

export const withRepo = async (run: (repo: string) => Promise<void>) => {
  await withGitTestEnvironment(async () => {
    await using directory = await createTemporaryDirectory('codiff-git-state-');
    const repo = await realpath(directory.path);
    await git(repo, ['init']);
    await run(repo);
  });
};
