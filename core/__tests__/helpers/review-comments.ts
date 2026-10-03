import { type RepositoryState } from '../../types.ts';

export const createPullRequestState = (): RepositoryState => ({
  branch: null,
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/a.ts',
      sections: [
        {
          binary: false,
          id: 'src/a.ts:pull-request:1',
          kind: 'pull-request',
          patch: '',
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: 0,
  launchPath: '/repo',
  reviewComments: [
    {
      author: { login: 'reviewer' },
      body: 'Outdated comment.',
      filePath: 'src/a.ts',
      id: 'github:1',
      isOutdated: true,
      lineNumber: 5,
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'Current comment.',
      filePath: 'src/a.ts',
      id: 'github:2',
      lineNumber: 6,
      side: 'additions',
    },
  ],
  root: '/repo',
  source: {
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
});
