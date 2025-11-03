// src/app/api/rooms/token/route.ts

// Force this route to run on Node.js (not Edge) so livekit-server-sdk works
export const runtime = "nodejs";

// Also force this route to run dynamically every time (no static caching)
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// --- helpers ---

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

// --- POST /api/rooms/token ---
export async function POST(req: NextRequest) {
  try {
    // 1. read request body
    const body = await req.json().catch(() => ({}));
    const requestedRoomId = (body.roomId as string) || "";
    const requestedName = (body.name as string) || "user";

    // We DO NOT trust body.role (client could lie)
    // We'll pull the real role from Firestore
    // const requestedRole = body.role; <-- ignore

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

    // 3. get this user's Firestore record
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json(
        { error: "user record not found" },
        { status: 403 }
      );
    }
    const userData = userSnap.data() || {};

    // real role we trust
    const actualRole =
      (userData.role as "tutor" | "student" | "admin") || "student";

    // tutor's personal roomId is stored in Firestore
    const tutorRoomIdFromDoc =
      typeof userData.roomId === "string" ? userData.roomId : "";

    // 4. decide which LiveKit room they are allowed to join
    let resolvedRoomName = "";
    if (actualRole === "tutor") {
      // tutors always join their own room
      if (!tutorRoomIdFromDoc) {
        return NextResponse.json(
          { error: "tutor has no roomId" },
          { status: 400 }
        );
      }
      resolvedRoomName = tutorRoomIdFromDoc;
    } else {
      // students & admin observers must specify which tutor room
      if (!requestedRoomId) {
        return NextResponse.json(
          { error: "roomId required for non-tutor" },
          { status: 400 }
        );
      }
      resolvedRoomName = requestedRoomId;
    }

    // identity we give to LiveKit (what other participants will see)
    const livekitIdentity = `${actualRole}_${uid}`;

    // 5. build LiveKit AccessToken (server-side signed JWT)
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");
    const lkUrl = requireEnv("LIVEKIT_URL"); // should be wss://tutoring-web-...livekit.cloud

    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: requestedName,
      // you can set ttl, metadata here if you want
    });

    // role-specific publish/subscribe permissions
    if (actualRole === "admin") {
      // observers: subscribe only, but can receive data channel
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      });
    } else {
      // tutor or student: can publish mic/cam, subscribe, send data channel
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
      });
    }

    // convert AccessToken object -> signed JWT string
    const jwt = await at.toJwt();

    // 6. return the data the browser needs
    return NextResponse.json({
      token: jwt, // THIS MUST BE A STRING, NOT {}
      url: lkUrl, // this becomes the base signaling URL
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
