// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

/** ---------- Config ---------- */
const ROOM_NAME = "default-classroom";

/** ---------- Firebase Admin init (optional in dev) ---------- */
let adminReady = false;

function initFirebaseAdmin() {
  if (admin.apps.length) {
    adminReady = true;
    return;
  }

  try {
    const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (svcJson) {
      const creds = JSON.parse(svcJson);
      admin.initializeApp({
        credential: admin.credential.cert(creds as admin.ServiceAccount),
      });
      adminReady = true;
      return;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey && privateKey.includes("\\n")) {
      privateKey = privateKey.replace(/\\n/g, "\n");
    }

    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      adminReady = true;
      return;
    }

    // no creds in dev is allowed
    adminReady = false;
  } catch {
    adminReady = false;
  }
}
initFirebaseAdmin();

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

// helper to make a tiny random suffix for anon dev identities
function randSuffix(len = 6) {
  // simple base36 random
  return Math.random().toString(36).slice(2, 2 + len);
}

export async function POST(req: NextRequest) {
  try {
    // read body from client
    const body = await req.json().catch(() => ({}));
    const claimedRole = (body?.role as "tutor" | "student") || "student";
    const claimedName = (body?.name as string) || "User";

    // ---------- verify Firebase ID token (if configured) ----------
    let userUid = "anon";
    let userEmail = "user@example.com";
    let userRole: "tutor" | "student" = claimedRole; // fallback to claimed role unless we can prove otherwise

    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (adminReady && idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        userUid = decoded.uid || userUid;
        userEmail = decoded.email || userEmail;

        // pull role from Firestore if available, override claimedRole
        try {
          const snap = await admin
            .firestore()
            .collection("users")
            .doc(userUid)
            .get();
          if (snap.exists) {
            const data = snap.data() || {};
            const storedRole = data.role;
            if (storedRole === "tutor" || storedRole === "student") {
              userRole = storedRole;
            }
          }
        } catch (err) {
          // if Firestore fails, fall back to claimedRole in dev,
          // but in production we still at least have uid-based identity.
          console.warn("[token] firestore role lookup failed:", (err as Error).message);
        }
      } catch (e) {
        if (process.env.NODE_ENV === "production") {
          return json(401, { error: "Invalid auth token" });
        }
        console.warn(
          "[token] Firebase token verify failed, continuing (dev):",
          (e as Error).message
        );
        // dev mode: userUid may still be "anon"
      }
    } else if (process.env.NODE_ENV === "production") {
      // In prod, no adminReady or no idToken = reject.
      return json(401, { error: "Auth not configured" });
    }

    // ---------- LiveKit env ----------
    // NOTE: you had these named LIVEKIT_URL / etc.
    // In your .env.local you used LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
    // Let's support both so we don't break your setup.
    const lkUrl =
      process.env.LIVEKIT_URL ||
      process.env.LIVEKIT_WS_URL ||
      "";
    const lkKey = process.env.LIVEKIT_API_KEY;
    const lkSecret = process.env.LIVEKIT_API_SECRET;

    if (!lkUrl || !lkKey || !lkSecret) {
      return json(500, { error: "LiveKit env not configured" });
    }

    // ---------- identity construction ----------
    // We MUST guarantee uniqueness or LiveKit will kick the first student.
    //
    // Case A: we have a verified uid (not "anon")
    //   identity = `${userRole}-${userUid}`
    //
    // Case B: dev / anon
    //   identity = `${userRole}-anon-${randSuffix()}`
    //
    // This ensures two different browser sessions don't collide.
    let identity: string;
    if (userUid !== "anon") {
      identity = `${userRole}-${userUid}`;
    } else {
      identity = `${userRole}-anon-${randSuffix()}`;
    }

    // display name (what shows under the tile)
    // prefer: firestore/email or fallback
    const displayName =
      claimedName ||
      userEmail.split("@")[0] ||
      userRole ||
      "User";

    // ---------- build LiveKit access token ----------
    const at = new AccessToken(lkKey, lkSecret, {
      identity,
      name: displayName,
    });

    // allow them to join/publish/subscribe in ROOM_NAME
    at.addGrant({
      roomJoin: true,
      room: ROOM_NAME,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true, // allow DataChannel messages (floor / ack)
    });

    const token = await at.toJwt();

    // ---------- respond ----------
    return json(200, {
      token,
      url: lkUrl,
      roomName: ROOM_NAME,
      identity,
      role: userRole,
      name: displayName,
    });
  } catch (e: any) {
    console.error("[token] error:", e);
    return json(500, { error: e?.message || "Token creation failed" });
  }
}
