# LectureScribe for Android

Same LectureScribe app, wrapped as a native Android app so live transcription
uses the phone's own speech service instead of Chrome's web version.

## Build the APK on GitHub
1. Create a new empty GitHub repository.
2. Upload everything in this folder to it (keep the `.github` folder).
3. Open the repository's **Actions** tab. The "Build Android APK" workflow runs
   on every push (or press **Run workflow**).
4. When it finishes (about 5 to 8 minutes), open the run and download the
   **LectureScribe-apk** file under Artifacts. Unzip it to get `app-debug.apk`.
5. Send the APK to your phone and install it (allow "install unknown apps").

If a step fails, open it in the run log and send me the red error lines.

## Accounts and saved data (Firebase)
Sign-in uses Firebase Authentication (email and password). Lectures and the
profile are saved to Firestore under `users/{uid}`, and a copy always stays on
the phone so the app still works with no internet.

One-time setup in the Firebase console (project `lecturescribe-13270`):
1. **Authentication** > Sign-in method > turn on **Email/Password**.
2. **Firestore Database** > Create database (production mode, pick a region).
3. Firestore > **Rules** > paste the contents of `firestore.rules` > Publish.
