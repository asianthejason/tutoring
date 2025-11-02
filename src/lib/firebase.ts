// src/lib/firebase.ts
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Analytics must only be loaded in the browser (not during SSR)
let analytics: import("firebase/analytics").Analytics | undefined;
function initAnalytics(app: ReturnType<typeof initializeApp>) {
  if (typeof window === "undefined") return;
  // Lazy import to keep server bundles clean
  import("firebase/analytics")
    .then(({ getAnalytics, isSupported }) =>
      isSupported().then((ok) => {
        if (ok) analytics = getAnalytics(app);
      })
    )
    .catch(() => {
      /* ignore analytics errors in dev */
    });
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, // optional
};

// Avoid re-initializing during Fast Refresh
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Core SDKs
export const auth = getAuth(app);
export const db = getFirestore(app);

// Initialize analytics only on the client
initAnalytics(app);
export { analytics };
