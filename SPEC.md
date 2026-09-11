# Noteses Application Specification

## 1. Purpose and product boundary

Noteses is a local-first daily notes application for writing, organizing, and revisiting Markdown notes. The primary workflow is a vertically browsable stream of day-based documents, with lightweight tags, muted lines, search, formatting, export, backup, and optional encrypted cloud synchronization.

The implementation is a React/TypeScript application built with Vite. It runs in a browser/PWA and in a Tauri desktop application. The current product name in the Tauri configuration and UI is **Noteses**. The repository README is still the original Vite starter documentation; this specification reflects the implemented application in `src/` and the Tauri shell in `src-tauri/`.

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

The editor is based on MDXEditor and supports headings, lists, quotes, links, tables, thematic breaks, Markdown shortcuts, directives, and an application toolbar. Existing Markdown source is preserved around editor changes where possible so application marker lines are not silently lost. The formatting bar is fixed to the viewport, with web/PWA-specific placement and responsive spacing.

Supported editing actions include:

- Bold, italic, underline, and strikethrough formatting.
- Checklist/task items with clickable checkboxes that update the Markdown task marker. The editor provides a UI fallback when MDXEditor imports a GFM checklist as an ordinary list.
- Undo/redo controls on mobile keyboard devices.
- Zoom and font-choice preferences.
- Keyboard shortcuts for common formatting and deleting one character.

### Muted lines

A line may be muted by adding a `%%` marker after its list or heading prefix. Muted tag marker lines are also supported, for example `%% <!-- tag -->` and `%% <!-- /tag -->`. The editor visually suppresses the marker prefix, and the user can toggle muted state for the selected text or current line with the formatting control or `Cmd-/`. The filter panel can hide muted lines. Muting is represented in the Markdown source and is not destructive.

### Tag markers

Tags are represented by nested Markdown container directives around Markdown content:

```markdown
:::tag{name="tag"}
Content belonging to the tag.
:::
```

Legacy paired HTML-comment markers remain readable and can be migrated per day through an explicit confirmation action. They are converted to directives for editor changes:

```markdown
<!-- tag -->
Content belonging to the tag.
<!-- /tag -->
```

Tag names containing spaces are quoted in directive attributes. Tags are normalized to Unicode NFC form, and tags are now required to be properly nested rather than crossing.

The marker engine:

- Parses open and close marker lines and produces tagged ranges.
- Reports malformed markers, unmatched closes, repeated opens, and unclosed spans as diagnostics.
- Adds a tag around a selected range or current line.
- Removes an active tag from the current selection.
- Renames a tag throughout all local documents.
- Preserves tag ranges as visual decorations in the rendered editor.

Tagged blocks receive a colored border/decorative treatment. Colors are selected per known tag in the tag manager, with a deterministic five-color fallback palette for tags without an explicit color. The first active tag determines the primary color for a block when multiple tags overlap.

The editor maintains up to twelve recently used tags for the tag autocomplete/action menu. The formatting bar shows tags surrounding the caret or selection and provides removal controls. Known tags are also derived from all parsed local documents.

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

The main menu and quick-entry menu expose search, command palette, privacy center, future-note creation, settings, reload, keyboard-shortcut help, tag management, today/all export, jump-to-today, and current-day reset.

The command palette supports keyboard navigation and commands for jumping to today, opening future days, searching, settings, privacy, syncing, backing up, importing, and exporting all notes.

Configurable shortcuts include search, settings, zoom in/out, jump to today, export today, strikethrough, task toggle, hide muted lines, shortcut help, and previous/next day. Shortcut conflicts are reported in Settings. Built-in editor shortcuts include Mod-B, Mod-I, Mod-U, and Backspace.

## 9. Preferences

Preferences are persisted locally and currently cover:

- Zoom from 60% through 150% in 10% increments.
- System, serif, or monospace font.
- Logical-day rollover hour.
- Whether empty days are shown.
- Date display format, including long, short, ISO, and numeric variants.
- Light or dark theme.
- Compact spacing.
- Automatic backup frequency: off, daily, or weekly.
- Backup retention: keep all, one week, one month, or three months.
- Onboarding and cloud-sync prompt dismissal.
- macOS failure notifications.
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

Browser backups use the File System Access API where available. Tauri backups use native commands and filesystem access. Backup failures are surfaced in Settings and can produce macOS notifications when enabled.

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
- Debounced upload of local changes after encryption is unlocked.
- Realtime remote document watching.
- Timestamp-based reconciliation for non-conflicting changes.
- Conflict detection when both local and remote non-empty Markdown differ.
- Conflict resolution by keeping local, keeping server, appending local to server, or editing/saving a merged Markdown version.
- Sign-out, which clears the active in-memory key and recovery phrase from the UI but keeps local notes.
- Permanent cloud-data deletion, which deletes cloud notes and the remote encryption key while keeping local notes.

If Firebase variables are absent, the application must continue operating locally. Offline editing is supported; the UI warns that changes made on another device while disconnected may create loss during reconciliation.

## 12. Privacy and security expectations

The privacy center reports local note counts/range, cloud-sync state, and backup state, and provides all-notes export and a link to privacy settings. Local working copies are stored in IndexedDB. Cloud note content is encrypted before upload. Backup and export files are plaintext by design and require user-controlled storage protection.

The repository must not contain Firebase service-account credentials, private keys, or committed local environment files. Production deployment must use restrictive per-user Firestore rules and verify that ciphertext, rather than note plaintext, is stored remotely.

## 13. macOS/Tauri behavior

The Tauri application provides a compact hidden-title-bar window intended for quick entry. It supports:

- Global default capture shortcut `Ctrl+Alt+N`, configurable in Settings.
- Showing, hiding, focusing, and toggling the main window from the shortcut.
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
- Conflict resolution is document/day-level rather than a general collaborative text merge.
- Tag colors and recent-tag ordering are local UI metadata and are not synchronized as part of encrypted documents.
- Browser backup functionality depends on File System Access API support.
- Native launch-at-login, opacity, menu-bar, and dock behaviors are platform-specific.
- The README should be brought into alignment with this application specification in a separate documentation change if desired; this spec is the current product reference.

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
- Improve conflict resolution with more capable structured Markdown merging and clearer deleted/empty-document handling.
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
