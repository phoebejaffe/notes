# Noteses Application Specification

## 1. Purpose and product boundary

Noteses is a local-first daily notes application for writing, organizing, and revisiting Markdown notes. The primary workflow is a vertically browsable stream of day-based documents, with lightweight tags, muted lines, search, formatting, export, backup, and optional encrypted cloud synchronization.

The implementation is a React/TypeScript application built with Vite. It runs in a browser/PWA and in a Tauri desktop application. The current product name in the Tauri configuration and UI is **Noteses**. The README provides user-facing setup and product documentation; this specification reflects the implemented application in `src/` and the Tauri shell in `src-tauri/`.

## 2. Supported runtimes

- **Browser:** Vite web application with IndexedDB local persistence. It can be installed as a PWA where the browser supports installation; the service worker and web manifest are in `public/`.
- **iOS/iPadOS browser/PWA:** The application includes mobile keyboard and iOS standalone-display handling. Users are directed to Safari’s Add to Home Screen flow when installation prompting is unavailable.
- **Tauri desktop:** The application is packaged as Noteses through Tauri. The current native implementation includes macOS-specific window, menu bar, dock, notification, launch-at-login, transparency, and global-shortcut behavior. Some related preferences report native-platform errors when used outside macOS.
- **Static hosting:** The web build is deployable to GitHub Pages. Firebase is optional; without Firebase configuration, the app remains an offline-only local application.

## 3. Core data model and persistence

### Daily documents

Each note is a `DailyDocument` with:

- `day`: an ISO-like local date key in `YYYY-MM-DD` form.
- `markdown`: the editable Markdown source.
- `updatedAt`: a millisecond timestamp used for local/cloud synchronization.

Documents are stored locally in IndexedDB database `notes-local`, object store `daily-documents`, keyed by `day`. Changes are debounced before being saved. Empty documents are not included in exported all-notes output or generated backups, although empty day cards can be displayed according to preferences.

Preferences and lightweight UI state are stored in `localStorage`, including editor preferences, onboarding state, recovery phrases associated with a signed-in user, future-day state, recent tags, tag colors, and the last backup signature.

### Logical days

The current day is calculated using a configurable rollover hour, from midnight through 5:00 AM. Times before the rollover belong to the previous logical day. Day cards are displayed using the selected date format and can be navigated to today or adjacent days.

## 4. Main notes experience

- The main view is a scrollable daily stream.
- Today is always available. All existing saved days are loaded into the stream, and empty days may be shown when `showEmptyDays` is enabled.
- When the logical day changes at the configured rollover hour, the new day is added automatically without requiring an application restart.
- A future date can be selected explicitly. Opening a future day creates a local empty day and records it for future-day behavior.
- Opening a future note displays a reminder that can be dismissed or snoozed for one day.
- Each day card contains a Markdown editor and marker diagnostics when tag syntax is malformed or unbalanced.
- The current day can be exported independently. All non-empty notes can be exported as one Markdown file with date headings and separators. The menu can enable a persistent raw-text mode that replaces each rich editor with its exact Markdown source; a fixed banner provides the way to turn raw mode off.
- A sample-note reset command exists for the current day and is intended as a development/demo affordance, not as a general data-management workflow.

## 5. Markdown editor

> **Editor rebuild in progress (branch `editor-v3`).** The bespoke editor layer was removed and is being rebuilt test-first against the e2e suite in `e2e/`. The descriptions below reflect the current stripped state; strikethrough, custom shortcuts, raw text mode, and the audio player are pending rebuild. Refer to `main` for the previous implementation.

The editor is based on MDXEditor and currently supports headings, lists (including `- [ ]` checklists with click-to-toggle checkboxes), quotes, links, tables, thematic breaks, and Markdown input shortcuts — including typing `- [ ] `/`- [x] ` at a block start or `[ ] ` at the start of an existing list item, which converts that item into a task (the item is split into its own check list, since Lexical clears `checked` on non-check lists; Markdown requires adjacent unordered lists to use different bullets, so a task sandwiched between `-` lists exports with a `*` bullet). A formatting bar renders MDXEditor's bold/italic/underline and list toggles, a mute button, a mobile-only gesture button (visible only on coarse-pointer devices — a tap does nothing; dragging up/down moves the selected lines like Option-Arrow, and dragging right/left indents and outdents list items in source space, repeating once per drag stride), a tag input with recent-tag suggestions, and active-tag chips with remove buttons; the rendered selection stays highlighted while the tag input is focused. The bar is sticky at the top of each editor and shown only while that editor has focus (it stays visible in the capture shell), follows the active light/dark theme, remains at the window scale when editor zoom is enabled, and is fixed just below the top bar. A single bar is always rendered: the focused editor's bar is enabled; when no editor has focus the first card's bar shows disabled, and in the macOS capture window the bar is fixed at the bottom as a compact dark-grey strip that stays enabled across transient focus changes. Pinch zoom is disabled app-wide (viewport `user-scalable=no`, `touch-action: pan-x pan-y`, and iOS `gesture*` event blocking); the editor Zoom preference remains available on non-mobile devices.

Editor commands run in Markdown space: the DOM selection is mapped to canonical source lines through mdast source positions (`src/editor/sourceMapping.ts`), the operation mutates the source (via `markerEngine`), the result is re-imported, and the caret/selection is restored at the corresponding lines. Currently wired: Option/Alt+ArrowUp/Down moves the selected source lines — a moved line that is not part of a list jumps past a whole contiguous list as one block; a line adjacent to a `:::tag` block from outside *enters* the tag, landing as its own blank-separated block just inside the delimiter, and from there keeps moving through the tag's contents; a line moved across its tag boundary from inside escapes the tag, landing as its own blank-separated block; a selection that straddles exactly one `:::tag` fence instead moves the *fence* — moving toward the tag's interior extends it to enclose the selection, moving away shrinks it to exclude the selection — Cmd+Enter toggles a checklist item or converts a block to a task, Cmd+Shift+Enter drops a checkbox marker, Cmd+Shift+C turns a task/bullet into plain text, Cmd+/ (or Ctrl+/) toggles `%%` on the selected lines, and the tag input wraps the selected source lines in `:::tag{name="…"}` (a selection overlapping an existing tag tags each contiguous region separately — nested inside the existing tag, sibling outside — since tags nest but never overlap, like HTML). Plain ArrowUp at the editor's visual top edge or ArrowDown at its bottom edge moves the caret into the adjacent day's editor, landing on the first/last rendered line at roughly the same horizontal position (the caret's x coordinate is carried across and hit-tested on the destination row, clamping to the line's edges — a shorter target line lands at its end); when the caret is on the first line inside a leading tag, ArrowUp first inserts an ordinary empty paragraph above the tag so text can be typed before it, and the paragraph is cleaned up when navigation continues past it. Cmd-Option-ArrowUp/Down jumps straight to the adjacent day's editor from anywhere (same edge-landing semantics), and Cmd-ArrowUp/Down moves the caret to the top or bottom of the current editor. Cmd-Shift+Arrow selection extension is never intercepted, and neither are other modified arrows. The caret is kept inside the visible band — the viewport minus the fixed top bar and formatting toolbar — on every selection change: if a caret move leaves it behind the chrome, the scroll container centers it (`src/editor/caretVisibility.ts`). When the macOS capture window gains focus, an existing editor caret is scrolled into view instantly — preferring the stream top when the caret is already in the first screenful — and when no caret exists, today's editor is focused at the end of its text.

Markdown source is the canonical persisted format. Before rendering, `markdownForEditor` inserts a blank line between a list item and a directly following non-list line (otherwise the next line would merge into the item as a lazy continuation); `restoreMarkdownSpacing` strips those injected blanks on export. `:::tag{…}` container directives import as `TagBlockNode` — a plain Lexical `ElementNode` (`src/editor/TagBlockNode.ts`) rendered as a `.notes-tag-directive` div whose children are ordinary blocks in the same editable (no nested editor, so caret behavior stays consistent). A priority import visitor in `tagBlockPlugin` claims `tag` directives; other container directives (`:::muted`, `:::custom-block`) still use the generic nested-editor descriptor. Tag chips and the colored left border are pure CSS on `.notes-tag-directive`; JS only sets `--notes-tag-color` per tag. Lines containing a linked `__` (ring-transcription recordings) get a `≈` gutter marker centered on the editor's left border, rendered as an overlay outside the contenteditable so Lexical never reconciles it; markers hide on muted lines when muted content is hidden (including soft-break lines that ghost rather than collapse). Custom import/export visitors preserve per-item checkbox state so a plain bullet inside a task list stays plain. Unordered lists export with `-` bullets. The marker engine (`src/markerEngine.ts`) parses `%%` muted lines and `:::tag` directives for app-level features — the filter panel, tag manager, and per-day diagnostics all remain functional.

### Muted lines

A line is muted when it contains `%%` anywhere; muting a line appends ` %%` at the end so Markdown line-prefix syntax (lists, headings, quotes, checklist markers) is undisturbed, and unmuting strips every marker. `markdownForEditor` removes `%%` markers before rendering so they never appear in editor text (arrowing left to the end of a muted line lands the caret before the marker, and typing keeps the line muted); `preserveMutedLines` restores markers on export by matching edited lines against the previous source. Dimming and hide-muted-lines are applied via `src/editor/mutedDecorations.ts` — CSS Highlight ranges mapped from canonical lines through `sourceMapping.ts`, idempotent so Lexical's MutationObserver never sees DOM churn. Soft-break lines within a paragraph are individually mutable.

External `value` changes (sync/merge) are pushed into the editor via `setMarkdown`, preserving the caret's canonical line so remote updates don't yank it mid-typing; an interaction gate prevents mount/normalization echoes from writing back to the document. Plain-text paste is routed through `insertMarkdown` so pasted Markdown parses (lists, directives, formatting) rather than landing as escaped literal text; rich HTML paste is left to Lexical. Source-space commits (mute, tag wrap/remove, line moves, checklist drops) are invisible to Lexical's undo history, so the editor keeps its own undo stack — Meta/Ctrl+Z reverts the most recent commit and restores the caret when the last change was a commit, otherwise deferring to Lexical. Lexical chrome such as `data-lexical-cursor` divs is excluded from DOM↔mdast child indexing (`blockChildren`).

### Tag source format

Tags are represented by nested Markdown container directives around Markdown content:

```markdown
:::tag{name="tag"}
Content belonging to the tag.
:::
```

Tag names containing spaces are quoted in directive attributes and normalized to Unicode NFC. **Nested tags use strictly longer fences outward** (`::::tag` inside `:::tag` requires the outer to be `::::`) — micromark closes a container directive on the first fence of equal length, so `addTagDirectiveToRange` lengthens enclosing delimiters when nesting. The marker engine parses directives into nested ranges, reports malformed/unbalanced diagnostics, adds and removes tags around line ranges, and renames tags across documents. Malformed `:::tag{…}` openers and orphaned `:::` closers render as plain text and surface diagnostics rather than corrupting the document. Tag colors are configurable per known tag in the tag manager and are applied to the tag chip and border in the editor via `--notes-tag-color`.

## 6. Search and filtering

- Search is available from the top bar and menu and searches the loaded note content.
- Search displays the number of matches when a query is entered.
- The filter panel supports selecting one or more known tags.
- When tag filters are active, a day is shown when its content contains a range matching the selected tag(s).
- The filter panel also provides a hide-muted-lines option and a clear-filters action.
- Filtering and search are local operations over the locally loaded documents.

## 7. Organization and tag management

The known-tags manager lists tags found in local documents. It supports:

- Choosing a color for each known tag.
- Renaming a tag everywhere across all local documents.
- Opening from Settings or the main/quick-entry menu.

Tag metadata is currently local UI state; tag colors are not part of the Markdown document and are not included in cloud document payloads.

## 8. Commands, menus, and shortcuts

The main menu and quick-entry menu expose search, command palette, future-note creation, settings, reload, keyboard-shortcut help, tag management, today/all export, jump-to-today, and current-day reset.

The command palette supports keyboard navigation and commands for jumping to today, opening future days, searching, settings, syncing, backing up, importing, and exporting all notes.

Configurable shortcuts include search, settings, zoom in/out, jump to today, export today, strikethrough, task-to-plain-text (default Mod-Shift-C, removes the checkbox and list marker leaving plain text), hide muted lines, shortcut help, and previous/next day. Shortcut conflicts are reported in Settings. Built-in editor shortcuts include Mod-B, Mod-I, Mod-U, Mod-T (focus tag input), Mod-Enter (check/uncheck the current task, or turn the current line into a task), Mod-Shift-Enter (remove the checkbox, leaving a plain list item), Option-ArrowUp/Option-ArrowDown (move selected lines), Mod-Option-ArrowUp/Mod-Option-ArrowDown (move the caret to the editor above or below), Mod-ArrowUp/Mod-ArrowDown (caret to the top or bottom of the current editor), and Backspace.

## 9. Preferences

Preferences are persisted locally and currently cover:

- Zoom from 60% through 150% in 10% increments.
- System, serif, or monospace font.
- Logical-day rollover hour.
- Whether empty days are shown.
- Date display format, including long, short, ISO, and numeric variants.
- Light or dark theme.
- Compact spacing.
- Automatic backup frequency: off, daily, or weekly (mac app only).
- Backup retention: keep all, one week, one month, or three months (mac app only).
- Onboarding and cloud-sync prompt dismissal.
- macOS failure notifications.
- Ring phone alerts (browser/PWA only): when enabled, the app subscribes to Web Push on its service worker and stores the subscription at `users/{uid}/pushSubscriptions`. A ring recording whose transcription begins with `notify` or `urgent` pushes a `Noteses` notification (`🗒️`/`🚨` prefix) to every subscribed device; `urgent` sends at high urgency. The VAPID public key is provisioned by the receiver into `metadata/pushConfig` so no build-time config is needed and rotations propagate automatically.
- Capture shortcut, always-on-top behavior, window opacity, launch at login, menu-bar visibility, and dock-icon visibility.
- Custom keyboard shortcuts.

At least one of the macOS menu-bar or dock entry points must remain enabled.

## 10. Backup, import, and export

### Export

- Export today writes the current day’s Markdown as `YYYY-MM-DD.md`.
- Export all writes a combined `notes.md` containing non-empty days ordered by date, with formatted date headings and horizontal separators.
- Export is available in browser and Tauri contexts through a browser download-style flow.

### Automatic backups

When enabled, backups write plain Markdown files to a user-selected folder. Daily backups use a date folder; weekly backups use a `week-YYYY-MM-DD` folder based on the Monday of that week. Existing-period folders are updated as notes change. Retention can remove generated backup folders older than the selected period. Backups are plaintext and should be treated as sensitive.

Backup controls are only exposed in the mac app, which uses native commands and filesystem access. The app reports the last backup time by scanning the newest `.md` file modification time inside generated backup folders, so the status reflects backups from previous launches as well as the current session. A browser backup path via the File System Access API exists in code but is not currently surfaced in the web UI. Backup failures are surfaced in Settings and can produce macOS notifications when enabled.

### Import

A backup folder can be previewed and imported. The import UI reports valid Markdown day files and ignored invalid files, handles collisions with keep-local, keep-imported, or append choices, and supports additive or replace-all import mode. Replace mode can replace all local notes, so it is a destructive data operation in the product UI and must remain explicitly reviewable.

## 11. Optional encrypted cloud sync

Cloud sync is optional and uses Firebase Authentication plus Firestore. Google sign-in identifies the account but is not the encryption key.

The sync flow is:

1. The user signs in with Google.
2. A new account receives a randomly generated 12-word recovery phrase, or an existing account accepts its original phrase.
3. The phrase is normalized locally and used with PBKDF2-SHA-256 (600,000 iterations) to derive an AES-GCM-256 wrapping key.
4. A randomly generated AES-GCM-256 data key is wrapped by that key and stored as a remote key bundle.
5. Daily Markdown and timestamps are encrypted in the browser before upload, with document-specific associated data.
6. Firestore stores only the encrypted document envelope and metadata needed for synchronization.

The intended Firestore namespace is:

```text
users/{uid}/metadata/keyBundle
users/{uid}/documents/{day}
```

Only the authenticated user’s namespace should be accessible under the Firestore rules. The recovery phrase is never sent to Firebase. Losing it prevents unlocking existing encrypted cloud data; Google sign-in cannot reset it.

Sync supports:

- Manual sync.
- Debounced transactional upload of changed daily documents after encryption is unlocked.
- Realtime remote document watching.
- Local-only sync-base tracking and line-based three-way reconciliation for concurrent local/remote Markdown changes.
- Conflict detection when both sides changed the same Markdown region differently or no usable sync base exists.
- Conflict resolution by keeping local, keeping server, appending local to server, or editing/saving a merged Markdown version.
- Sign-out, which clears the active in-memory key and recovery phrase from the UI but keeps local notes.
- Permanent cloud-data deletion, which deletes cloud notes and the remote encryption key while keeping local notes.

The remote document payload remains `{ markdown, updatedAt }`. Each local IndexedDB record may additionally retain a `syncBase` Markdown snapshot used only as the three-way merge ancestor; that base is never included in the encrypted remote payload. External writers such as the Pebble receiver can update the same encrypted daily documents, so uploads must read the latest remote document transactionally and must not overwrite unseen remote changes. A realtime snapshot matching an in-flight upload is treated as the app's own write echo and adopted as the new merge base rather than merged, so rapid consecutive edits cannot conflict with themselves.

If Firebase variables are absent, the application must continue operating locally. Offline editing is supported; concurrent offline edits made on another device may produce a reviewable conflict rather than silent data loss.

## 12. Privacy and security expectations

The Cloud sync section of Settings reports local note counts/range and cloud-sync state above the recovery phrase input; in the mac app it also reports backup state. Local working copies are stored in IndexedDB. Cloud note content is encrypted before upload. Backup and export files are plaintext by design and require user-controlled storage protection.

The repository must not contain Firebase service-account credentials, private keys, or committed local environment files. Production deployment must use restrictive per-user Firestore rules and verify that ciphertext, rather than note plaintext, is stored remotely.

## 13. macOS/Tauri behavior

The Tauri application provides a compact hidden-title-bar window intended for quick entry. It supports:

- Global default capture shortcut `Ctrl+Alt+N`, configurable in Settings.
- Showing, hiding, focusing, and toggling the main window from the shortcut. Hiding the window hides the application entirely (`NSApplication.hide:` on macOS), restoring focus to the previously active application.
- A menu-bar tray icon and optional dock icon.
- Always-on-top capture mode.
- Configurable macOS window opacity/transparency.
- Saved window geometry with visibility validation on restore.
- Launch at login.
- Native menu items for editing, keep-on-top, close, and macOS transparency levels.
- Native notification integration for sync/backup failures when enabled.

Capture mode focuses today’s editor and presents a reduced quick-entry layout. The app remains usable as a normal web application when Tauri APIs are unavailable.

## 14. Routes and special UI

The normal route renders the Noteses daily notes application. `/prototype` renders the existing Markdown prototype page and is a separate prototype surface, not part of the normal daily-notes workflow.

## 15. Build, test, and deployment contract

The package scripts currently define:

- `npm run dev`: start Vite development server.
- `npm run build`: run TypeScript project build and Vite production build.
- `npm run lint`: run Oxlint.
- `npm run test`: run the Vitest suite.
- `npm run tauri:dev`: run the Tauri development application.
- `npm run tauri:build`: build Tauri artifacts.

Tests currently cover backup behavior, encrypted sync behavior, editor Markdown source preservation, and editor command behavior. GitHub Actions builds and deploys the web artifact to GitHub Pages from `main`; Firebase configuration is supplied through build environment variables.

## 16. Current limitations and invariants

- Cloud sync requires Firebase configuration, Google authentication, and the original recovery phrase.
- The sync query is currently bounded to the newest 1,000 remote documents.
- Concurrent Markdown changes use line-based three-way merging; ambiguous same-region edits still require day-level conflict resolution.
- Tag colors and recent-tag ordering are local UI metadata and are not synchronized as part of encrypted documents.
- Automatic backups are only exposed in the mac app; the dormant browser path would depend on File System Access API support.
- Native launch-at-login, opacity, menu-bar, and dock behaviors are platform-specific.
- The README is a user-facing summary and setup guide; this spec remains the more detailed product reference.

## 17. Future improvements

This section is intentionally maintained as a living backlog. It should be updated when future work is identified or completed, and it should be consulted when the user asks what work can be done next.

### Tag organization and visual treatments

- Add configurable **tag prioritization** for sorting the autocomplete/recent-tags menu, rather than relying only on recent use and the current limited list.
- Add richer UI treatments for individual tags, including per-tag visual styles beyond the current border/color treatment.
- Define and implement a consistent default UI treatment for all tags, including default background colors, contrast-safe text colors, chips, borders, and behavior when multiple tags overlap.
- Consider persisted tag metadata such as priority, color, icon, visibility, and display style, with a clear decision about whether that metadata should sync across devices.

### Product and data workflow

- Improve search result navigation and make search semantics explicit for Markdown, tags, muted content, and date ranges.
- Add broader date navigation/history controls for large note collections.
- Consider CRDT or operation-based syncing for richer real-time collaboration, and improve deleted/empty-document conflict handling.
- Revisit the 1,000-document sync limit and define pagination/retention behavior for long-lived accounts.
- Add robust validation and recovery flows for malformed imports, interrupted backups, and corrupted local storage.
- Decide whether sample/reset functionality should remain in production UI or move to a development-only surface.

### Privacy, sync, and platform support

- Add automated verification of Firestore security rules and multi-device sync scenarios.
- Consider an encrypted backup format for users who do not want plaintext backup folders.
- Improve recovery-phrase confirmation and provide a clearer, safer phrase backup flow without ever uploading the phrase.
- Document and test native behavior on supported non-macOS Tauri targets before presenting those options as cross-platform features.

### Documentation and quality

- Replace the Vite starter README with user-facing setup and product documentation derived from this specification.
- Expand automated UI/accessibility coverage for editing, filtering, import/export, sync conflicts, and capture mode.
- Add explicit performance expectations for large documents and large day histories.
