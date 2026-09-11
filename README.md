# Noteses

Noteses is a local-first daily Markdown notes app. Write in a vertically browsable stream of day-based notes, organize content with nested tags, mute lines you do not want to see, and optionally sync encrypted notes across devices.

Your working notes stay in the browser or desktop app by default. Cloud sync and backups are opt-in.

## Features

- Daily notes with a configurable logical-day rollover from midnight through 5:00 AM.
- Automatic addition of the new day when the rollover time is reached.
- Rich Markdown editing powered by MDXEditor: headings, lists, quotes, links, tables, thematic breaks, Markdown shortcuts, formatting, and task checkboxes.
- Raw-text mode for editing the exact Markdown source, with a persistent banner for returning to the rich editor.
- Nested tag directives with tag autocomplete, active-tag controls, filtering, diagnostics, colors, and rename-everywhere support.
- Legacy HTML-comment tags remain readable and can be migrated to directives for an individual day after confirmation.
- Muted lines, including muted tag marker lines, with a hide-muted-lines filter.
- Local search, tag filtering, command palette, configurable keyboard shortcuts, dark mode, compact spacing, and font/zoom preferences.
- Markdown export for today or all non-empty days.
- Optional daily or weekly plaintext backups with configurable retention and import collision handling.
- Optional Google sign-in and end-to-end encrypted Firestore sync using a separate recovery phrase.
- Browser/PWA support and a Tauri desktop quick-entry window with macOS menu-bar, global shortcut, always-on-top, transparency, launch-at-login, and notification features.

See [`SPEC.md`](./SPEC.md) for the complete application behavior and maintained product backlog.

## Run locally

Requirements:

- Node.js 22 or newer is recommended, matching the GitHub Pages workflow.
- npm.

Install dependencies and start the web app:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`.

Firebase is not required for local development. Without Firebase environment variables, Noteses works as an offline-only local app.

## Commands

```sh
npm run dev          # Start the Vite development server
npm run build        # Type-check and create a production web build
npm run preview      # Preview the production web build
npm run lint         # Run Oxlint
npm run test         # Run the Vitest test suite
npm run tauri:dev    # Run the Tauri desktop app
npm run tauri:build  # Build Tauri application artifacts
```

The normal web route renders Noteses. `/prototype` renders the existing Markdown prototype page.

## Local storage and Markdown format

Daily notes are stored in IndexedDB under the `notes-local` database and `daily-documents` object store. Preferences and lightweight UI metadata are stored in `localStorage`. Empty notes are not included in all-notes exports or backups.

### Tags

New tags use nested Markdown container directives:

```markdown
:::tag{name="therapy"}
I noticed I am more comfortable setting boundaries.
:::
```

Tag names containing spaces are stored in the quoted `name` attribute:

```markdown
:::tag{name="spring launch"}
Draft the onboarding flow.
:::
```

Tags must be properly nested. Older notes may contain paired HTML-comment markers:

```markdown
<!-- therapy -->
Older tagged content.
<!-- /therapy -->
```

These legacy markers remain readable. When a day contains valid legacy tags, use **Migrate legacy tags** to convert that day to directives after reviewing the confirmation prompt. Malformed or unbalanced legacy markers are left unchanged and reported as diagnostics.

### Muted lines

Prefix a line with `%%` after its list or heading prefix to mute it:

```markdown
%% This line is muted.
- %% This list item is muted.
```

Muted tag markers are also supported. Muting changes the Markdown source but does not delete the content. Use the editor control or `Cmd-/` to toggle muting, and use the filter panel to hide muted lines.

## Backups and exports

Use the menu to export today as `YYYY-MM-DD.md` or all non-empty notes as `notes.md`.

Automatic backups are disabled by default. When enabled in Settings, choose a folder and daily or weekly frequency. Backups are plaintext Markdown files in generated date folders, so protect the selected folder. Retention can keep all backups or remove generated folders older than one week, one month, or three months.

The import workflow previews Markdown day files, reports ignored invalid files, and lets you keep local content, keep imported content, or append on collisions. Replace-all import is available when deliberately restoring a complete backup.

## Encrypted cloud sync

Cloud sync uses Firebase Authentication and Firestore, but Firebase is optional. Notes are encrypted in the client before upload:

1. Sign in with Google.
2. Create or enter the account's recovery phrase in Settings.
3. Save the recovery phrase somewhere private and durable.
4. Unlock encrypted sync and use **Sync now**, or let unlocked local changes sync automatically.

The recovery phrase is separate from Google authentication and is never sent to Firebase. It unlocks an AES-GCM-256 data key wrapped with PBKDF2-SHA-256. Losing the phrase means existing encrypted cloud data cannot be unlocked or reset through Google.

Sync supports realtime remote updates, timestamp-based reconciliation, and day-level conflict resolution. Conflicts can be resolved by keeping local, keeping the server version, appending local content, or editing a merged version.

To configure Firebase, Google sign-in, Firestore, desktop OAuth, and security rules, follow [`FIREBASE_SETUP.md`](./FIREBASE_SETUP.md). Do not commit `.env.local`, service-account files, private keys, or Firebase Admin credentials.

## Browser, PWA, and desktop use

### Browser and PWA

Noteses can be used directly in a browser and installed as a PWA where supported. On iPhone or iPad, use Safari's **Share → Add to Home Screen** flow if the browser does not provide an install prompt.

### Tauri desktop

The Tauri app opens a compact quick-entry window. On macOS it supports:

- `Ctrl+Alt+N` to show or hide the capture window by default.
- A menu-bar tray icon and optional dock icon.
- Always-on-top capture mode.
- Window transparency/opacity controls.
- Launch at login.
- Saved window geometry.
- Native notifications for sync and backup failures when enabled.

At least one of the menu-bar or dock entry points must remain enabled.

## Deployment

The web app is configured for GitHub Pages deployment through [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml). The workflow builds the Vite output and publishes `dist` when changes are pushed to `main` or when manually dispatched.

Set the `VITE_FIREBASE_*` values as GitHub Actions variables if the deployed site should support cloud sync. Add the deployed host, such as `your-user.github.io`, to Firebase Authentication's authorized domains. The repository path is supplied as the Vite base path by the workflow.

## Security and data safety

- Local notes are stored in browser/desktop local storage and are not automatically uploaded.
- Cloud note content is encrypted before it reaches Firestore.
- Plaintext exports and backups are intentionally user-controlled and should be protected.
- Firestore rules must restrict access to each authenticated user's own `users/{uid}` namespace.
- Keep an independent export backup while testing sync and recovery.

## Development notes

The application is implemented in React and TypeScript with Vite, MDXEditor, Firebase, and Tauri. Unit tests cover backup behavior, encrypted sync, editor source preservation, editor commands, and tag parsing. Before submitting changes, run the relevant build, lint, and test commands. For macOS/Tauri behavior changes, also run `npm run tauri:build` and report the generated macOS artifacts as required by [`AGENTS.md`](./AGENTS.md).

Product behavior is specified in [`SPEC.md`](./SPEC.md). Keep that document and its **Future improvements** section updated as the application evolves.
