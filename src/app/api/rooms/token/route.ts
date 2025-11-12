// src/app/api/rooms/token/route.ts

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebaseAdmin";
import { AccessToken } from "livekit-server-sdk";

/* ========================= helpers ========================= */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function getBearerIdToken(req: NextRequest): string | null {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
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

type BookingDoc = {
  tutorUid?: string;
  tutorId?: string;
  studentUid?: string;
  studentId?: string;
  startTime?: any; // Timestamp | number | Date
  durationMin?: number;
};

const BOOKING_LOOKBACK_MINUTES = 180; // +/- 3h
const SESSION_GRACE_BEFORE_MIN = 15;
const SESSION_GRACE_AFTER_MIN = 15;

// Normalize "abc_1730000000000" → { id:"abc", startMsHint:173..., raw:"abc_..." }
function normalizeBookingKey(raw?: string | null): {
  id: string | null;
  startMsHint: number | null;
  raw: string | null;
} {
  if (!raw) return { id: null, startMsHint: null, raw: null };
  const [id, maybeMs] = String(raw).split("_");
  const ms = maybeMs ? Number(maybeMs) : NaN;
  return {
    id: id || null,
    startMsHint: Number.isFinite(ms) ? ms : null,
    raw,
  };
}

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

function tsToMillis(ts: any): number | null {
  try {
    if (ts == null) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return null;
  } catch {
    return null;
  }
}

async function getUserDoc(uid: string) {
  const snap = await adminDb.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return (snap.data() || {}) as UserDoc;
}

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

function bookingParties(b: BookingDoc): { tutorUid: string | null; studentUid: string | null } {
  // Accept both ...Uid and ...Id keys
  const tutor = (b.tutorUid || b.tutorId) ?? null;
  const student = (b.studentUid || b.studentId) ?? null;
  return { tutorUid: tutor || null, studentUid: student || null };
}

function bookingStartAndDuration(b: BookingDoc): { startMs: number | null; durationMin: number } {
  const startMs = tsToMillis(b.startTime);
  const durationMin = Number((b as any).durationMin || 0);
  return { startMs, durationMin };
}

async function hasActiveBookingForStudentAndTutor(
  studentUid: string,
  tutorUid: string,
  opts: { bookingId?: string | null; startMsHint?: number | null } = {}
) {
  const nowMs = Date.now();

  // 1) If bookingId provided, validate it strictly
  if (opts.bookingId) {
    const bSnap = await adminDb.collection("bookings").doc(opts.bookingId).get();
    if (bSnap.exists) {
      const b = (bSnap.data() || {}) as BookingDoc;
      const { tutorUid: tUID, studentUid: sUID } = bookingParties(b);
      if (tUID === tutorUid && sUID === studentUid) {
        const { startMs, durationMin } = bookingStartAndDuration(b);
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
    // If explicit bookingId is wrong or inactive, fall through to search.
  }

  // 2) Otherwise search around now
  const lowerBound = new Date(nowMs - minutes(BOOKING_LOOKBACK_MINUTES));
  const upperBound = new Date(nowMs + minutes(BOOKING_LOOKBACK_MINUTES));

  const q = await adminDb
    .collection("bookings")
    .where("tutorUid", "==", tutorUid)
    .where("studentUid", "==", studentUid)
    .where("startTime", ">=", lowerBound)
    .where("startTime", "<=", upperBound)
    .limit(20)
    .get();

  for (const doc of q.docs) {
    const b = (doc.data() || {}) as BookingDoc;
    const { startMs, durationMin } = bookingStartAndDuration(b);
    if (!startMs || durationMin <= 0) continue;

    // If we have a hint, require the start to be within +/- 2h of it (loose guard)
    if (opts.startMsHint) {
      const diff = Math.abs(startMs - opts.startMsHint);
      if (diff > minutes(120)) continue;
    }

    const ok = isNowWithinWindow(
      startMs,
      durationMin,
      nowMs,
      SESSION_GRACE_BEFORE_MIN,
      SESSION_GRACE_AFTER_MIN
    );
    if (ok) return true;
  }

  // If the data uses tutorId/studentId (not ...Uid), try the same query shape with those fields
  const q2 = await adminDb
    .collection("bookings")
    .where("tutorId", "==", tutorUid)
    .where("studentId", "==", studentUid)
    .where("startTime", ">=", lowerBound)
    .where("startTime", "<=", upperBound)
    .limit(20)
    .get();

  for (const doc of q2.docs) {
    const b = (doc.data() || {}) as BookingDoc;
    const { startMs, durationMin } = bookingStartAndDuration(b);
    if (!startMs || durationMin <= 0) continue;
    if (opts.startMsHint) {
      const diff = Math.abs(startMs - (opts.startMsHint as number));
      if (diff > minutes(120)) continue;
    }
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

/* ========================= handler ========================= */

export async function POST(req: NextRequest) {
  try {
    // 1) Read request
    const body = await req.json().catch(() => ({}));
    const requestedRoomId = (body.roomId as string) || "";
    const requestedName = (body.name as string) || "user";

    // booking normalization (accept "docId_1699..." but use "docId")
    const rawBookingKey: string | null = (body.bookingId as string) || null;
    const bookingStartHint: number | null =
      typeof body.bookingStartMs === "number" ? body.bookingStartMs : null;
    const normalized = normalizeBookingKey(rawBookingKey);
    const providedBookingId = normalized.id;
    const providedStartHint = bookingStartHint ?? normalized.startMsHint ?? null;
    // NOTE: body.role is ignored client-side; we derive role from Firestore

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
      return NextResponse.json({ error: "invalid Firebase token" }, { status: 401 });
    }
    const uid = decoded.uid;

    // 3) Fetch caller user doc
    const caller = await getUserDoc(uid);
    if (!caller) {
      return NextResponse.json({ error: "user record not found" }, { status: 403 });
    }
    const callerRole: Role = (caller.role as Role) || "student";
    const callerRoomId = typeof caller.roomId === "string" ? caller.roomId : "";

    // 4) Resolve the room & owning tutor
    let resolvedRoomName = "";
    let gateTutorUid: string | null = null;
    let gateTutorData: UserDoc | null = null;

    if (callerRole === "tutor") {
      if (!callerRoomId) {
        return NextResponse.json({ error: "tutor has no roomId" }, { status: 400 });
      }
      resolvedRoomName = callerRoomId;
      gateTutorUid = uid;
      gateTutorData = caller;
    } else {
      if (!requestedRoomId) {
        return NextResponse.json({ error: "roomId required for non-tutor" }, { status: 400 });
      }
      resolvedRoomName = requestedRoomId;
      const t = await findTutorByRoomId(requestedRoomId);
      if (!t) {
        return NextResponse.json({ error: "no tutor matches the requested roomId" }, { status: 404 });
      }
      gateTutorUid = t.tutorUid;
      gateTutorData = t.tutorData;
    }

    // 5) Gate logic: admins always allowed; students restricted in session mode
    if (callerRole !== "tutor") {
      const mode: RoomMode = gateTutorData?.roomMode;

      // Admins may always observe (mic/cam disabled by grant)
      if (callerRole !== "admin" && mode === "session") {
        // If tutor set a specific booking, prefer enforcing that ID
        const tutorsCurrent = gateTutorData?.currentBookingId || null;

        // If the tutor has pinned a booking ID and the client provided a different one, deny
        if (tutorsCurrent && providedBookingId && tutorsCurrent !== providedBookingId) {
          return NextResponse.json(
            {
              error:
                "This room is in a 1-on-1 session right now. Only the booked student may enter during the session window.",
              code: "SESSION_ACTIVE",
            },
            { status: 403 }
          );
        }

        // Determine which booking ID (if any) to validate directly
        const idToValidate = (tutorsCurrent || providedBookingId) ?? null;

        const ok = await hasActiveBookingForStudentAndTutor(uid, gateTutorUid as string, {
          bookingId: idToValidate,
          startMsHint: providedStartHint,
        });

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
      }
    }

    // 6) Create a LiveKit token
    const apiKey = requireEnv("LIVEKIT_API_KEY");
    const apiSecret = requireEnv("LIVEKIT_API_SECRET");
    const lkUrl = requireEnv("LIVEKIT_URL"); // e.g., wss://your-tenant.livekit.cloud

    const livekitIdentity = `${callerRole}_${uid}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: livekitIdentity,
      name: requestedName,
    });

    if (callerRole === "admin") {
      // observer: subscribe + data only
      at.addGrant({
        roomJoin: true,
        room: resolvedRoomName,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      });
    } else {
      // tutor + student may publish
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
      // Echo back the normalized bookingId if any
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
