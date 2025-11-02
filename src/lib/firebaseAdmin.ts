// src/lib/firebaseAdmin.ts
import admin from "firebase-admin";

let initialized = false;

export function ensureFirebaseAdmin() {
  if (!initialized) {
    // IMPORTANT: Vercel env var for FIREBASE_PRIVATE_KEY is usually stored with literal "\n"
    // so we need to fix those into real newlines.
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!process.env.FIREBASE_PROJECT_ID) {
      throw new Error("Missing FIREBASE_PROJECT_ID env");
    }
    if (!process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error("Missing FIREBASE_CLIENT_EMAIL env");
    }
    if (!privateKey) {
      throw new Error("Missing FIREBASE_PRIVATE_KEY env");
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });

    initialized = true;
  }
}

// convenience export for Firestore admin
export function adminDb() {
  ensureFirebaseAdmin();
  return admin.firestore();
}
