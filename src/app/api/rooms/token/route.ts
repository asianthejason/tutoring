// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb, ensureFirebaseAdmin } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// IMPORTANT: this must run in Node, not Edge
export const runtime = "nodejs";

// POST /api/rooms/token
export async function POST(req: NextRequest) {
  try {
    await ensureFirebaseAdmin(); // <-- make sure firebase-admin is initialized

    // 1. check Firebase ID token
    const authHeader = req.headers.get("authorization") || "";
    const match = authHeader.match(/^Bearer (.+)$/i);
    if (!match) {
      return NextResponse.json(
        { error: "missing bearer token" },
        { status: 401 }
      );
    }
    const idToken = match[1];
    const decoded = await getAuth().verifyIdToken(idToken);

    const uid = decoded.uid;
    // 2. read POST body
    const body = await req.json();
    const requestedRole = body.role;      // "tutor" | "student" | "admin" (from client)
    const requestedRoomId = body.roomId;  // what they think they should join
    const displayName = body.name || "User";

    if (!requestedRoomId) {
      return NextResponse.json(
        { error: "missing roomId" },
        { status: 400 }
      );
    }

    // 3. verify user in Firestore
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: "user record not found" }, { status: 403 });
    }
    const userData = userSnap.data() || {};
    const role = userData.role;      // actual role in DB
    const roomIdFromDb = userData.roomId; // tutor's true roomId

    // 4. permission logic:
    // tutors can ONLY join their own room
    // students/admin can join whatever roomId they passed in
    let finalRoomName = "";

    if (role === "tutor") {
      if (!roomIdFromDb) {
        return NextResponse.json(
          { error: "tutor missing roomId in Firestore" },
          { status: 403 }
        );
      }
      if (requestedRoomId !== roomIdFromDb) {
        return NextResponse.json(
          { error: "tutor tried to join a different room" },
          { status: 403 }
        );
      }
      finalRoomName = roomIdFromDb;
    } else if (role === "admin") {
      // admins can spectate any roomId
      finalRoomName = requestedRoomId;
    } else {
      // students can join whatever they request (for now)
      finalRoomName = requestedRoomId;
    }

    // 5. build LiveKit identity string used inside room
    // we prefix identity so the client can tell tutor vs student vs admin
    const livekitIdentity =
      role === "tutor"
        ? `tutor_${uid}`
        : role === "admin"
        ? `admin_${uid}`
        : `student_${uid}`;

    // 6. build access token
    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const lkUrl = process.env.LIVEKIT_URL!; // wss://...livekit.cloud

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
      canPublish: role !== "admin",      // admins can't publish
      canSubscribe: true,
      // You can add more restrictions here if you like
    });

    // --- THIS IS THE CRITICAL PART ---
    const jwt = await at.toJwt(); // <-- string JWT. NOT the object

    // 7. return to client
    return NextResponse.json({
      token: jwt,          // must be the string
      url: lkUrl,          // ex: wss://tutoring-web-jobakhvf.livekit.cloud
      roomName: finalRoomName,
      identity: livekitIdentity,
      role,
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
