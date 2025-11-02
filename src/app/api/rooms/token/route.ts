// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

// Force Node runtime (admin SDK can't run on edge)
export const runtime = "nodejs";

// Single shared room for now
const ROOM_NAME = "default-classroom";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

// tiny random suffix for anonymous fallback (shouldn't really happen in prod)
function randSuffix(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

export async function POST(req: NextRequest) {
  try {
    // ----------- 1. Read request body -----------
    const body = await req.json().catch(() => ({}));

    // client sends what it *wants* to be called in the UI
    const claimedDisplayName = (body?.name as string) || "User";

    // client sends a role in the body, but we will override with Firestore role
    // after verifying auth. (For admins we later override permissions.)
    const claimedRole =
      (body?.role as "tutor" | "student" | "admin") || "student";

    // If admin is joining as silent observer they may also send forcedRoomId,
    // but right now we still just use ROOM_NAME. You can wire this later.
    // const forcedRoomId = body?.forcedRoomId as string | undefined;

    // ----------- 2. Auth header / Firebase verification -----------
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (!idToken) {
      // In production we REQUIRE a Firebase user so nobody random can mint tokens.
      if (process.env.NODE_ENV === "production") {
        return json(401, { error: "Auth not configured" });
      }
      // In dev we let anon fall through.
    }

    let uid = "anon";
    let userEmail = "user@example.com";
    let finalRole: "tutor" | "student" | "admin" = claimedRole;

    if (idToken) {
      try {
        // verify ID token with Admin SDK
        const decoded = await adminAuth.verifyIdToken(idToken);
        uid = decoded.uid || uid;
        userEmail = decoded.email || userEmail;

        // grab user doc for role
        const snap = await adminDb.collection("users").doc(uid).get();
        if (snap.exists) {
          const data = snap.data() || {};
          const storedRole = data.role;
          if (
            storedRole === "tutor" ||
            storedRole === "student" ||
            storedRole === "admin"
          ) {
            finalRole = storedRole;
          }
        }
      } catch (err: any) {
        // In production, fail hard if token is invalid
        if (process.env.NODE_ENV === "production") {
          return json(401, { error: "Invalid auth token" });
        }
        console.warn(
          "[/api/rooms/token] verifyIdToken failed (dev fallback):",
          err?.message
        );
      }
    }

    // If we're still "anon" in production, that's not allowed.
    if (process.env.NODE_ENV === "production" && uid === "anon") {
      return json(401, { error: "Auth not configured" });
    }

    // ----------- 3. LiveKit env vars -----------
    const livekitUrl =
      process.env.LIVEKIT_URL ||
      process.env.LIVEKIT_WS_URL || // fallback if you ever used a different name locally
      "";
    const livekitKey = process.env.LIVEKIT_API_KEY;
    const livekitSecret = process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !livekitKey || !livekitSecret) {
      return json(500, { error: "LiveKit env not configured" });
    }

    // ----------- 4. Build identity & display name -----------
    // identity must start with tutor_, student_, or observer_ so your
    // front-end helpers isTutorId/isStudentId/isObserverId work.
    //
    // We ALSO need uniqueness: if 2 students use same browser we don't want collisions.
    // We'll suffix anon, but stable UID in prod.
    let baseIdentityPrefix = "student";
    if (finalRole === "tutor") baseIdentityPrefix = "tutor";
    if (finalRole === "admin") baseIdentityPrefix = "observer";

    let identity: string;
    if (uid !== "anon") {
      identity = `${baseIdentityPrefix}_${uid}`;
    } else {
      identity = `${baseIdentityPrefix}_anon_${randSuffix()}`;
    }

    // name shown under the camera tile
    const displayName =
      claimedDisplayName ||
      (userEmail ? userEmail.split("@")[0] : "") ||
      finalRole ||
      "User";

    // ----------- 5. Build LiveKit access token -----------
    const at = new AccessToken(livekitKey, livekitSecret, {
      identity,
      name: displayName,
      // ttl can be added if you want, e.g. { ttl: 3600 }
    });

    // Permissions:
    // - tutor & student can publish mic/cam
    // - admin ("observer") cannot publish mic/cam, but can still subscribe
    // - everyone canPublishData so whiteboard sync works
    const canPublishAV = finalRole !== "admin";

    at.addGrant({
      roomJoin: true,
      room: ROOM_NAME,
      canPublish: canPublishAV,
      canSubscribe: true,
      canPublishData: true,
    });

    const lkToken = at.toJwt();

    // ----------- 6. Respond to client -----------
    return json(200, {
      token: lkToken,
      url: livekitUrl,
      roomName: ROOM_NAME,
      identity,
      role: finalRole,
      name: displayName,
    });
  } catch (err: any) {
    console.error("[/api/rooms/token] error:", err);
    return json(500, {
      error: err?.message || "Token creation failed",
    });
  }
}
