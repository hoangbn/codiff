import { expect, test } from 'vite-plus/test';
import { getReviewCommentsFromState } from '../lib/review-comments.ts';
import { createPullRequestState } from './helpers/review-comments.ts';

test('getReviewCommentsFromState only falls back to the first section for sectionless comments', () => {
  const state = createPullRequestState();
  state.source = { ref: 'main', type: 'branch-working-tree' };
  state.files = [
    {
      ...state.files[0]!,
      sections: [{ binary: false, id: 'src/a.ts:combined', kind: 'combined', patch: '' }],
    },
  ];
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Anchored to a section that no longer exists.',
      filePath: 'src/a.ts',
      id: 'shared:missing',
      lineNumber: 5,
      sectionId: 'src/a.ts:unstaged',
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'No section identity.',
      filePath: 'src/a.ts',
      id: 'shared:sectionless',
      lineNumber: 6,
      side: 'additions',
    },
  ];

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({ id: 'shared:sectionless', sectionId: 'src/a.ts:combined' }),
  ]);
});
