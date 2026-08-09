import type { FileDiffLoadedFiles } from '@pierre/diffs';
import { useCallback, useRef, useState } from 'react';
import {
  getDiffSectionLoadKey,
  getFailedSectionLoadState,
  shouldLoadDiffSectionContents,
  updateDiffSection,
} from '../../lib/diff.ts';
import type { ReviewContentLoader } from '../../review-content-loader.ts';
import type { ChangedFile, DiffSection, SharedWalkthroughSnapshot } from '../../types.ts';

const createReviewContentState = (snapshot: SharedWalkthroughSnapshot) => ({
  files: snapshot.files,
  itemVersionByPath: {} as Readonly<Record<string, number>>,
  loadingSectionIds: new Set<string>() as ReadonlySet<string>,
  snapshot,
});
type ReviewContentState = ReturnType<typeof createReviewContentState>;

const setReviewSectionLoading = (
  current: ReviewContentState,
  snapshot: SharedWalkthroughSnapshot,
  sectionId: string,
  loading: boolean,
): ReviewContentState => {
  if (current.snapshot !== snapshot) {
    return current;
  }
  const loadingSectionIds = new Set(current.loadingSectionIds);
  if (loading) {
    loadingSectionIds.add(sectionId);
  } else {
    loadingSectionIds.delete(sectionId);
  }
  return { ...current, loadingSectionIds };
};

const updateReviewContentSection = (
  current: ReviewContentState,
  snapshot: SharedWalkthroughSnapshot,
  file: ChangedFile,
  section: DiffSection,
  update: (current: DiffSection) => DiffSection,
): ReviewContentState => {
  if (current.snapshot !== snapshot) {
    return current;
  }
  const files = updateDiffSection(current.files, file, section, update);
  return files === current.files
    ? current
    : {
        ...current,
        files,
        itemVersionByPath: {
          ...current.itemVersionByPath,
          [file.path]: (current.itemVersionByPath[file.path] ?? 0) + 1,
        },
      };
};

export function useReviewContentController({
  contentLoader,
  snapshot,
}: {
  contentLoader: ReviewContentLoader | undefined;
  snapshot: SharedWalkthroughSnapshot;
}) {
  const [state, setState] = useState(() => createReviewContentState(snapshot));
  if (state.snapshot !== snapshot) {
    setState(createReviewContentState(snapshot));
  }
  const activeState = state.snapshot === snapshot ? state : createReviewContentState(snapshot);
  const contentRequestIdRef = useRef(0);
  const loadingSectionRequestsBySnapshotRef = useRef(
    new WeakMap<SharedWalkthroughSnapshot, Map<string, number>>(),
  );

  const beginSectionContentRequest = useCallback(
    (file: ChangedFile, section: DiffSection) => {
      const requestKey = getDiffSectionLoadKey(file, section);
      let requests = loadingSectionRequestsBySnapshotRef.current.get(snapshot);
      if (!requests) {
        requests = new Map();
        loadingSectionRequestsBySnapshotRef.current.set(snapshot, requests);
      }
      if (requests.has(requestKey)) {
        return null;
      }

      const requestId = contentRequestIdRef.current + 1;
      contentRequestIdRef.current = requestId;
      requests.set(requestKey, requestId);
      setState((current) => setReviewSectionLoading(current, snapshot, section.id, true));

      const isActive = () => requests.get(requestKey) === requestId;
      return {
        finish() {
          if (!isActive()) {
            return;
          }
          requests.delete(requestKey);
          setState((current) => setReviewSectionLoading(current, snapshot, section.id, false));
        },
        isActive,
      };
    },
    [snapshot],
  );
  const applyReviewSectionUpdate = useCallback(
    (file: ChangedFile, section: DiffSection, update: (current: DiffSection) => DiffSection) => {
      setState((current) => updateReviewContentSection(current, snapshot, file, section, update));
    },
    [snapshot],
  );
  const requestSectionContent = useCallback(
    (file: ChangedFile, section: DiffSection) => {
      if (!contentLoader) {
        throw new Error(`Cannot load diff contents for '${file.path}'.`);
      }
      return contentLoader.loadSectionContent({
        force: true,
        kind: section.kind,
        path: file.path,
        showWhitespace: snapshot.preferences.showWhitespace,
        source: snapshot.repository.source,
      });
    },
    [contentLoader, snapshot.preferences.showWhitespace, snapshot.repository.source],
  );
  const loadDeferredSection = useCallback(
    async (file: ChangedFile, section: DiffSection) => {
      if (!contentLoader || !shouldLoadDiffSectionContents(section)) {
        return;
      }
      const request = beginSectionContentRequest(file, section);
      if (!request) {
        return;
      }

      try {
        const loadedSection = await requestSectionContent(file, section);
        if (loadedSection.id !== section.id || loadedSection.kind !== section.kind) {
          throw new Error(`Loaded section did not match '${section.id}'.`);
        }
        if (request.isActive()) {
          applyReviewSectionUpdate(file, section, () => loadedSection);
        }
      } catch {
        if (request.isActive()) {
          applyReviewSectionUpdate(file, section, getFailedSectionLoadState);
        }
      } finally {
        request.finish();
      }
    },
    [applyReviewSectionUpdate, beginSectionContentRequest, contentLoader, requestSectionContent],
  );
  const loadSectionContents = useCallback(
    async (file: ChangedFile, section: DiffSection): Promise<FileDiffLoadedFiles> => {
      const loadedSection = await requestSectionContent(file, section);
      if (
        loadedSection.id !== section.id ||
        loadedSection.kind !== section.kind ||
        !loadedSection.newFile
      ) {
        throw new Error(`No file contents available for '${file.path}'.`);
      }
      return {
        newFile: loadedSection.newFile,
        oldFile: loadedSection.oldFile ?? null,
      };
    },
    [requestSectionContent],
  );

  return {
    files: activeState.files,
    itemVersionByPath: activeState.itemVersionByPath,
    loadingSectionIds: activeState.loadingSectionIds,
    onLoadImageContent: contentLoader?.loadImageContent,
    onLoadSection: contentLoader ? loadDeferredSection : undefined,
    onLoadSectionContents: contentLoader ? loadSectionContents : undefined,
  };
}
