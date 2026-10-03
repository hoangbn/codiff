import { useEffect, useMemo, useRef } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type {
  DiffLineCount,
  PullRequestSource,
  SidebarMode,
  WalkthroughError,
} from '../../lib/app-types.ts';
import {
  formatLineCountNumber,
  getDiffLineCount,
  getDiffLineCountTitle,
  getTotalDiffLineCount,
} from '../../lib/diff.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import type { ChangedFile, HistoryEntry, NarrativeWalkthrough, ReviewSource } from '../../types.ts';
import { Button } from './Button.tsx';
import { ReviewFileTree } from './FileTree.tsx';
import { HistorySidebar } from './HistorySidebar.tsx';
import { NarrativeSidebar } from './walkthrough/NarrativeSidebar.tsx';
import type { NarrativeNavigation } from './walkthrough/useNarrativeNavigation.ts';
import { WalkthroughProgress } from './walkthrough/WalkthroughProgress.tsx';

export function Sidebar({
  branchSource,
  commitFiles,
  commitViewOpen,
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  keymap,
  mode,
  narrativeNavigation,
  narrativeWalkthrough,
  onActivatePath,
  onLoadMoreHistory,
  onSearchQueryChange,
  onSelectSource,
  onShareWalkthrough,
  onToggleCommitView,
  pullRequestSource,
  reloadDeltaPaths,
  searchQuery,
  selectedPath,
  shareWalkthroughDisabled,
  showWhitespace,
  viewed,
  walkthroughError,
  walkthroughLoading,
  walkthroughProgress,
}: {
  branchSource: Extract<ReviewSource, { type: 'branch-diff' }> | null;
  commitFiles: ReadonlyArray<ChangedFile>;
  commitViewOpen: boolean;
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  keymap: CodiffKeymap;
  mode: SidebarMode;
  narrativeNavigation: NarrativeNavigation;
  narrativeWalkthrough: NarrativeWalkthrough | null;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onSearchQueryChange: (query: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  onShareWalkthrough?: () => void;
  onToggleCommitView: () => void;
  pullRequestSource: PullRequestSource | null;
  reloadDeltaPaths: ReadonlySet<string>;
  searchQuery: string;
  selectedPath: string | null;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  viewed: Record<string, string>;
  walkthroughError: WalkthroughError | null;
  walkthroughLoading: boolean;
  walkthroughProgress: {
    phase: import('../../types.ts').WalkthroughProgressPhase | null;
    responseLabelIndex: number;
    stageRevision: number;
  };
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const totalLineCount = useMemo(
    () => getTotalDiffLineCount(lineCountsByPath.values()),
    [lineCountsByPath],
  );
  const showTotalLineCount = mode !== 'history' && totalLineCount.countable;
  const showCommitButton =
    mode === 'tree' && currentSource.type === 'working-tree' && commitFiles.length > 0;
  const showFooter = showTotalLineCount || showCommitButton;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keymap]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder={mode === 'history' ? 'Filter history' : 'Filter files'}
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      {mode === 'history' ? (
        <HistorySidebar
          branchSource={branchSource}
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          pullRequestSource={pullRequestSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && narrativeWalkthrough ? (
        <NarrativeSidebar
          files={commitFiles}
          navigation={narrativeNavigation}
          onShareWalkthrough={onShareWalkthrough}
          shareWalkthroughDisabled={shareWalkthroughDisabled}
          showWhitespace={showWhitespace}
          walkthrough={narrativeWalkthrough}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <WalkthroughProgress
                  phase={walkthroughProgress.phase}
                  responseLabelIndex={walkthroughProgress.responseLabelIndex}
                  stageRevision={walkthroughProgress.stageRevision}
                />
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError.reason}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError.reason}</span>
            </div>
          ) : null}
        </>
      ) : (
        <ReviewFileTree
          files={files}
          onActivatePath={onActivatePath}
          reloadDeltaPaths={reloadDeltaPaths}
          scrollSelectedPathIntoView
          selectedPath={selectedPath}
          showWhitespace={showWhitespace}
          viewed={viewed}
        />
      )}
      {showFooter ? (
        <div className="sidebar-total-row">
          <span className="sidebar-total-summary">
            {showTotalLineCount ? (
              <>
                <span>Total:</span>
                <DiffLineCountBadge
                  ariaLabelPrefix="Total change"
                  className="sidebar-total-line-count"
                  lineCount={totalLineCount}
                />
              </>
            ) : null}
          </span>
          {showCommitButton ? (
            <Button
              aria-label={commitViewOpen ? 'Show file tree' : 'Open commit view'}
              className="sidebar-commit-button"
              onClick={onToggleCommitView}
              type="button"
            >
              {commitViewOpen ? 'Tree' : 'Commit'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function DiffLineCountBadge({
  ariaLabelPrefix,
  className = 'codiff-line-count',
  lineCount,
}: {
  ariaLabelPrefix?: string;
  className?: string;
  lineCount: DiffLineCount;
}) {
  if (!lineCount.countable) {
    return null;
  }

  const title = getDiffLineCountTitle(lineCount);

  return (
    <span
      aria-label={ariaLabelPrefix ? `${ariaLabelPrefix}: ${title}` : title}
      className={className}
      title={ariaLabelPrefix ? `${ariaLabelPrefix}: ${title}` : title}
    >
      <span className="codiff-line-count-added">+{formatLineCountNumber(lineCount.additions)}</span>
      <span className="codiff-line-count-deleted">
        -{formatLineCountNumber(lineCount.deletions)}
      </span>
    </span>
  );
}
