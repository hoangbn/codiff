import type { ChangedFile, SharedWalkthroughSnapshot } from '../../types.ts';

export const createReviewSnapshot = (
  files: ReadonlyArray<ChangedFile>,
): SharedWalkthroughSnapshot => {
  const source = { type: 'working-tree' } as const;
  return {
    branch: 'main',
    codiffVersion: '1.10.1',
    exportedAt: '2026-08-09T00:00:00.000Z',
    files,
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: '',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Review the implementation.',
      generatedAt: '2026-08-09T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'main', root: '/repo' },
      source,
      support: [],
      title: 'Repository review',
      version: 4,
    },
  };
};
