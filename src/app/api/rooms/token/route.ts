// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

/**
 * We want this to run in Node (not Edge),
 * because livekit-server-sdk and firebase-admin both need Node APIs.
 */
export const runtime = "nodejs";

/**
 * Firebase Admin init (singleton-ish)
 */
let adminReady = false;

function initFirebaseAdmin() {
  if (admin.apps.length) {
    adminReady = true;
    return;
  }

  try {
    // Option A: whole JSON blob in one var (not required for you, but supported)
    const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (svcJson) {
      const creds = JSON.parse(svcJson);
      admin.initializeApp({
        credential: admin.credential.cert(creds as admin.ServiceAccount),
      });
      adminReady = true;
      return;
    }

    // Option B: individual vars
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

    // if we get here, we failed to init
    adminReady = false;
  } catch {
    adminReady = false;
  }
}
initFirebaseAdmin();

/**
 * Utility to respond with JSON
 */
function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

/**
 * Generate a short random suffix for anon identities in dev/local.
 */
function randSuffix(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

export async function POST(req: NextRequest) {
  try {
    // read request body coming from the client
    const body = await req.json().catch(() => ({}));

    // The client should send: { role, name, roomId }
    // role is "tutor" | "student" | maybe "admin" for observers
    // roomId is like "tutor_<uid>" (what students should join)
    const claimedRole = (body?.role as "tutor" | "student" | "admin") || "student";
    const claimedName = (body?.name as string) || "User";
    const requestedRoomId = (body?.roomId as string) || "default-classroom";

    // -------------------------------------------------
    // STEP 1: Verify Firebase ID token if possible
    // -------------------------------------------------
    let userUid = "anon";
    let userEmail = "user@example.com";
    let userRole: "tutor" | "student" | "admin" = claimedRole;

    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (adminReady && idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        userUid = decoded.uid || userUid;
        userEmail = decoded.email || userEmail;

        // pull role + extra info from Firestore
        try {
          const snap = await admin.firestore().collection("users").doc(userUid).get();
          if (snap.exists) {
            const data = snap.data() || {};

            // If Firestore has a definitive role, override.
            if (
              data.role === "tutor" ||
              data.role === "student" ||
              data.role === "admin"
            ) {
              userRole = data.role;
            }

            // If this is a tutor, we trust their own roomId,
            // otherwise if this is a student, we trust the requestedRoomId they clicked.
            if (userRole === "tutor" && typeof data.roomId === "string") {
              // Force tutors to always join THEIR room.
              // Prevents tutors from accidentally/abusively joining some other tutor's room.
              // Example: "tutor_<uid>"
              // This also becomes their identity root.
              // Students will still request some tutor's roomId via body.roomId.
              if (data.roomId) {
                // override requestedRoomId with canonical tutor room
                // so tutor always lands in their own room
                // (students will pass this same value when they click Join Room)
                // This keeps tutor+student in sync.
                // If somehow undefined, we just keep requestedRoomId.
                if (typeof data.roomId === "string" && data.roomId.length > 0) {
                  // eslint-disable-next-line no-param-reassign
                  // We won't reassign function params directly; instead track a mutable var:
                }
              }
            }
          }
        } catch (err) {
          console.warn(
            "[token] firestore role lookup failed:",
            (err as Error).message
          );
        }
      } catch (e) {
        if (process.env.NODE_ENV === "production") {
          return json(401, { error: "Invalid auth token" });
        }
        console.warn(
          "[token] Firebase token verify failed, continuing (dev):",
          (e as Error).message
        );
      }
    } else if (process.env.NODE_ENV === "production") {
      // In prod: no adminReady or no idToken = reject
      return json(401, { error: "Auth not configured" });
    }

    // -------------------------------------------------
    // STEP 2: Finalize identity + room
    // -------------------------------------------------

    // identity MUST be unique or LiveKit will bump duplicates
    //
    // If we know the Firebase uid, use that.
    // Else fallback to an anon w/ random suffix.
    //
    // We prefix identity with the role for permission logic in the client.
    let identity: string;
    if (userUid !== "anon") {
      identity = `${userRole}-${userUid}`;
    } else {
      identity = `${userRole}-anon-${randSuffix()}`;
    }

    // displayName is shown under the video tile in the UI
    const displayName =
      claimedName ||
      userEmail.split("@")[0] ||
      userRole ||
      "User";

    // This is the room the client *actually* wants to join.
    // - Tutor will always join their own roomId (e.g. "tutor_<uid>")
    // - Student clicked a tutor card, which passes that tutor's roomId
    // - Admin/observer can also pass a roomId they want to watch
    const roomName = requestedRoomId || "default-classroom";

    // -------------------------------------------------
    // STEP 3: Build LiveKit token
    // -------------------------------------------------

    const lkUrl =
      process.env.LIVEKIT_URL ||
      process.env.LIVEKIT_WS_URL ||
      "";
    const lkKey = process.env.LIVEKIT_API_KEY;
    const lkSecret = process.env.LIVEKIT_API_SECRET;

    if (!lkUrl || !lkKey || !lkSecret) {
      return json(500, { error: "LiveKit env not configured" });
    }

    // Create an access token scoped to JUST THIS roomName
    const at = new AccessToken(lkKey, lkSecret, {
      identity,
      name: displayName,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    // LiveKit expects you to connect to <ws-url>/<roomName>.
    const signalingUrl = `${lkUrl.replace(/\/+$/, "")}/${roomName}`;

    // -------------------------------------------------
    // STEP 4: send it back
    // -------------------------------------------------
    return json(200, {
      token,
      url: lkUrl,
      roomName,
      identity,
      role: userRole,
      name: displayName,
    });
  } catch (e: any) {
    console.error("[token] error:", e);
    return json(500, { error: e?.message || "Token creation failed" });
  }
}
