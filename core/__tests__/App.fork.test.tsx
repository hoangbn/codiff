import { expect, test } from 'vite-plus/test';
import { getSectionForFileDiff, getVisibleDiffSections, loadSectionContents } from '../lib/diff.ts';
import type { ChangedFile } from '../types.ts';

test('patch-only hydration caches stay scoped to their snapshot section objects', async () => {
  const firstSection = {
    binary: false,
    id: 'src/session.ts:unstaged',
    kind: 'unstaged',
    loadState: 'ready',
    patch:
      'diff --git a/src/session.ts b/src/session.ts\n--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1 +1 @@\n-old\n+new\n',
  } as const;
  const secondSection = { ...firstSection };
  const firstFile = {
    fingerprint: 'shared-reader-fingerprint',
    path: 'src/session.ts',
    sections: [firstSection],
    status: 'modified',
  } satisfies ChangedFile;
  const secondFile = {
    ...firstFile,
    sections: [secondSection],
  } satisfies ChangedFile;

  const firstDiff = getVisibleDiffSections(firstFile, false)[0].fileDiff;
  const secondDiff = getVisibleDiffSections(secondFile, false)[0].fileDiff;
  expect(secondDiff).not.toBe(firstDiff);
  expect(getSectionForFileDiff(firstDiff)?.section).toBe(firstSection);
  expect(getSectionForFileDiff(secondDiff)?.section).toBe(secondSection);

  let firstLoadCount = 0;
  let secondLoadCount = 0;
  const firstContents = await loadSectionContents(firstFile, firstSection, async () => {
    firstLoadCount += 1;
    return {
      newFile: { contents: 'first\n', name: firstFile.path },
      oldFile: { contents: 'old\n', name: firstFile.path },
    };
  });
  const secondContents = await loadSectionContents(secondFile, secondSection, async () => {
    secondLoadCount += 1;
    return {
      newFile: { contents: 'second\n', name: secondFile.path },
      oldFile: { contents: 'old\n', name: secondFile.path },
    };
  });

  expect(firstLoadCount).toBe(1);
  expect(secondLoadCount).toBe(1);
  expect(firstContents.newFile.contents).toBe('first\n');
  expect(secondContents.newFile.contents).toBe('second\n');
});
