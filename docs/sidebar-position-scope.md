# Right-side sidebar support

Research date: 2026-08-07

Source snapshot: [`3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2`](https://github.com/nkzw-tech/codiff/commit/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2), current `main`, six commits after the `v1.10.1` tag.

## Verdict

Supporting a right-side sidebar in the public React `ReviewSurface` is a small, contained upstream change. The clean API is an optional `sidebarPosition?: 'left' | 'right'` prop with `left` as the default. It requires direction-aware grid placement and pointer-width calculation, plus focused tests and documentation. It does not require changing the file tree, walkthrough, comments, or diff renderer.

For Local File Viewer, this component-only scope is the right boundary. Making the Codiff desktop app itself configurable is a separate, larger scope and is not required for an embedded `ReviewSurface`.

## Why a CSS override is insufficient

The sidebar, zero-width resize track, and review area are emitted in left-to-right DOM order, while the shell writes its three grid columns inline as `sidebarWidth / resizer / review`. ([shell and children](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/SharedWalkthroughApp.tsx#L975-L1117), [base grid](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/App.css#L246-L252))

A host stylesheet can force the sidebar into column 3 and the review into column 1, but it must override the inline `grid-template-columns`, and the built-in resize hook still calculates width from the shell's left edge:

```ts
const rawWidth = moveEvent.clientX - shellLeft;
```

([resize hook](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/app/hooks/useResizableSidebar.ts#L19-L73))

Therefore a CSS-only workaround is acceptable only if LFV fixes the sidebar width and disables the resizer. Keeping resize and collapse behavior correct needs a source/API change.

## Recommended component API

Add a public type and prop:

```ts
export type SidebarPosition = 'left' | 'right';

export type ReviewSurfaceProps = {
  // Existing props...
  sidebarPosition?: SidebarPosition;
};
```

Default the prop to `left`, so existing consumers are unchanged. Export the type from `@nkzw/codiff-core/react`, alongside the existing `ReviewSurfaceProps` export. The current public props and export barrel contain no sidebar-placement control. ([public props](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/SharedWalkthroughApp.tsx#L137-L194), [React exports](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/react.ts#L1-L18))

LFV would then use:

```tsx
<ReviewSurface initialMode="tree" sidebarPosition="right" snapshot={snapshot} />
```

## Implementation scope

### 1. Make shell placement explicit

In `core/SharedWalkthroughApp.tsx`:

- accept `sidebarPosition`, defaulting to `left`;
- expose the value as `data-sidebar-position` on `.app-shell`;
- use `minmax(0, 1fr) 0 ${sidebarWidth}px` for the right-side layout and retain `${sidebarWidth}px 0 minmax(0, 1fr)` for the default left layout; and
- pass the position to the resize hook and top-bar toggle.

In `core/App.css`, add right-side child placement:

```css
.app-shell[data-sidebar-position='right'] > .review {
  grid-column: 1;
}

.app-shell[data-sidebar-position='right'] > .sidebar-resizer {
  grid-column: 2;
}

.app-shell[data-sidebar-position='right'] > .sidebar {
  grid-column: 3;
}
```

The top bar already spans `grid-column: 1 / -1`, so it does not need structural movement. The collapsed rule already reduces the shell to one content column and hides the sidebar and resizer. ([top bar and collapsed layout](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/App.css#L704-L727))

The resizer border, hover stripe, and hit target should be visually checked on both sides. They are currently expressed with left-biased border/inset rules. ([resizer styles](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/App.css#L964-L993))

### 2. Make resize math direction-aware

Extend `useResizableSidebar` with an optional `position` input that defaults to `left`. Capture the shell rectangle once on pointer down and calculate:

```ts
const rawWidth =
  position === 'right' ? shellRect.right - moveEvent.clientX : moveEvent.clientX - shellRect.left;
```

The existing clamp, persistence, pointer capture, and collapse threshold can remain unchanged. On the right, dragging toward the viewport's right edge reduces the computed width and naturally triggers the same collapse threshold. The position must be included in the callback dependency list. ([current hook](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/app/hooks/useResizableSidebar.ts#L4-L76), [width constraints](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/lib/sidebar-width.ts#L1-L25))

### 3. Mirror the toggle icon

`ReviewTopBar` uses Phosphor's `SidebarSimple` icon, whose default glyph depicts a left sidebar. Pass the placement into the top bar and set the icon's `mirrored` property for the right-side case. Button labels remain `Expand sidebar` and `Collapse sidebar`; they are already side-neutral. ([top-bar toggle](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/app/components/ReviewTopBar.tsx#L13-L52))

### 4. Add focused coverage

Minimum tests:

1. `ReviewSurface` defaults to left placement and preserves the current column order.
2. `sidebarPosition="right"` sets right placement and reverses the shell columns.
3. The right-side resizer computes width from `shellRect.right`, clamps it, and persists the committed width.
4. Dragging a right sidebar toward the right edge triggers collapse at the existing threshold.
5. The toggle still collapses and expands the right sidebar.

The existing shared-surface test already covers toggle collapse/expand and is the natural place for the render assertions. ([existing toggle test](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/__tests__/SharedWalkthroughApp.test.tsx#L323-L344))

Add direction-specific resize coverage either in a dedicated hook test or by extracting the coordinate calculation into a small pure helper. A pure helper is the simplest reliable test seam if the test DOM does not model pointer capture well.

### 5. Document and publish

Update the core README example/API note to include the optional prop, then run the repository-required validation flow:

```sh
vp check --fix
vpr build
```

LFV can consume the feature after a new `@nkzw/codiff-core` version is published. The checked-out post-`v1.10.1` `main` source and LFV's installed `v1.10.0` have the same sidebar shell, resize hook, and public props; the only relevant-file difference is an unrelated CSS status badge, so this scope applies to both versions.

## Estimated change size

Recommended `ReviewSurface` support:

- 4 production files: `SharedWalkthroughApp.tsx`, `useResizableSidebar.ts`, `ReviewTopBar.tsx`, and `App.css`;
- 1 public export file: `react.ts`;
- 1-2 test files; and
- 1 README update.

This is roughly a half-day implementation and validation task, excluding maintainer review and npm publication.

## Optional broader desktop scope

If the Codiff desktop app should also let users choose the side, add a persisted `sidebarPosition` setting across config defaults/types/schema, settings UI, and `core/App.tsx`, then pass it through the same layout/hook API. This needs additional visual QA because the desktop-only `.review-action-bar` is fixed at `right: 16px`; with a right sidebar, it may overlay the sidebar and should instead be anchored to the review surface. ([desktop shell](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/App.tsx#L1794-L1959), [fixed action bar](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/core/App.css#L3561-L3569))

That broader scope is approximately one to two days and should not block the LFV component prop.

## Recommendation

Contribute the small `ReviewSurface.sidebarPosition` prop upstream and keep `left` as the compatibility default. For an immediate LFV-only visual spike, use an iframe-local CSS override with a fixed width and no resizer, but do not ship that workaround as the long-term integration.
