// src/app/api/rooms/token/route.ts

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

/* ======================== helpers ======================== */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function getBearerIdToken(req: NextRequest): string | null {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

const minutes = (n: number) => n * 60 * 1000;

type Role = "tutor" | "student" | "admin";
type RoomMode = "homework" | "session" | undefined;

type UserDoc = {
  role?: Role;
  roomId?: string;
  roomMode?: RoomMode;
  currentBookingId?: string | null;
  displayName?: string;
};

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

// Read Firestore Timestamp/Date/number (ms) robustly
function tsToMillis(ts: any): number | null {
  try {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return null;
  } catch {
    return null;
  }
}

// Safe getter that accepts multiple candidate keys
const pick = (obj: any, keys: string[]) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
};

/* ======================== core gate ======================== */

const BOOKING_LOOKBACK_MINUTES = 180; // +/- 3h
const SESSION_GRACE_BEFORE_MIN = 15;
const SESSION_GRACE_AFTER_MIN = 15;

async function findTutorByRoomId(roomId: string) {
  const q = await adminDb
    .collection("users")
    .where("role", "==", "tutor")
    .where("roomId", "==", roomId)
    .limit(1)
    .get();

  if (q.empty) return null;
  const doc = q.docs[0];
  return { tutorUid: doc.id, tutorData: (doc.data() || {}) as UserDoc };
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

  // 1) If a bookingId is provided, validate it first (accept both ...Id and ...Uid field styles)
  if (bookingIdFromBody) {
    const bSnap = await adminDb.collection("bookings").doc(bookingIdFromBody).get();
    if (bSnap.exists) {
      const b = bSnap.data() || {};
      const bTutor = String(pick(b, ["tutorUid", "tutorId"]) || "");
      const bStudent = String(pick(b, ["studentUid", "studentId"]) || "");
      if (bTutor === tutorUid && bStudent === studentUid) {
        const startMs = tsToMillis(pick(b, ["startTime", "start", "startsAt"]));
        const durationMin = Number(pick(b, ["durationMin", "durationMinutes", "duration"]) || 0);
        if (startMs && durationMin > 0) {
          const ok = isNowWithinWindow(
            startMs,
            durationMin,
            nowMs,
            SESSION_GRACE_BEFORE_MIN,
            SESSION_GRACE_AFTER_MIN
          );
          if (ok) return { ok: true, matchedBookingId: bSnap.id, via: "explicitId" as const };
        }
      }
    }
    // else fall through to windowed search
  }

  // 2) Window search around "now" (requires composite index)
  const lowerBound = new Date(nowMs - minutes(BOOKING_LOOKBACK_MINUTES));
  const upperBound = new Date(nowMs + minutes(BOOKING_LOOKBACK_MINUTES));

  // Your schema seems to use tutorId/studentId; try both pairs by running two queries.
  // (Either one may hit depending on your data; whichever returns first with a match wins.)
  const queries = [
    adminDb
      .collection("bookings")
      .where("tutorUid", "==", tutorUid)
      .where("studentUid", "==", studentUid)
      .where("startTime", ">=", lowerBound)
      .where("startTime", "<=", upperBound)
      .limit(20)
      .get(),
    adminDb
      .collection("bookings")
      .where("tutorId", "==", tutorUid)
      .where("studentId", "==", studentUid)
      .where("startTime", ">=", lowerBound)
      .where("startTime", "<=", upperBound)
      .limit(20)
      .get(),
  ];

  for (const q of await Promise.all(queries)) {
    for (const doc of q.docs) {
      const b = doc.data() || {};
      const startMs = tsToMillis(pick(b, ["startTime", "start", "startsAt"]));
      const durationMin = Number(pick(b, ["durationMin", "durationMinutes", "duration"]) || 0);
      if (!startMs || durationMin <= 0) continue;

      const ok = isNowWithinWindow(
        startMs,
        durationMin,
        nowMs,
        SESSION_GRACE_BEFORE_MIN,
        SESSION_GRACE_AFTER_MIN
      );
      if (ok) return { ok: true, matchedBookingId: doc.id, via: "windowSearch" as const };
    }
  }

  return { ok: false as const };
}

/* ======================== handler ======================== */

export async function POST(req: NextRequest) {
  // we’ll fill this as we go and return it as serverDebug to help you validate
  const debug: Record<string, any> = {};

  try {
    // 1) Read request
    const body = await req.json().catch(() => ({}));
    const requestedRoomId = (body.roomId as string) || "";
    const requestedName = (body.name as string) || "user";
    const providedBookingIdRaw = (body.bookingId as string) || null;
    const providedBookingId =
      typeof providedBookingIdRaw === "string" && providedBookingIdRaw.includes("_")
        ? providedBookingIdRaw.split("_")[0] // tolerate "&bookingId=..._<startMs>" style URLs
        : providedBookingIdRaw;

    debug.request = {
      requestedRoomId,
      requestedName,
      providedBookingId,
      providedBookingIdRaw,
    };

    // 2) Verify Firebase ID token
    const idToken = getBearerIdToken(req);
    if (!idToken) {
      return NextResponse.json(
        { error: "missing Authorization bearer token", serverDebug: debug },
        { status: 401 }
      );
    }
    const decoded = await getAuth().verifyIdToken(idToken).catch(() => null);
    if (!decoded?.uid) {
      return NextResponse.json(
        { error: "invalid Firebase token", serverDebug: debug },
        { status: 401 }
      );
    }
    const uid = decoded.uid;
    debug.uid = uid;

    // 3) Fetch caller user doc
    const caller = await getUserDoc(uid);
    if (!caller) {
      return NextResponse.json(
        { error: "user record not found", serverDebug: debug },
        { status: 403 }
      );
    }
    const callerRole: Role = (caller.role as Role) || "student";
    const callerRoomId = typeof caller.roomId === "string" ? caller.roomId : "";
    debug.caller = { role: callerRole, roomId: callerRoomId };

    // 4) Resolve room and owning tutor
    let resolvedRoomName = "";
    let gateTutorUid: string | null = null;
    let gateTutorData: UserDoc | null = null;

    if (callerRole === "tutor") {
      if (!callerRoomId) {
        return NextResponse.json(
          { error: "tutor has no roomId", serverDebug: debug },
          { status: 400 }
        );
      }
      resolvedRoomName = callerRoomId;
      gateTutorUid = uid;
      gateTutorData = caller;
    } else {
      if (!requestedRoomId) {
        return NextResponse.json(
          { error: "roomId required for non-tutor", serverDebug: debug },
          { status: 400 }
        );
      }
      resolvedRoomName = requestedRoomId;
      const t = await findTutorByRoomId(requestedRoomId);
      if (!t) {
        return NextResponse.json(
          { error: "no tutor matches the requested roomId", serverDebug: debug },
          { status: 404 }
        );
      }
      gateTutorUid = t.tutorUid;
      gateTutorData = t.tutorData;
    }

    debug.room = {
      resolvedRoomName,
      gateTutorUid,
      tutorRoomMode: gateTutorData?.roomMode ?? null,
      tutorCurrentBookingId: gateTutorData?.currentBookingId ?? null,
    };

    // 5) Access control for non-tutors when tutor is in session mode
    if (callerRole !== "tutor") {
      const mode: RoomMode = gateTutorData?.roomMode;
      if (mode === "session") {
        const res = await hasActiveBookingForStudentAndTutor(
          uid,
          gateTutorUid as string,
          providedBookingId
        );
        debug.bookingCheck = res;

        if (!res.ok) {
          return NextResponse.json(
            {
              error:
                "This room is in a 1-on-1 session right now. Only the booked student may enter during the session window.",
              code: "SESSION_ACTIVE",
              serverDebug: debug,
            },
            { status: 403 }
          );
        }
      } else {
        debug.bookingCheck = { ok: true, skipped: true, reason: "not-in-session-mode" };
      }
    }

    // 6) Create LiveKit token
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");
    const lkUrl = requireEnv("LIVEKIT_URL");

    const livekitIdentity = `${callerRole}_${uid}`;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: requestedName,
    });

    if (callerRole === "admin") {
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      });
    } else {
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
      bookingId: providedBookingId || undefined,
      serverDebug: debug, // TEMPORARY: helps you verify the gating
    });
  } catch (err: any) {
    console.error("token route error:", err);
    return NextResponse.json(
      { error: err?.message || "internal error issuing token" },
      { status: 500 }
    );
  }
}
