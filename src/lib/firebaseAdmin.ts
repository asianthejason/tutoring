// src/lib/firebaseAdmin.ts
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// We’ll hold the initialized admin app & db in module scope
let adminApp: App | null = null;
let _db: FirebaseFirestore.Firestore | null = null;

/**
 * ensureFirebaseAdmin()
 * - Safe to call multiple times.
 * - Makes sure firebase-admin is initialized with service credentials.
 */
export function ensureFirebaseAdmin() {
  if (adminApp && _db) {
    return;
  }

  if (getApps().length === 0) {
    // These must exist in Vercel env
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Missing Firebase admin env vars");
    }

    adminApp = initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  } else {
    adminApp = getApps()[0]!;
  }

  _db = getFirestore(adminApp);
}

/**
 * adminDb
 * - After ensureFirebaseAdmin() has run, this is your Firestore Admin DB instance.
 */
export function adminDb() {
  if (!_db) {
    throw new Error(
      "adminDb() called before ensureFirebaseAdmin(). Call ensureFirebaseAdmin() first."
    );
  }
  return _db;
}

/**
 * adminAuth (optional helper if you ever need it elsewhere)
 */
export function adminAuth() {
  if (!adminApp) {
    throw new Error(
      "adminAuth() called before ensureFirebaseAdmin(). Call ensureFirebaseAdmin() first."
    );
  }
  return getAdminAuth(adminApp);
}
