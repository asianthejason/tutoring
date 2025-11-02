// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { ensureFirebaseAdmin, adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// Force this to be a fully dynamic Node function, no caching, no edge.
// This is CRITICAL for Vercel so it doesn't freeze an old version.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    // 1. Init firebase-admin (safe to call more than once)
    ensureFirebaseAdmin();

    // 2. Verify caller's Firebase ID token from Authorization header
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

    // 3. Get JSON body from client
    const body = await req.json();
    const requestedRole = body.role;      // what client *claims*: "tutor" | "student" | "admin"
    const requestedRoomId = body.roomId;  // which LiveKit room they want to join
    const displayName = body.name || "User";

    if (!requestedRoomId) {
      return NextResponse.json(
        { error: "missing roomId" },
        { status: 400 }
      );
    }

    // 4. Load the authoritative user record from Firestore (admin SDK)
    const userSnap = await adminDb().collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json(
        { error: "user record not found" },
        { status: 403 }
      );
    }

    const userData = userSnap.data() || {};
    const actualRole = userData.role;          // trusted role
    const tutorRoomId = userData.roomId || ""; // tutor's assigned room

    // 5. Enforce who can join what
    let finalRoomName = "";

    if (actualRole === "tutor") {
      // tutors: MUST join their own room
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
      // admins: can spectate any room
      finalRoomName = requestedRoomId;
    } else {
      // students (or anything else): can attempt to join tutor's roomId
      finalRoomName = requestedRoomId;
    }

    // 6. Build LiveKit identity that other peers see
    const livekitIdentity =
      actualRole === "tutor"
        ? `tutor_${uid}`
        : actualRole === "admin"
        ? `admin_${uid}`
        : `student_${uid}`;

    // 7. Sign a REAL JWT for LiveKit
    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const lkUrl = process.env.LIVEKIT_URL!; // e.g. wss://tutoring-web-jobakhvf.livekit.cloud

    if (!apiKey || !apiSecret || !lkUrl) {
      return NextResponse.json(
        { error: "LiveKit env vars missing" },
        { status: 500 }
      );
    }

    // AccessToken from livekit-server-sdk
    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: displayName,
    });

    at.addGrant({
      room: finalRoomName,
      roomJoin: true,
      canPublish: actualRole !== "admin", // admin is view-only
      canSubscribe: true,
    });

    // IMPORTANT: this must be a string, not an object
    const jwt = await at.toJwt();

    // 8. Return token + info back to the browser
    return NextResponse.json({
      token: jwt,              // <-- pure string now
      url: lkUrl,              // e.g. wss://tutoring-web-jobakhvf.livekit.cloud
      roomName: finalRoomName, // e.g. tutor_<uid>
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
