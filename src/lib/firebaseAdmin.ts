// src/lib/firebaseAdmin.ts
import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// We will lazily init admin so that:
// - local dev hot-reloads don't double-init
// - Vercel serverless functions don't double-init
let _adminApp: App | null = null;

/**
 * ensureFirebaseAdmin()
 *
 * Call this at the top of any server-only code (API routes, etc.).
 * It guarantees that:
 *   - Firebase Admin SDK is initialized with service account creds
 *   - We can access Firestore with admin privileges
 */
export function ensureFirebaseAdmin(): App {
  if (_adminApp) {
    return _adminApp;
  }

  // These env vars MUST exist in Vercel → Settings → Environment Variables
  // and also in your local .env file.
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin env vars. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  // Vercel will store multiline private keys with literal "\n"
  // We have to convert those back to real newlines.
  privateKey = privateKey.replace(/\\n/g, "\n");

  // If something already initialized via getApps(), reuse that instead.
  if (getApps().length > 0) {
    _adminApp = getApps()[0]!;
    return _adminApp;
  }

  _adminApp = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return _adminApp;
}

/**
 * adminDb
 *
 * Convenience Firestore admin instance. We call ensureFirebaseAdmin()
 * first to guarantee init.
 */
export const adminDb = (() => {
  const app = ensureFirebaseAdmin();
  return getFirestore(app);
})();
