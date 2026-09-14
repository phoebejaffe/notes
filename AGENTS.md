# AGENTS.md

- Keep [`SPEC.md`](./SPEC.md) updated whenever agents change application behavior, architecture, supported workflows, or product direction. Maintain its `Future improvements` section as work is identified, completed, or reprioritized; consult that section when the user asks what work can be done next.
- When changing behavior specific to the macOS/Tauri app, run `npm run tauri:build` before finishing and report the generated macOS artifacts.
- It is fine to edit files that contain unstaged changes. However, do not fix unrelated "issues" in those edits — they may be another agent's in-progress work. If a fix is needed there, ask the user for permission first.

## Verification commands

- `npm run lint` — oxlint (fast; run after every change)
- `npm test` — Vitest unit tests
- `npm run build` — `tsc -b && vite build`
- `npm run test:e2e` — Playwright (Chromium only; WebKit is not installed)
- `npm run tauri:build` — macOS app bundle; artifacts land in `src-tauri/target/release/bundle/{macos,dmg}/`. Expect ~20s of Rust compilation after the Vite build — it may outlive a short shell timeout; poll for completion.
- `cargo check` inside `src-tauri/` for a quick Rust-only compile check.

## Architecture invariants

- **Markdown is the canonical persisted format.** MDXEditor/Lexical is a UI layer only — rendering, decorations, and interactions must be nondestructive to the Markdown source. Persisted docs live in IndexedDB `notes-local`, store `daily-documents`, keyed by `day`.
- **Tags** are custom Lexical `ElementNode`s (`TagBlockNode`) serialized as nested Markdown container directives — never HTML comments. `%%` is the muted-line syntax.
- **Platform gating** uses `isTauriEnvironment()` in `src/App.tsx`. Anything needing filesystem access (backups) or native APIs is mac-app-only; the browser build must keep working without it.
- **Firebase is optional.** If `VITE_FIREBASE_*` env vars are absent the app runs fully local; cloud sync encrypts with a key derived from the user's recovery phrase (stored per-user under `notes-recovery-phrase:${uid}`).
- Preferences live in localStorage `notes-preferences`. Useful keys for repro scripts: `onboardingDismissed`, `syncPromptDismissed` (set both to skip first-run modals).

## Editor pitfalls (Lexical/MDXEditor)

- `editor.focus(callback)` defers the callback outside an update context — DOM/selection mutations inside it silently fail. To run real mutations, capture the `LexicalEditor` via a realm plugin on `rootEditor$` (see `src/editor/mdxEditorPlugins.tsx`) and call `editor.update()`.
- `.mdxeditor-root-contenteditable` wraps top-level blocks in `.mdxeditor-contenteditable-wrapper`, so `firstElementChild`/`lastElementChild` are not blocks. Use `TOP_LEVEL_BLOCK_SELECTOR`/`topLevelBlocks()` in `MdxNotesEditor.tsx`.
- MDXEditor appends an invisible trailing empty `<p>` after a trailing tag block — caret-edge detection must treat all-empty trailing blocks as the editor edge.
- Any DOM churn inside the contenteditable makes Lexical's MutationObserver revert the caret to a stale internal selection (causes flaky tests AND eaten keystrokes). Decorators (`applyTagDecorations`, `applyChecklistWidgets`, `applyMutedVisibility`) must be idempotent: reuse elements, only write attributes/styles when the value actually changes, and read the latest source via a getter rather than a stale closure.
- Removing a node that Lexical's stale internal selection points at drags the DOM caret back — call `$setSelection(null)` before removing (see the boundary-paragraph cleanup).
- Cross-editor arrow navigation only intercepts *plain* ArrowUp/ArrowDown — never Cmd/Shift-modified arrows.

## Styling/macOS specifics

- Never put CSS `zoom` on the `100vh` app shell — it shrinks the shell below the window and, in WebKit, makes `position: fixed` anchor to the zoomed element. Zoom applies to `.day-stream` via the `--editor-zoom` custom property.
- Dark mode is a `.theme-dark` class on the shell, not `document.body` — portals/popovers must render inside `.app-shell`/`.capture-shell` to inherit it.
- The mac app's only window is the capture window (`index.html?mode=capture`, hidden title bar, transparent, always-on-top). Tauri window focus events drive "focus today's editor" behavior via the `notes-focus-edge` custom event.
- The formatting toolbar is intentionally hidden until an editor has focus (`:focus-within`).

## Testing notes

- E2e specs live in `e2e/` and run against the prototype page; repro scripts can seed IndexedDB directly (remember the onboarding modal).
- Caret/selection assertions race Lexical's async reconciliation — use `expect.poll`, not immediate `page.evaluate`.
- Delete temporary repro scripts (`repro-*.mjs`) before finishing.

## Deployment

- `main` deploys to GitHub Pages via Actions on push (Firebase config comes from build env vars). The `feature/mdx-editor-migration` branch is pushed alongside to stay in sync.
