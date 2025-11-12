// src/app/api/rooms/token/route.ts

// Force this route to run on Node.js (not Edge) so livekit-server-sdk works
export const runtime = "nodejs";

// Also force this route to run dynamically every time (no static caching)
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

// ========================= helpers =========================

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

function minutes(n: number) {
  return n * 60 * 1000;
}

type Role = "tutor" | "student" | "admin";
type RoomMode = "homework" | "session" | undefined;

type UserDoc = {
  role?: Role;
  roomId?: string;
  roomMode?: RoomMode;
  currentBookingId?: string | null;
  displayName?: string;
};

// Compute whether now is within [start - beforeGrace, end + afterGrace]
function isNowWithinWindow(
  startMs: number,
  durationMin: number,
  nowMs: number,
  beforeGraceMin: number,
  afterGraceMin: number
) {
  const endMs = startMs + minutes(durationMin);
  const windowStart = startMs - minutes(beforeGraceMin);
  const windowEnd = endMs + minutes(afterGraceMin);
  return nowMs >= windowStart && nowMs <= windowEnd;
}

// Try to read a Firestore Timestamp-like object to millis
function tsToMillis(ts: any): number | null {
  try {
    if (!ts) return null;
    // firebase-admin Timestamp has toMillis()
    if (typeof ts.toMillis === "function") return ts.toMillis();
    // Fallbacks
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return null;
  } catch {
    return null;
  }
}

// ========================= core gate logic =========================

const BOOKING_LOOKBACK_MINUTES = 180; // search +/- 3h if bookingId not provided
const SESSION_GRACE_BEFORE_MIN = 15; // allow join up to 15 min early
const SESSION_GRACE_AFTER_MIN = 15; // allow linger up to 15 min after

async function findTutorByRoomId(roomId: string) {
  const q = await adminDb
    .collection("users")
    .where("role", "==", "tutor")
    .where("roomId", "==", roomId)
    .limit(1)
    .get();

  if (q.empty) return null;
  const doc = q.docs[0];
  const data = (doc.data() || {}) as UserDoc;
  return { tutorUid: doc.id, tutorData: data };
}

async function getUserDoc(uid: string) {
  const snap = await adminDb.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return (snap.data() || {}) as UserDoc;
}

async function hasActiveBookingForStudentAndTutor(
  studentUid: string,
  tutorUid: string,
  bookingIdFromBody?: string | null
) {
  const nowMs = Date.now();

  // 1) If bookingId provided, validate it strictly first
  if (bookingIdFromBody) {
    const bSnap = await adminDb.collection("bookings").doc(bookingIdFromBody).get();
    if (bSnap.exists) {
      const b = bSnap.data() || {};
      if (b.tutorUid === tutorUid && b.studentUid === studentUid) {
        const startMs = tsToMillis(b.startTime);
        const durationMin = Number(b.durationMin || 0);
        if (startMs && durationMin > 0) {
          const ok = isNowWithinWindow(
            startMs,
            durationMin,
            nowMs,
            SESSION_GRACE_BEFORE_MIN,
            SESSION_GRACE_AFTER_MIN
          );
          if (ok) return true;
        }
      }
    }
    // If explicit bookingId is wrong or not active, fall back to search below
  }

  // 2) Otherwise, search bookings in a small time window around now and check
  const lowerBound = new Date(nowMs - minutes(BOOKING_LOOKBACK_MINUTES));
  const upperBound = new Date(nowMs + minutes(BOOKING_LOOKBACK_MINUTES));

  // Firestore needs a single field for range; we range on startTime, then filter in memory.
  const q = await adminDb
    .collection("bookings")
    .where("tutorUid", "==", tutorUid)
    .where("studentUid", "==", studentUid)
    .where("startTime", ">=", lowerBound)
    .where("startTime", "<=", upperBound)
    .limit(20)
    .get();

  for (const doc of q.docs) {
    const b = doc.data() || {};
    const startMs = tsToMillis(b.startTime);
    const durationMin = Number(b.durationMin || 0);
    if (!startMs || durationMin <= 0) continue;

    const ok = isNowWithinWindow(
      startMs,
      durationMin,
      nowMs,
      SESSION_GRACE_BEFORE_MIN,
      SESSION_GRACE_AFTER_MIN
    );
    if (ok) return true;
  }

  return false;
}

// ========================= handler =========================

export async function POST(req: NextRequest) {
  try {
    // 1) Read request
    const body = await req.json().catch(() => ({}));
    const requestedRoomId = (body.roomId as string) || "";
    const requestedName = (body.name as string) || "user";
    const providedBookingId = (body.bookingId as string) || null;
    // NOTE: body.role is ignored (clients can lie)

    // 2) Verify Firebase ID token
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

    // 3) Fetch caller user doc
    const caller = await getUserDoc(uid);
    if (!caller) {
      return NextResponse.json({ error: "user record not found" }, { status: 403 });
    }
    const callerRole: Role = (caller.role as Role) || "student";
    const callerRoomId = typeof caller.roomId === "string" ? caller.roomId : "";

    // 4) Resolve room name the caller is requesting/allowed
    let resolvedRoomName = "";
    let gateTutorUid: string | null = null;
    let gateTutorData: UserDoc | null = null;

    if (callerRole === "tutor") {
      // Tutors always join their own room
      if (!callerRoomId) {
        return NextResponse.json({ error: "tutor has no roomId" }, { status: 400 });
      }
      resolvedRoomName = callerRoomId;
      // For completeness, set tutor gate to themselves
      gateTutorUid = uid;
      gateTutorData = caller;
    } else {
      // Students & admins must supply the tutor's roomId
      if (!requestedRoomId) {
        return NextResponse.json(
          { error: "roomId required for non-tutor" },
          { status: 400 }
        );
      }
      resolvedRoomName = requestedRoomId;

      // Find the tutor who owns this room
      const t = await findTutorByRoomId(requestedRoomId);
      if (!t) {
        return NextResponse.json(
          { error: "no tutor matches the requested roomId" },
          { status: 404 }
        );
      }
      gateTutorUid = t.tutorUid;
      gateTutorData = t.tutorData;
    }

    // 5) Access control for non-tutor roles based on tutor's roomMode
    if (callerRole !== "tutor") {
      const mode: RoomMode = gateTutorData?.roomMode;

      if (mode === "session") {
        // Only the booked student during active window is allowed
        const ok = await hasActiveBookingForStudentAndTutor(
          uid,
          gateTutorUid as string,
          providedBookingId
        );
        if (!ok) {
          return NextResponse.json(
            {
              error:
                "This room is in a 1-on-1 session right now. Only the booked student may enter during the session window.",
              code: "SESSION_ACTIVE",
            },
            { status: 403 }
          );
        }
      } else {
        // Default (homework help or undefined) → allow students & admins
        // If you want to block admins from publishing in homework mode, we do that via grant below.
      }
    }

    // 6) Create a LiveKit AccessToken
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");
    const lkUrl = requireEnv("LIVEKIT_URL"); // e.g. "wss://your-tenant.livekit.cloud"

    // Identity shown in LiveKit
    const livekitIdentity = `${callerRole}_${uid}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: requestedName,
      // You can set ttl, metadata, etc. here if desired
    });

    // Publishing/subscribing permissions by role
    if (callerRole === "admin") {
      // Admin = observer (no mic/cam), but can send data messages if needed
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      });
    } else {
      // Tutor + Student can publish mic/cam + data
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
      });
    }

    const jwt = await at.toJwt();

    // 7) Respond
    return NextResponse.json({
      token: jwt,
      url: lkUrl,
      roomName: resolvedRoomName,
      identity: livekitIdentity,
      role: callerRole,
      name: requestedName,
      // (optional) echo for clients that passed a bookingId
      bookingId: providedBookingId || undefined,
    });
  } catch (err: any) {
    console.error("token route error:", err);
    return NextResponse.json(
      { error: err?.message || "internal error issuing token" },
      { status: 500 }
    );
  }
}
