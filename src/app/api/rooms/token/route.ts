// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

/**
 * Firebase Admin init
 * We try env vars FIRST (Vercel), but fall back gracefully in dev.
 */
let adminReady = false;

function initFirebaseAdmin() {
  if (admin.apps.length) {
    adminReady = true;
    return;
  }

  try {
    // Option A: FIREBASE_SERVICE_ACCOUNT is a full JSON string
    const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (svcJson) {
      const creds = JSON.parse(svcJson);
      admin.initializeApp({
        credential: admin.credential.cert(
          creds as admin.ServiceAccount
        ),
      });
      adminReady = true;
      return;
    }

    // Option B: individual pieces
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

    // local dev without admin creds -> allow anon fallback
    adminReady = false;
  } catch {
    adminReady = false;
  }
}
initFirebaseAdmin();

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

// little util just to create a random suffix for anon guests
function randSuffix(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

export async function POST(req: NextRequest) {
  try {
    // ----- read body from client -----
    const body = await req.json().catch(() => ({}));

    // claimed role/name from the browser
    const claimedRole = (body?.role as "tutor" | "student" | "admin") || "student";
    const claimedName = (body?.name as string) || "User";

    // IMPORTANT: which LiveKit room are we trying to join?
    // We expect the client to send this.
    // Examples:
    //  tutor joins -> roomId === "tutor_<theirUID>"
    //  student joins -> same "tutor_<thatTutorUID>"
    //
    // If nothing comes in, we bail.
    const requestedRoomId =
      (body?.roomId as string) ||
      (body?.forcedRoomId as string) ||
      "";

    if (!requestedRoomId) {
      return json(400, { error: "Missing roomId" });
    }

    // ----- verify Firebase ID token, if possible -----
    let userUid = "anon";
    let userEmail = "user@example.com";
    // trustedRole is what we'll ACTUALLY use after validation
    let trustedRole: "tutor" | "student" | "admin" = claimedRole;

    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (adminReady && idToken) {
      try {
        // verify Firebase session
        const decoded = await admin.auth().verifyIdToken(idToken);
        userUid = decoded.uid || userUid;
        userEmail = decoded.email || userEmail;

        // read firestore user doc to get canonical role + roomId
        const snap = await admin.firestore().collection("users").doc(userUid).get();
        if (snap.exists) {
          const data = snap.data() || {};
          const storedRole = data.role;
          if (
            storedRole === "tutor" ||
            storedRole === "student" ||
            storedRole === "admin"
          ) {
            trustedRole = storedRole;
          }
        }
      } catch (err) {
        // If we can't verify in production, reject.
        if (process.env.NODE_ENV === "production") {
          return json(401, { error: "Invalid auth token" });
        }
        // In dev, we just fall back to anon.
        console.warn(
          "[token] Firebase verify failed (dev fallback):",
          (err as Error).message
        );
      }
    } else if (process.env.NODE_ENV === "production") {
      // prod and no adminReady/idToken? reject
      return json(401, { error: "Auth not configured" });
    }

    /**
     * SECURITY CHECKS:
     *
     * - Tutors: they should only ever join their OWN roomId (tutor_<theirUID>)
     * - Admin: can join any room (observer mode)
     * - Students: can join ANY tutor_<...> room, because that's how on-demand help works
     *
     * We'll enforce those rules because LiveKit tokens are basically root access
     * to that specific room.
     */

    if (trustedRole === "tutor") {
      // We expect requestedRoomId to look like tutor_<uid>
      // Make sure <uid> matches this authenticated tutor.
      const expectedPrefix = `tutor_${userUid}`;
      if (userUid !== "anon" && requestedRoomId !== expectedPrefix) {
        return json(403, {
          error: "Tutor cannot join another tutor's room",
        });
      }
    }

    if (trustedRole === "student") {
      // A student can only join tutor rooms (tutor_<something>)
      if (!requestedRoomId.startsWith("tutor_")) {
        return json(403, {
          error: "Students may only join tutor rooms",
        });
      }
    }

    // admin can observe any room, no extra restriction
    // (they connect as 'tutor' level for permissions, but we'll still tag identity separately)

    // ----- LiveKit env vars -----
    const lkUrl =
      process.env.LIVEKIT_URL ||
      process.env.LIVEKIT_WS_URL ||
      "";
    const lkKey = process.env.LIVEKIT_API_KEY;
    const lkSecret = process.env.LIVEKIT_API_SECRET;

    if (!lkUrl || !lkKey || !lkSecret) {
      return json(500, { error: "LiveKit env not configured" });
    }

    /**
     * IDENTITY RULES for LiveKit:
     *
     * We must give each participant a unique `identity` per room.
     *
     * We'll do:
     *  tutor -> "tutor_<uid>"
     *  admin -> "admin_<uid>"  (but with tutor-like grant perms)
     *  student -> "student_<uid>"  (or anon suffix if no uid)
     *
     * If no uid (dev anon), we suffix with random text so two tabs don't collide.
     */

    function buildIdentity(role: "tutor" | "student" | "admin") {
      const baseUid = userUid === "anon" ? `anon-${randSuffix()}` : userUid;
      return `${role}_${baseUid}`;
    }

    const identity = buildIdentity(trustedRole);

    // readable display name for tiles
    const displayName =
      claimedName ||
      userEmail.split("@")[0] ||
      trustedRole ||
      "User";

    // ----- CREATE THE LIVEKIT ACCESS TOKEN -----
    // Note: admin joins "read-only" in our UX, but from LiveKit POV it still
    // needs to be able to subscribe/publish data (whiteboard sync).
    //
    // We'll give everyone publish camera/mic for now; UI decides what they actually enable.
    const at = new AccessToken(lkKey, lkSecret, {
      identity,
      name: displayName,
    });

    at.addGrant({
      roomJoin: true,
      room: requestedRoomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    // Send back everything the browser needs.
    return json(200, {
      token,
      url: lkUrl,
      roomName: requestedRoomId,
      identity,
      role: trustedRole,
      name: displayName,
    });
  } catch (e: any) {
    console.error("[token] error:", e);
    return json(500, { error: e?.message || "Token creation failed" });
  }
}
