// src/app/api/rooms/token/route.ts

// Force this route to run on Node.js (not Edge) so livekit-server-sdk works
export const runtime = "nodejs";

// Also force this route to run dynamically every time (no static caching)
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// ---------- helpers ----------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

function getBearerIdToken(req: NextRequest): string | null {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

// ---------- POST /api/rooms/token ----------
//
// Clients call this to get a LiveKit JWT to join a room.
// We do NOT trust client role. We:
//   1. Verify Firebase ID token
//   2. Look up that UID in Firestore "users/{uid}"
//   3. Use the role + roomId from Firestore to decide what room/permissions
//
// Behavior:
//   tutor  -> always forced into their own Firestore roomId
//   student/admin -> MUST provide ?roomId=<tutorRoomId> (in body) to join
//
// Response:
//   {
//     token: "<signed JWT string>",
//     url:   "wss://...livekit.cloud",
//     roomName: "<resolvedRoomName>",
//     identity: "<role_uid>",
//     role: "tutor" | "student" | "admin",
//     name: "<display name>"
//   }
//
export async function POST(req: NextRequest) {
  try {
    // 1. read request body
    const body = await req.json().catch(() => ({}));
    const requestedRoomId = (body.roomId as string) || "";
    const requestedName = (body.name as string) || "user";
    // NOTE: body.role is ignored (clients can lie)

    // 2. verify Firebase ID token from Authorization: Bearer <idToken>
    const idToken = getBearerIdToken(req);
    if (!idToken) {
      return NextResponse.json(
        { error: "missing Authorization bearer token" },
        { status: 401 }
      );
    }

    const decoded = await getAuth().verifyIdToken(idToken).catch(() => null);
    if (!decoded || !decoded.uid) {
      return NextResponse.json(
        { error: "invalid Firebase token" },
        { status: 401 }
      );
    }

    const uid = decoded.uid;

    // 3. look up this user in Firestore
    // we expect a doc at "users/{uid}" with { role, roomId? }
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json(
        { error: "user record not found" },
        { status: 403 }
      );
    }
    const userData = userSnap.data() || {};

    const actualRole =
      (userData.role as "tutor" | "student" | "admin") || "student";

    const tutorRoomIdFromDoc =
      typeof userData.roomId === "string" ? userData.roomId : "";

    // 4. pick which room this caller is allowed to join
    let resolvedRoomName = "";

    if (actualRole === "tutor") {
      // tutors ALWAYS go to their own roomId from Firestore
      if (!tutorRoomIdFromDoc) {
        return NextResponse.json(
          { error: "tutor has no roomId" },
          { status: 400 }
        );
      }
      resolvedRoomName = tutorRoomIdFromDoc;
    } else {
      // students & admin observers must supply the tutor's roomId in request
      if (!requestedRoomId) {
        return NextResponse.json(
          { error: "roomId required for non-tutor" },
          { status: 400 }
        );
      }
      resolvedRoomName = requestedRoomId;
    }

    // identity passed to LiveKit (what other participants see)
    // We prefix by role so tutors look like "tutor_<uid>" etc.
    const livekitIdentity = `${actualRole}_${uid}`;

    // 5. create a LiveKit AccessToken (server-signed JWT)
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");
    const lkUrl = requireEnv("LIVEKIT_URL"); // e.g. "wss://your-tenant.livekit.cloud"

    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: requestedName,
      // could also add metadata / ttl here if you want
    });

    // set publish/subscribe perms per role
    if (actualRole === "admin") {
      // admin = observer mode (can sub, can't publish mic/cam, can send data channel)
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      });
    } else {
      // tutor + student can publish mic/cam + data channel
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
      });
    }

    // sign into an actual JWT string
    const jwt = await at.toJwt();

    // 6. send back what the client needs to connect
    return NextResponse.json({
      token: jwt,
      url: lkUrl,
      roomName: resolvedRoomName,
      identity: livekitIdentity,
      role: actualRole,
      name: requestedName,
    });
  } catch (err: any) {
    console.error("token route error:", err);
    return NextResponse.json(
      { error: err?.message || "internal error issuing token" },
      { status: 500 }
    );
  }
}
