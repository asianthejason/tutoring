// src/app/api/rooms/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb, ensureFirebaseAdmin } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// IMPORTANT: force Node runtime so we can use livekit-server-sdk safely
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Role = "tutor" | "student" | "admin";

function isTutorRole(r: string | undefined | null) {
  return r === "tutor";
}
function isStudentRole(r: string | undefined | null) {
  return r === "student";
}
function isAdminRole(r: string | undefined | null) {
  return r === "admin";
}

export async function POST(req: NextRequest) {
  try {
    await ensureFirebaseAdmin();

    // --- 1. auth check ---
    // Grab Firebase ID token from Authorization header
    const authHeader = req.headers.get("authorization") || "";
    const match = authHeader.match(/^Bearer (.+)$/i);
    const idToken = match?.[1];

    if (!idToken) {
      console.error("[/api/rooms/token] missing bearer token");
      return NextResponse.json(
        { error: "unauthenticated" },
        { status: 401 }
      );
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch (err) {
      console.error("[/api/rooms/token] verifyIdToken failed:", err);
      return NextResponse.json(
        { error: "invalid id token" },
        { status: 401 }
      );
    }

    const uid = decoded.uid;
    const email = decoded.email || "(no email)";
    console.log("[/api/rooms/token] caller uid/email:", uid, email);

    // --- 2. read request body ---
    const body = await req.json();
    const requestedRole = (body.role || "student") as Role;
    const requestedRoomId = String(body.roomId || "");
    const requestedName =
      typeof body.name === "string" && body.name.trim() !== ""
        ? body.name.trim()
        : "Student";

    if (!requestedRoomId) {
      console.error("[/api/rooms/token] missing roomId");
      return NextResponse.json(
        { error: "missing roomId" },
        { status: 400 }
      );
    }

    // --- 3. look up this user in Firestore to confirm real role + tutor room ---
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      console.error("[/api/rooms/token] user doc not found:", uid);
      return NextResponse.json(
        { error: "user profile missing" },
        { status: 403 }
      );
    }
    const userData = userSnap.data() || {};
    const dbRole = (userData.role || "student") as Role;
    const tutorRoomIdFromDb =
      typeof userData.roomId === "string" ? userData.roomId : "";

    console.log("[/api/rooms/token] dbRole:", dbRole);
    console.log("[/api/rooms/token] tutorRoomIdFromDb:", tutorRoomIdFromDb);
    console.log("[/api/rooms/token] requestedRoomId:", requestedRoomId);

    // --- 4. enforce access rules ---
    // tutor can ONLY join their own roomId from Firestore
    // student can ONLY join some tutor's room (passed as requestedRoomId)
    // admin can join any roomId
    let finalRole: Role = dbRole;
    if (isAdminRole(dbRole)) {
      finalRole = "admin";
    } else if (isTutorRole(dbRole)) {
      finalRole = "tutor";
    } else {
      finalRole = "student";
    }

    // pick the actual room this caller is allowed to join
    let finalRoomId = requestedRoomId;
    if (finalRole === "tutor") {
      if (!tutorRoomIdFromDb) {
        console.error("[/api/rooms/token] tutor missing roomId in db");
        return NextResponse.json(
          { error: "tutor roomId not set" },
          { status: 403 }
        );
      }
      if (tutorRoomIdFromDb !== requestedRoomId) {
        // student tried to spoof a different room? block.
        console.warn(
          "[/api/rooms/token] tutor attempted to join different room, forcing their own."
        );
      }
      finalRoomId = tutorRoomIdFromDb;
    } else if (finalRole === "student") {
      // students must NOT invent random rooms like "admin"
      // Just basic sanity: require that requestedRoomId starts with "tutor_"
      if (!requestedRoomId.toLowerCase().startsWith("tutor_")) {
        console.error(
          "[/api/rooms/token] student tried non-tutor room:",
          requestedRoomId
        );
        return NextResponse.json(
          { error: "forbidden room for student" },
          { status: 403 }
        );
      }
    } else if (finalRole === "admin") {
      // admin can go anywhere, we trust. keep finalRoomId as requestedRoomId
    }

    // --- 5. build identity string for LiveKit ---
    // we'll prefix by role so the front-end can tell who's who
    // e.g. tutor_abc123, student_something, admin_observer
    let identity = "";
    if (finalRole === "tutor") {
      identity = `tutor_${uid}`;
    } else if (finalRole === "student") {
      identity = `student_${uid}`;
    } else {
      identity = `admin_${uid}`;
    }

    // --- 6. sign LiveKit access token ---
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      console.error("[/api/rooms/token] LiveKit env missing", {
        hasKey: !!LIVEKIT_API_KEY,
        hasSecret: !!LIVEKIT_API_SECRET,
        hasUrl: !!LIVEKIT_URL,
      });
      return NextResponse.json(
        { error: "Server misconfigured (LiveKit env)" },
        { status: 500 }
      );
    }

    // create a token for THIS room only
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: requestedName,
      // ttl / metadata can go here if you want later
    });

    // grant publish/subscribe permissions based on role
    at.addGrant({
      room: finalRoomId,
      roomJoin: true,
      canPublish:
        finalRole === "tutor" || finalRole === "student" ? true : false,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    console.log("[/api/rooms/token] SUCCESS", {
      finalRole,
      identity,
      finalRoomId,
      livekitUrl: LIVEKIT_URL,
    });

    // --- 7. send data back to client ---
    return NextResponse.json(
      {
        token: jwt,
        url: LIVEKIT_URL, // front-end will append /<roomName>
        roomName: finalRoomId,
        identity,
        role: finalRole,
        name: requestedName,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[/api/rooms/token] UNCAUGHT ERROR:", err);
    return NextResponse.json(
      { error: err?.message || "server error" },
      { status: 500 }
    );
  }
}
