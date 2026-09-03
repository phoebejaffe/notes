# Firebase + Google Login Setup

This app is a static Vite frontend hosted on GitHub Pages. Firebase provides Google Authentication and Firestore; no private server credentials belong in this repository.

## 1. Create the Firebase project

1. Open the [Firebase Console](https://console.firebase.google.com/).
2. Select **Create a project**.
3. Give it a project name, for example `notes-sync`.
4. Google Analytics is optional for this app. Disable it unless you specifically want analytics.
5. Finish project creation and open the project.

## 2. Register the web app

1. In **Project overview**, click the web icon (`</>`).
2. Use an app nickname such as `notes-web`.
3. Do **not** enable Firebase Hosting; GitHub Pages will host the frontend.
4. Register the app.
5. Copy the Firebase configuration values. They are browser configuration values, not admin secrets.

Create a local `.env.local` file in the repository root using this shape:

```dotenv
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
```

Use the exact values from the Firebase console. `.env.local` is ignored by git. Never put a service-account JSON file, private key, or `FIREBASE_ADMIN_*` value in the frontend environment.

## 3. Enable Google sign-in

1. In Firebase Console, open **Build > Authentication**.
2. Click **Get started** if Authentication has not been initialized.
3. Open the **Sign-in method** tab.
4. Select **Google**.
5. Enable it.
6. Choose a project support email and save.

### Authorized domains

In **Authentication > Settings > Authorized domains**, add every browser origin that will use the app:

- `localhost` for local development (usually already present)
- `<github-user>.github.io` for the GitHub Pages site
- Any custom domain, if one is added later

Add only domains you control. The GitHub Pages project path is not included in the domain entry; for example, use `phoebe.github.io`, not `phoebe.github.io/notes`.

## 4. Create the Firestore database

1. Open **Build > Firestore Database**.
2. Click **Create database**.
3. Choose a region close to the expected users. The region cannot easily be changed later.
4. Start in **production mode**.
5. Select **Create**.

Do not use test mode for a deployed app.

## 5. Install the Firebase CLI (optional but recommended)

The Firebase CLI is useful for deploying and testing Security Rules:

```bash
npm install --global firebase-tools
firebase login
firebase use --add
```

Select the project created above. If this repository later gains `firebase.json` and rules files, deploy rules with:

```bash
firebase deploy --only firestore:rules
```

The app itself is still deployed through GitHub Pages.

## 6. Firestore Security Rules

The sync design uses this private per-user namespace:

```text
users/{uid}/metadata/keyBundle
users/{uid}/documents/{day}
```

The required rule policy is:

- Only an authenticated user may access data.
- A user may access only `/users/{their-own-uid}/...`.
- Clients may read and write their own encrypted key bundle and encrypted documents.
- The rules must not attempt to inspect note plaintext; the payload is encrypted before upload.

Before production launch, verify the rules with the Firebase Emulator or the Rules Playground. Test that one signed-in user cannot read another user's documents.

## 7. GitHub Pages deployment

1. Push the repository to GitHub.
2. In the repository, open **Settings > Pages**.
3. Set the source to **GitHub Actions**.
4. Add the `VITE_FIREBASE_*` values as repository **Actions secrets** or **Actions variables**, matching the names in `.env.local`.
5. Do not commit `.env.local`.
6. Deploy the site and note its URL, usually:
   `https://<github-user>.github.io/<repository>/`
7. Add `<github-user>.github.io` to Firebase Authentication's authorized domains.

The Vite build must use the repository path as its base when the site is not served from a custom domain. For a repository named `notes`, the base is typically `/notes/`. If a custom domain is used, the base is usually `/`.

## 8. Local development checklist

From the repository root:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`. Test Google sign-in there after `localhost` has been added as an authorized domain.

If Firebase variables are absent, the app should continue to work as an offline-only local app. This is intentional and makes development and recovery possible without cloud configuration.

## 9. Encryption and recovery phrase expectations

Google login identifies the account; it is not the encryption key. Notes are encrypted in the browser before Firestore receives them.

The app uses a separate data-encryption key, wrapped by a recovery phrase. The recovery phrase should be randomly generated, written down, and never sent to Firebase. A lost phrase cannot be reset by Google or Firebase without changing the encryption model.

Recommended user procedure:

1. Generate the phrase on the first device.
2. Save it in a password manager and/or offline backup.
3. Confirm that it was copied correctly.
4. On another device, sign in with Google and enter the phrase locally.
5. Never paste the phrase into chat, issue trackers, analytics, or support tickets.

## 10. Production verification

Before sharing the app:

- Confirm no service-account credentials are present in the repository or GitHub Actions logs.
- Confirm Firestore rules reject unauthenticated requests.
- Confirm user A cannot read user B's path.
- Confirm Firestore contains ciphertext rather than readable note text.
- Test sign-in, sign-out, refresh, offline editing, reconnect, and a second device.
- Test a wrong recovery phrase and a corrupted encrypted payload.
- Keep an independent plaintext export backup until sync has been thoroughly tested.
