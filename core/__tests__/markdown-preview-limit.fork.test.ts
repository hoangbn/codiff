import { expect, test } from 'vite-plus/test';
import {
  getMarkdownPreviewContents,
  getVisibleDiffSections,
  MAX_MARKDOWN_PREVIEW_LINE_LENGTH,
} from '../lib/diff.ts';
import type { ChangedFile } from '../types.ts';

const createUntrackedMarkdown = (contents: string) =>
  ({
    fingerprint: `large-markdown:${contents.length}`,
    path: 'notes.md',
    sections: [
      {
        binary: false,
        id: 'notes.md:unstaged',
        kind: 'unstaged',
        loadState: 'ready',
        newFile: { contents, name: 'notes.md' },
        oldFile: { contents: '', name: 'notes.md' },
        patch: '',
      },
    ],
    status: 'untracked',
  }) satisfies ChangedFile;

const longLine = 'x'.repeat(MAX_MARKDOWN_PREVIEW_LINE_LENGTH);

test.each([
  ['a line at the limit', `# Notes\n${longLine}\n`, true],
  ['many lines that together exceed the limit', `${longLine}\n`.repeat(4), true],
  ['a line above the limit', `# Notes\n${longLine}x\n`, false],
])('Markdown with %s gets a preview: %s', (_label, contents, previewed) => {
  const file = createUntrackedMarkdown(contents);
  const [{ fileDiff, section }] = getVisibleDiffSections(file, false);

  expect(getMarkdownPreviewContents(file, section, fileDiff) != null).toBe(previewed);
});
