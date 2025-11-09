// src/app/api/admin/delete-account/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Ensure this runs on Node (Admin SDK won't work on Edge)
export const runtime = "nodejs";
// Avoid caching
export const dynamic = "force-dynamic";

function initAdmin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID!,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
        privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      }),
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    initAdmin();

    const { uid } = await req.json();
    if (!uid) return NextResponse.json({ error: "Missing uid" }, { status: 400 });

    const idToken = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!idToken) return NextResponse.json({ error: "Missing token" }, { status: 401 });

    // verify caller
    const adminAuth = getAuth();
    const decoded = await adminAuth.verifyIdToken(idToken);
    const meUid = decoded.uid;

    const db = getFirestore();
    const meDoc = await db.doc(`users/${meUid}`).get();
    if ((meDoc.data()?.role ?? "student") !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (uid === meUid) {
      return NextResponse.json({ error: "Cannot delete self" }, { status: 400 });
    }

    // delete Auth user (ignore if not found), then users/ doc
    await adminAuth.deleteUser(uid).catch((e: any) => {
      if (e?.errorInfo?.code !== "auth/user-not-found") throw e;
    });
    await db.doc(`users/${uid}`).delete().catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Delete failed" }, { status: 500 });
  }
}
