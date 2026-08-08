# Plan 001: Add right-side sidebar support to ReviewSurface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report—do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 3ee0d09..HEAD -- core/lib/app-types.ts core/SharedWalkthroughApp.tsx core/app/hooks/useResizableSidebar.ts core/app/components/ReviewTopBar.tsx core/App.tsx core/App.css core/react.ts core/README.md core/__tests__/SharedWalkthroughApp.test.tsx core/__tests__/review-hooks.test.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> material mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (about half a day)
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `3ee0d09`, 2026-08-07

## Why this matters

Hosts embedding `ReviewSurface` cannot currently put its navigation sidebar on
the right without overriding an inline grid declaration and breaking the
built-in resize math. Add an optional public placement prop so the host can
select the side while the existing left-side behavior remains the default. The
hook, top-bar module, and shared CSS are also used by the desktop app. Keep the
external interface small by defaulting only at `ReviewSurface`; require the
internal modules and desktop implementation to choose a position explicitly.

This is deliberately module-only. It does not add a persisted Codiff desktop
setting or change the public sharing service's own wrapper.

## Current state

Relevant files and roles:

- `core/SharedWalkthroughApp.tsx` — declares the public `ReviewSurfaceProps`,
  renders the embedded shell, and supplies its dynamic grid columns.
- `core/app/hooks/useResizableSidebar.ts` — shared pointer-drag behavior; it
  currently measures all widths from the shell's left edge.
- `core/app/components/ReviewTopBar.tsx` — shared top bar and Phosphor
  `SidebarSimple` toggle icon.
- `core/App.tsx` — desktop caller; explicitly selects the existing left
  position at both internal seams.
- `core/App.css` — shared grid, collapsed-shell, child-row, and resize-handle
  styles used by both the embedded surface and desktop app.
- `core/lib/app-types.ts` — existing home for shared sidebar types such as
  `SidebarMode`; add the placement type next to it.
- `core/react.ts` — public `@nkzw/codiff-core/react` export barrel.
- `core/README.md` — package-facing embedding example.
- `core/__tests__/SharedWalkthroughApp.test.tsx` — jsdom coverage for the public
  surface and top-bar toggle/collapse behavior.
- `core/__tests__/review-hooks.test.tsx` — existing pointer-event harness for
  resize width, commit, and collapse behavior.

Current public props (`core/SharedWalkthroughApp.tsx:137-177`) have no placement
input:

```ts
export type ReviewSurfaceProps = {
  commenting?: ReviewCommenting;
  // ...existing props...
  snapshot: SharedWalkthroughSnapshot;
  title?: string;
};
```

The expanded shell always writes left-side columns
(`core/SharedWalkthroughApp.tsx:975-983`):

```tsx
<div
  className={`app-shell share-shell${interactive ? ' merge-request-shell' : ''}${
    sidebarCollapsed ? ' sidebar-collapsed' : ''
  }`}
  data-theme={shellTheme}
  style={
    sidebarCollapsed ? undefined : { gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)` }
  }
>
```

The three content children remain in sidebar, resizer, review DOM order
(`core/SharedWalkthroughApp.tsx:1054-1117`). Preserve that DOM order so keyboard
and screen-reader ordering does not change; placement belongs to CSS Grid.

The resize hook captures only `.left` and subtracts it from the pointer
coordinate (`core/app/hooks/useResizableSidebar.ts:27-56`):

```ts
const shellLeft = shell.getBoundingClientRect().left;
// ...
const rawWidth = moveEvent.clientX - shellLeft;
```

The toggle is a Phosphor icon and is currently always left-oriented
(`core/app/components/ReviewTopBar.tsx:44-52`):

```tsx
<button className="review-top-bar-icon-button sidebar-toggle-button" /* ... */>
  <SidebarSimple aria-hidden size={18} weight="bold" />
</button>
```

The base CSS declares three tracks but only assigns a row to the content
children (`core/App.css:246-252`, `core/App.css:964-993`):

```css
.app-shell {
  display: grid;
  grid-template-columns: 292px 0 minmax(0, 1fr);
  grid-template-rows: 40px minmax(0, 1fr);
}

.app-shell > .sidebar,
.app-shell > .sidebar-resizer,
.app-shell > .review {
  grid-row: 2;
}
```

The collapsed shell has one track and hides the sidebar/resizer
(`core/App.css:704-714`). If expanded children gain explicit columns, the
collapsed `.review` must explicitly return to column 1; otherwise the default
left layout's `grid-column: 3` creates implicit columns after collapse.

Repo conventions to match:

- Shared view types use short string unions; see `SidebarMode` at
  `core/lib/app-types.ts:122`.
- The external `ReviewSurface` seam owns the compatibility default. Internal
  seams require explicit position inputs so there is one default to maintain.
- Tests use `vite-plus/test`, jsdom, `act`, and explicit resource management;
  model new hook tests on `core/__tests__/review-hooks.test.tsx:81-166`.
- Static CSS assertions, where needed, follow the `readFileSync(resolve(...))`
  pattern at `core/__tests__/App-render.test.tsx:552-575`.
- Public React symbols are explicitly type-exported from `core/react.ts`.
- Keep implementation concise, use the existing Phosphor icon, and do not
  remove unrelated TODO comments.

## Commands you will need

| Purpose                 | Command                                                                                                | Expected on success                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Focused tests           | `vp test core/__tests__/SharedWalkthroughApp.test.tsx core/__tests__/review-hooks.test.tsx`            | exit 0; both files pass                               |
| Full tests              | `vp test --maxWorkers=1`                                                                               | exit 0; all tests pass                                |
| Required validation/fix | `vp check --fix`                                                                                       | exit 0; no remaining lint, format, or type errors     |
| Required build          | `vpr build` or `vp run build` when `vpr` is unavailable                                                | exit 0; built artifacts refreshed                     |
| Public declarations     | `rg -n -e SidebarPosition -e sidebarPosition core/dist/react.d.ts core/dist/SharedWalkthroughApp.d.ts` | matches show the public type export and optional prop |

Do not install, publish, push, or open a PR unless the operator separately asks.

## Scope

**In scope (the only files to modify):**

- `core/lib/app-types.ts`
- `core/SharedWalkthroughApp.tsx`
- `core/app/hooks/useResizableSidebar.ts`
- `core/app/components/ReviewTopBar.tsx`
- `core/App.tsx`
- `core/App.css`
- `core/react.ts`
- `core/README.md`
- `core/__tests__/SharedWalkthroughApp.test.tsx`
- `core/__tests__/review-hooks.test.tsx`
- `plans/README.md` (status row only)

**Out of scope (do not touch):**

- Config defaults/types/schema and settings UI — desktop configurability is a
  separate feature; `core/App.tsx` should explicitly retain left behavior.
- `service/react.tsx` and `web/` — the service wrapper is not the requested
  public embedding interface and should keep compiling unchanged.
- `core/SharedPlanApp.tsx` / `PlanReviewSurface` — it has a different layout.
- File tree, walkthrough, comments, and diff-rendering internals.
- Width limits, storage key, or persistence semantics in
  `core/lib/sidebar-width.ts`.
- `docs/sidebar-position-scope.md` — this was an untracked, user-owned research
  note when the plan was written. Preserve it exactly.
- Package version changes or npm publication.

## Git workflow

- Follow git flow. If a branch is needed, use
  `feature/review-surface-sidebar-position`; do not create a `codex/` branch.
- Use concise imperative commit subjects matching recent history, for example
  `Add right-side ReviewSurface sidebar support`.
- Do not push or open a pull request unless instructed. If a later operator asks
  for a PR, follow `AGENTS.md` for its required description suffix and disclose
  AI assistance per `CONTRIBUTING.md`.

## Steps

### Step 1: Add the optional public placement type and wire it through

1. In `core/lib/app-types.ts`, add:

   ```ts
   export type SidebarPosition = 'left' | 'right';
   ```

   Place it next to `SidebarMode`.

2. In `core/SharedWalkthroughApp.tsx`, import `SidebarPosition`, add
   `sidebarPosition?: SidebarPosition` to `ReviewSurfaceProps`, and default the
   destructured prop to `'left'`.
3. In `core/app/hooks/useResizableSidebar.ts`, add required
   `position: SidebarPosition` to `UseResizableSidebarOptions`. Use the name
   `position` inside the hook so its interface is not tied to `ReviewSurface`'s
   public prop name.
4. In `core/app/components/ReviewTopBar.tsx`, add required
   `sidebarPosition: SidebarPosition`.
5. Pass `sidebarPosition` from `ReviewSurface` to the hook as `position` and to
   `ReviewTopBar` as `sidebarPosition`.
6. In `core/App.tsx`, pass `'left'` explicitly to both internal modules. This
   preserves desktop behavior without adding desktop configuration.
7. Export `SidebarPosition` from `core/react.ts` so consumers can import it from
   `@nkzw/codiff-core/react`, alongside `ReviewSurfaceProps`.

**Verify**: `vp check` → exit 0 with no type or lint errors.
`git diff -- service/react.tsx` → no output.

### Step 2: Reverse the expanded grid and explicitly place its children

1. Add `data-sidebar-position={sidebarPosition}` to the embedded `.app-shell`.
2. Keep the collapsed inline style `undefined`. When expanded, select exactly
   one of these templates:

   - left/default: `` `${sidebarWidth}px 0 minmax(0, 1fr)` ``
   - right: `` `minmax(0, 1fr) 0 ${sidebarWidth}px` ``

3. In `core/App.css`, explicitly assign the expanded/default content columns:

   - `.sidebar` → column 1
   - `.sidebar-resizer` → column 2
   - `.review` → column 3

   Add right-position overrides scoped by
   `.app-shell[data-sidebar-position='right']` so `.review` moves to column 1,
   the resizer stays in column 2, and `.sidebar` moves to column 3.

4. Add a collapsed override that places the visible `.review` in column 1.
   Preserve the existing one-track collapsed template and hide rules.
5. Do not reorder the JSX children. Keep `ReviewTopBar` spanning
   `grid-column: 1 / -1`, and do not change the shared top-bar structure.

The CSS should remain valid for the desktop `.app-shell`, which has no
`data-sidebar-position` and therefore uses the explicit left/default columns.

**Verify**:

- `rg -n "data-sidebar-position|grid-column" core/SharedWalkthroughApp.tsx core/App.css`
  → shows the shell attribute, default child columns, right-side overrides, and
  collapsed review reset.
- `git diff --check` → no output and exit 0.

### Step 3: Make resize math direction-aware and mirror the toggle icon

1. In `useResizableSidebar`, capture the shell rectangle once on pointer down:

   ```ts
   const shellRect = shell.getBoundingClientRect();
   ```

2. Calculate drag width from the edge adjacent to the review pane:

   ```ts
   const rawWidth =
     position === 'right'
       ? shellRect.right - moveEvent.clientX
       : moveEvent.clientX - shellRect.left;
   ```

   Keep the existing collapse threshold, `clampSidebarWidth`, pointer capture,
   cleanup, and commit behavior unchanged. Include `position` in the
   `useCallback` dependency list.

3. In `ReviewTopBar`, set the Phosphor icon's `mirrored` prop only when
   `sidebarPosition === 'right'`. Keep its accessible label/title unchanged;
   "Expand sidebar" and "Collapse sidebar" are side-neutral.

**Verify**: `vp check` → exit 0. `git diff -- core/lib/sidebar-width.ts` → no
output, confirming width limits and persistence were not changed.

### Step 4: Add layout, resize, collapse, and compatibility coverage

Extend the existing two test files instead of creating a new harness.

In `core/__tests__/SharedWalkthroughApp.test.tsx`:

1. Import `ReviewSurface` and the new `SidebarPosition` type through
   `../react.ts`, not directly from `SharedWalkthroughApp.tsx`, so the normal
   typecheck proves the public export path.
2. Add a deterministic default compatibility assertion after clearing
   `localStorage`: omitting `sidebarPosition` yields
   `data-sidebar-position="left"`, the original
   `292px 0 minmax(0, 1fr)` expanded template, and an unmirrored toggle icon.
   Assert the Phosphor SVG has no mirror transform.
3. Render with a value typed as `SidebarPosition` and set to `'right'`. Assert:

   - `data-sidebar-position="right"`;
   - `minmax(0, 1fr) 0 292px` while expanded;
   - the toggle's Phosphor SVG has its mirror transform;
   - clicking the toggle adds `sidebar-collapsed`, removes the inline expanded
     template, and changes the accessible label to `Expand sidebar`;
   - clicking again removes `sidebar-collapsed` and restores the right-side
     template.

4. Following the existing static CSS assertion pattern in
   `App-render.test.tsx`, assert the stylesheet contains explicit default
   columns, the right-side review/sidebar reversal, and the collapsed review
   reset to column 1. This is the regression guard for implicit CSS Grid tracks.

In `core/__tests__/review-hooks.test.tsx`:

1. Add optional `position?: SidebarPosition` to `ResizableSidebarHarness` and
   pass it to the hook.
2. Update `prepareResizeHandle` to return a rectangle with distinct non-zero
   `left` and `right` values, while keeping all existing left-side assertions
   passing unchanged.
3. Add a right-side resize/commit case where
   `shellRect.right - clientX` produces the asserted width; after `pointerup`,
   assert that clamped width is passed to `onWidthCommit` exactly once.
4. Add a right-side collapse case where moving toward `shellRect.right` makes
   raw width lower than `SIDEBAR_COLLAPSE_THRESHOLD`; assert `onCollapse` fires,
   no width is committed, the displayed width is unchanged, and drag cleanup
   runs.

Do not replace the current left resize and collapse cases; they are the
backward-compatibility tests for the hook's optional default.

**Verify**:
`vp test core/__tests__/SharedWalkthroughApp.test.tsx core/__tests__/review-hooks.test.tsx`
→ exit 0; existing left cases and all new right/layout/collapse cases pass.

### Step 5: Document the prop and run the repository closeout

1. In `core/README.md`, retain the existing default example and add a short
   package-facing note/example stating that `sidebarPosition` accepts `'left'`
   (default) or `'right'`:

   ```tsx
   <ReviewSurface sidebarPosition="right" snapshot={snapshot} />
   ```

   Mention the importable `SidebarPosition` type from
   `@nkzw/codiff-core/react`. Do not document desktop config support.

2. Run the required validation in this exact final order. Use one worker for
   the full suite because the packaged CLI tests have five-second per-test
   timeouts under parallel load. If the local `vpr` shorthand is unavailable,
   use the documented equivalent `vp run build`:

   ```sh
   vp check --fix
   vp test --maxWorkers=1
   vp run build
   ```

3. Inspect the generated declarations with:

   ```sh
   rg -n "SidebarPosition|sidebarPosition" core/dist/react.d.ts core/dist/SharedWalkthroughApp.d.ts
   ```

   Confirm the public barrel exports `SidebarPosition` and
   `ReviewSurfaceProps.sidebarPosition` is optional.

4. Check final scope with `git status --short` and `git diff --stat`. Preserve
   the pre-existing untracked `docs/sidebar-position-scope.md` and any other
   unrelated user changes.
5. Update this plan's row in `plans/README.md` to `DONE` only after every check
   succeeds.

**Verify**: all three closeout commands exit 0; declaration search returns both
symbols; `git diff --check` exits 0; no out-of-scope tracked file is modified.

## Test plan

Required behavior matrix:

| Area             | Case                                  | Expected result                                                                |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Layout           | prop omitted                          | left attribute and original column template                                    |
| Layout           | `sidebarPosition="right"`             | review/resizer/sidebar occupy columns 1/2/3 and template ends in sidebar width |
| Collapse         | right toggle collapse/expand          | one-column collapsed state, then restored right template                       |
| Resize           | default/left                          | all existing width, commit, and collapse tests stay green                      |
| Resize           | right drag                            | width equals `shellRect.right - clientX`, clamped and committed on release     |
| Resize           | right drag below threshold            | collapse fires and width is not committed                                      |
| Icon             | default/left                          | no SVG mirror transform                                                        |
| Icon             | right                                 | Phosphor SVG is mirrored                                                       |
| Public interface | normal React entrypoint import        | `SidebarPosition` type and optional prop typecheck                             |
| Integration      | unchanged desktop and service callers | full `vp check`, `vp test`, and `vpr build` pass without editing them          |

Structural test exemplars:

- Hook harness and pointer dispatch:
  `core/__tests__/review-hooks.test.tsx:81-166`.
- Surface toggle/collapse assertions:
  `core/__tests__/SharedWalkthroughApp.test.tsx:323-344`.
- Static CSS assertion:
  `core/__tests__/App-render.test.tsx:552-575`.

## Done criteria

- [x] `ReviewSurfaceProps` includes optional
      `sidebarPosition?: SidebarPosition`, defaulting to `left` at runtime.
- [x] `ReviewTopBar` and `useResizableSidebar` require explicit positions, and
      the desktop implementation passes `'left'`.
- [x] `SidebarPosition` is exported from `@nkzw/codiff-core/react`.
- [x] Expanded right layout uses
      `minmax(0, 1fr) 0 ${sidebarWidth}px` and explicitly assigns review/resizer/
      sidebar to columns 1/2/3 without reordering the DOM.
- [x] Expanded/default left layout remains
      `${sidebarWidth}px 0 minmax(0, 1fr)` with sidebar/resizer/review in columns
      1/2/3.
- [x] Collapsed layouts place the visible review in column 1 and do not create
      implicit grid tracks.
- [x] Right resize width uses `shellRect.right - clientX`; left behavior,
      clamping, persistence, collapse threshold, and cleanup remain intact.
- [x] Toggle icon is mirrored only for the right-side layout.
- [x] Focused layout, resize, collapse, icon, export, and compatibility tests
      pass.
- [x] `vp check --fix`, `vp test --maxWorkers=1`, and `vp run build` all exit 0,
      in that order.
- [x] Generated declarations contain the public type and optional prop.
- [x] `core/README.md` documents default and right-side usage.
- [x] No out-of-scope tracked file is modified; the user's untracked research
      note remains untouched.
- [x] `plans/README.md` status is updated.

## STOP conditions

Stop and report back instead of improvising if:

- The live `ReviewSurface` shell no longer emits sidebar, resizer, and review in
  that order, or no longer owns the inline expanded grid template.
- `ReviewTopBar` or `useResizableSidebar` has gained a competing placement interface
  since commit `3ee0d09`; reconcile the competing design before continuing.
- Correct right placement requires changing file-tree, walkthrough, comment, or
  diff-renderer modules.
- The desktop app must become user-configurable to satisfy the actual product
  requirement; that requires config schema/default/UI work and is outside this
  module plan.
- The right-side behavior cannot be exposed without changing the service
  wrapper or package version; report the consumer requirement before expanding
  scope.
- A focused or final verification command still fails after two reasonable
  attempts, or the fix would require an out-of-scope file.
- An unrelated user change overlaps an in-scope hunk and cannot be preserved.

## Maintenance notes

- Keep placement controlled by the embedding host. If desktop configuration is
  requested later, thread this same type through config defaults, schema,
  settings UI, and `core/App.tsx`; also review the desktop-only fixed
  `.review-action-bar` at `core/App.css:3561-3569` for overlap with a right
  sidebar.
- The width storage key remains shared across positions. This is intentional:
  moving the same embedded surface from left to right should retain its width.
- Reviewers should scrutinize CSS specificity around `.sidebar-collapsed` and
  verify that an explicit default `grid-column: 3` cannot recreate implicit
  tracks.
- Keep the top bar spanning the entire shell and preserve JSX order; visual
  placement should not alter keyboard or screen-reader order.
- Publishing a new `@nkzw/codiff-core` version is a separate release step after
  this implementation is reviewed and merged.
