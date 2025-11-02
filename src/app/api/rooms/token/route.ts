// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb, ensureFirebaseAdmin } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

//
// IMPORTANT: Next.js App Router API routes run on Edge by default in 16.x.
// livekit-server-sdk uses Node APIs -> force Node runtime.
//
export const runtime = "nodejs";

type Role = "tutor" | "student" | "admin";

// helper: read JSON body safely
async function readBody(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureFirebaseAdmin();

    const body = await readBody(req);
    const claimedRoleRaw = (body.role as string) || "";
    const displayNameRaw = (body.name as string) || "User";
    const requestedRoomId = (body.roomId as string) || "";

    if (!requestedRoomId) {
      return NextResponse.json(
        { error: "Missing roomId" },
        { status: 400 }
      );
    }

    // verify Firebase auth token from client
    const authHeader = req.headers.get("authorization") || "";
    const match = authHeader.match(/^Bearer (.+)$/i);
    const idToken = match ? match[1] : null;
    if (!idToken) {
      return NextResponse.json(
        { error: "Missing Firebase ID token" },
        { status: 401 }
      );
    }

    const decoded = await getAuth().verifyIdToken(idToken, true).catch(() => null);
    if (!decoded || !decoded.uid) {
      return NextResponse.json(
        { error: "Invalid Firebase ID token" },
        { status: 401 }
      );
    }

    const uid = decoded.uid;

    // look up this user in Firestore admin side
    const userSnap = await adminDb()
      .collection("users")
      .doc(uid)
      .get();

    if (!userSnap.exists) {
      return NextResponse.json(
        { error: "No Firestore user doc for this uid" },
        { status: 403 }
      );
    }

    const userData = userSnap.data() || {};
    const trueRole: Role =
      userData.role === "tutor"
        ? "tutor"
        : userData.role === "admin"
        ? "admin"
        : "student";

    // enforce that client cannot lie about role
    if (claimedRoleRaw && claimedRoleRaw !== trueRole) {
      return NextResponse.json(
        { error: "Role mismatch" },
        { status: 403 }
      );
    }

    // figure out what room they're ALLOWED to join
    // tutors: only their own personal roomId
    // students & admins: whatever ?roomId they passed in
    let allowedRoomId = requestedRoomId;

    if (trueRole === "tutor") {
      const tutorRoomIdFromDoc = typeof userData.roomId === "string" ? userData.roomId : "";
      if (!tutorRoomIdFromDoc) {
        return NextResponse.json(
          { error: "Tutor has no roomId on record" },
          { status: 403 }
        );
      }
      if (tutorRoomIdFromDoc !== requestedRoomId) {
        return NextResponse.json(
          { error: "Tutor trying to join a different room" },
          { status: 403 }
        );
      }

      allowedRoomId = tutorRoomIdFromDoc;
    }

    // build LiveKit identity
    // MUST be stable and unique inside the room
    // tutor_xxx..., student_xxx..., admin_xxx...
    let lkIdentity = "";
    if (trueRole === "tutor") {
      lkIdentity = `tutor_${uid}`;
    } else if (trueRole === "admin") {
      lkIdentity = `admin_${uid}`;
    } else {
      // student
      lkIdentity = `student_${uid}`;
    }

    // OPTIONAL nice display name
    const lkName =
      userData.displayName ||
      displayNameRaw ||
      (trueRole === "tutor" ? "Tutor" : "Student");

    // mint LiveKit server token
    // we require LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL in env
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const lkUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !lkUrl) {
      return NextResponse.json(
        { error: "LiveKit env vars missing" },
        { status: 500 }
      );
    }

    // create access token scoped to this room
    const at = new AccessToken(apiKey, apiSecret, {
      identity: lkIdentity,
      name: lkName,
    });

    // permissions:
    // - tutor: can publish & subscribe
    // - student: can publish (cam/mic) & subscribe
    // - admin: subscribe only, no publish
    if (trueRole === "admin") {
      at.addGrant({
        roomJoin: true,
        room: allowedRoomId,
        canPublish: false,
        canSubscribe: true,
      });
    } else {
      at.addGrant({
        roomJoin: true,
        room: allowedRoomId,
        canPublish: true,
        canSubscribe: true,
      });
    }

    const jwt = await at.toJwt();

    // Return info the client needs to connect:
    // client will connect to `${lkUrl}/${allowedRoomId}`
    // and pass `jwt` as the access token.
    return NextResponse.json(
      {
        token: jwt,
        url: lkUrl,
        roomName: allowedRoomId,
        identity: lkIdentity,
        role: trueRole,
        name: lkName,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[/api/rooms/token] ERROR", err);
    return NextResponse.json(
      { error: err?.message || "internal error" },
      { status: 500 }
    );
  }
}
