import { vi } from 'vite-plus/test';
import { createChangedFileWithPatch } from './fixtures.ts';

export const markdownEditorMock = {
  flush: vi.fn<() => Promise<boolean>>(async () => true),
  heightByAriaLabel: new Map<string, number>(),
  heightReportLimit: Number.POSITIVE_INFINITY,
  heightReports: 0,
  loadingPaths: new Set<string>(),
};

export const createMarkdownDocumentEditorMock = async () => {
  const React = await import('react');

  return {
    RepositoryMarkdownEditor: React.forwardRef(function MockRepositoryMarkdownEditor(
      { onHeightChange, path }: { onHeightChange?: (height: number) => void; path: string },
      ref: React.ForwardedRef<{ flush: () => Promise<boolean> }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        flush: markdownEditorMock.flush,
      }));
      const [loading, setLoading] = React.useState(() => markdownEditorMock.loadingPaths.has(path));
      React.useEffect(() => {
        const finishLoading = () => setLoading(markdownEditorMock.loadingPaths.has(path));
        window.addEventListener('markdown-loaded', finishLoading);
        return () => window.removeEventListener('markdown-loaded', finishLoading);
      }, [path]);
      React.useEffect(() => {
        if (!loading) {
          onHeightChange?.(markdownEditorMock.heightByAriaLabel.get(`Edit ${path}`) ?? 100);
        }
      }, [loading, onHeightChange, path]);
      if (loading) {
        return <div className="codiff-markdown-editor-message">Loading…</div>;
      }
      return <div aria-label={`Edit ${path}`}>Markdown editor</div>;
    }),
  };
};

export const createMdxEditorMock = async () => {
  const React = await import('react');
  type MockEditorProps = {
    ariaLabel?: string;
    className?: string;
    contentClassName?: string;
    onBlur?: () => void;
    onChange?: (value: string) => void;
    onFocus?: () => void;
    onHeightChange?: (height: number) => void;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    placeholder?: string;
    readOnly?: boolean;
    value?: string;
  };

  return {
    MarkdownEditor: React.forwardRef<
      {
        focus: () => void;
      },
      MockEditorProps
    >((props, ref) => {
      const inputRef = React.useRef<HTMLTextAreaElement>(null);
      const { onHeightChange } = props;
      React.useImperativeHandle(ref, () => ({
        focus: () => inputRef.current?.focus(),
      }));
      React.useEffect(() => {
        if (
          onHeightChange &&
          markdownEditorMock.heightReports < markdownEditorMock.heightReportLimit
        ) {
          markdownEditorMock.heightReports += 1;
          onHeightChange(markdownEditorMock.heightByAriaLabel.get(props.ariaLabel ?? '') ?? 100);
        }
      }, [onHeightChange, props.ariaLabel]);
      return (
        <textarea
          aria-label={props.ariaLabel}
          className={props.contentClassName ?? props.className}
          onBlur={props.onBlur}
          onChange={(event) => props.onChange?.(event.currentTarget.value)}
          onDoubleClick={() => onHeightChange?.(200)}
          onFocus={props.onFocus}
          onKeyDown={(event) =>
            props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLDivElement>)
          }
          placeholder={props.placeholder}
          readOnly={props.readOnly}
          ref={inputRef}
          value={props.value}
        />
      );
    }),
  };
};

export const resetMarkdownEditorMock = () => {
  markdownEditorMock.flush.mockClear();
  markdownEditorMock.flush.mockResolvedValue(true);
  markdownEditorMock.heightByAriaLabel.clear();
  markdownEditorMock.heightReportLimit = Number.POSITIVE_INFINITY;
  markdownEditorMock.heightReports = 0;
  markdownEditorMock.loadingPaths.clear();
};

export const createLoadedMarkdownFile = (contents: string, fingerprint: string) => {
  const file = createChangedFileWithPatch(
    'plan.md',
    `diff --git a/plan.md b/plan.md\n@@ -1 +1 @@\n-# Original\n+${contents}`,
  );
  return {
    ...file,
    fingerprint,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'ready' as const,
      newFile: {
        contents,
        name: file.path,
      },
      oldFile: {
        contents: '# Original\n',
        name: file.path,
      },
    })),
  };
};
