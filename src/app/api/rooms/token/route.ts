// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { ensureFirebaseAdmin, adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs"; // required so Vercel doesn't try to run this on edge

export async function POST(req: NextRequest) {
  try {
    // 1. make sure firebase-admin is initialized
    ensureFirebaseAdmin();

    // 2. verify Firebase ID token from Authorization header
    const authHeader = req.headers.get("authorization") || "";
    const m = authHeader.match(/^Bearer (.+)$/i);
    if (!m) {
      return NextResponse.json(
        { error: "missing bearer token" },
        { status: 401 }
      );
    }
    const idToken = m[1];
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // 3. read body from client
    const body = await req.json();
    const requestedRole = body.role;        // "tutor" / "student" / "admin" (claimed)
    const requestedRoomId = body.roomId;    // room the client wants to join
    const displayName = body.name || "User";

    if (!requestedRoomId) {
      return NextResponse.json(
        { error: "missing roomId" },
        { status: 400 }
      );
    }

    // 4. look up the real user doc in Firestore Admin
    const snap = await adminDb().collection("users").doc(uid).get();
    if (!snap.exists) {
      return NextResponse.json(
        { error: "user record not found" },
        { status: 403 }
      );
    }

    const userData = snap.data() || {};
    const actualRole = userData.role;           // trusted role
    const tutorRoomId = userData.roomId || "";  // tutor's own room if they are a tutor

    // 5. permission logic
    let finalRoomName = "";

    if (actualRole === "tutor") {
      // tutors can *only* join their assigned room
      if (!tutorRoomId) {
        return NextResponse.json(
          { error: "tutor missing roomId in Firestore" },
          { status: 403 }
        );
      }
      if (requestedRoomId !== tutorRoomId) {
        return NextResponse.json(
          { error: "tutor tried to join a different room" },
          { status: 403 }
        );
      }
      finalRoomName = tutorRoomId;
    } else if (actualRole === "admin") {
      // admins can spectate any room
      finalRoomName = requestedRoomId;
    } else {
      // students (or anything else) can request any tutor's room for now
      finalRoomName = requestedRoomId;
    }

    // 6. generate the LiveKit identity prefix:
    // this is what shows up in the room
    const livekitIdentity =
      actualRole === "tutor"
        ? `tutor_${uid}`
        : actualRole === "admin"
        ? `admin_${uid}`
        : `student_${uid}`;

    // 7. build the LiveKit JWT
    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const lkUrl = process.env.LIVEKIT_URL!; // e.g. wss://tutoring-web-jobakhvf.livekit.cloud

    if (!apiKey || !apiSecret || !lkUrl) {
      return NextResponse.json(
        { error: "LiveKit env vars missing" },
        { status: 500 }
      );
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: displayName,
    });

    at.addGrant({
      room: finalRoomName,
      roomJoin: true,
      canPublish: actualRole !== "admin", // admins observe only
      canSubscribe: true,
    });

    // THIS MUST BE A STRING
    const jwt = await at.toJwt();

    // 8. success response
    return NextResponse.json({
      token: jwt,              // <- string JWT, not an object
      url: lkUrl,              // <- wss://...
      roomName: finalRoomName, // <- "tutor_<uid>" etc.
      identity: livekitIdentity,
      role: actualRole,
      name: displayName,
    });
  } catch (err: any) {
    console.error("token route error", err);
    return NextResponse.json(
      { error: err?.message || "internal error" },
      { status: 500 }
    );
  }
}
