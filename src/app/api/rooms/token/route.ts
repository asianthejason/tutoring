// src/app/api/rooms/token/route.ts

// this route MUST run on node, not edge, because livekit-server-sdk uses Node crypto
export const runtime = "node";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin"; // you already have this from before
import { AccessToken } from "livekit-server-sdk";

// helper: assert required env vars exist
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

// tiny helper to pull bearer token off the request
function getBearerIdToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

// POST /api/rooms/token
export async function POST(req: NextRequest) {
  try {
    // 1. parse body (role + name + optional roomId from student)
    const body = await req.json().catch(() => ({}));
    const requestedRole = body.role as "tutor" | "student" | "admin" | undefined;
    const displayName = (body.name as string) || "user";
    const requestedRoomId = (body.roomId as string) || ""; // students pass tutor's roomId, tutors ignore

    // 2. verify caller's Firebase ID token
    const bearerIdToken = getBearerIdToken(req);
    if (!bearerIdToken) {
      return NextResponse.json({ error: "missing Authorization bearer token" }, { status: 401 });
    }

    const decoded = await getAuth().verifyIdToken(bearerIdToken).catch(() => null);
    if (!decoded || !decoded.uid) {
        return NextResponse.json({ error: "invalid Firebase token" }, { status: 401 });
    }
    const uid = decoded.uid;

    // 3. fetch this user's Firestore doc to get real role + roomId
    //    NOTE: adminDb is the *admin* Firestore instance from firebaseAdmin.ts
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: "user record not found" }, { status: 403 });
    }
    const userData = userSnap.data() || {};

    // actualRole is what we trust, NOT what the browser asked for
    const actualRole = (userData.role as "tutor" | "student" | "admin") || "student";

    // tutor's personal roomId lives on their user doc (like "tutor_<uid>")
    const tutorRoomIdFromDoc =
      typeof userData.roomId === "string" ? userData.roomId : "";

    // figure out which LiveKit room to join:
    // - tutors: always their own tutor roomId from Firestore
    // - students: what they passed in (the tutor room they're joining)
    // - admin: can pass in requestedRoomId too
    let resolvedRoomName = "";
    if (actualRole === "tutor") {
      if (!tutorRoomIdFromDoc) {
        return NextResponse.json(
          { error: "tutor has no roomId" },
          { status: 400 }
        );
      }
      resolvedRoomName = tutorRoomIdFromDoc;
    } else {
      // student or admin observer
      if (!requestedRoomId) {
        return NextResponse.json(
          { error: "roomId required for non-tutor" },
          { status: 400 }
        );
      }
      resolvedRoomName = requestedRoomId;
    }

    // sanity: make sure we aren't letting a student pretend to be tutor, etc.
    // we do NOT trust requestedRole. only actualRole from Firestore.
    // (You can add more logic here if you want to restrict admin/etc.)
    const livekitIdentity = `${actualRole}_${uid}`;

    // 4. build LiveKit server-side access token
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");

    // IMPORTANT: we ONLY expose string JWT to the client,
    // not the AccessToken object.
    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: displayName,
      // you can also set ttl, metadata, etc. if you want
    });

    // grant permissions depending on role
    // tutors: can publish and subscribe
    // students: can publish (mic/cam) and subscribe
    // admin: subscribe only (listen/watch)
    if (actualRole === "admin") {
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true, // they can still get whiteboard data
      });
    } else {
      // tutor or student
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
      });
    }

    // SIGN IT -> this is the JWT string LiveKit expects
    const jwt = await at.toJwt();

    // 5. return token + connection details back to browser
    //    the browser will pass this jwt as ?access_token=... on the ws URL
    return NextResponse.json({
      token: jwt,               // <-- FIX: string, not {}
      url: process.env.LIVEKIT_URL, // e.g. wss://your-livekit-domain.livekit.cloud
      roomName: resolvedRoomName,
      identity: livekitIdentity,
      role: actualRole,
      name: displayName,
    });
  } catch (err: any) {
    console.error("token route error:", err);
    return NextResponse.json(
      { error: err?.message || "internal error issuing token" },
      { status: 500 }
    );
  }
}
