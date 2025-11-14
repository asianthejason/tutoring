// src/app/room/page.tsx
"use client";

import { useEffect, useRef, useState, useCallback, Fragment } from "react";
import {
  Room,
  RoomEvent,
  RemoteTrackPublication,
  LocalTrackPublication,
  Track,
  Participant,
  LocalParticipant,
} from "livekit-client";
import { useRouter } from "next/navigation";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  getDocs,
  query as fsQuery,
  where,
  orderBy,
  limit as fsLimit,
} from "firebase/firestore";

/* ===================== Types ===================== */
type Role = "tutor" | "student" | "admin";
type RoomMode = "homework" | "session";

type TokenResp = {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  role: Role;
  name: string;
  bookingId?: string;
};

type StrokePoint = { x: number; y: number };
type Stroke = { color: string; size: number; points: StrokePoint[] };

type SessionDoc = {
  roomId: string;
  active: boolean;
  tutorUid: string;
  tutorName?: string;
  tutorEmail?: string;
  students: { id: string; name: string }[];
  studentsCount: number;
  startedAt: number;
  updatedAt: number;
};

type ResolveResult = {
  ok: boolean;
  roomId: string | null;
  reason?: string;
  details?: any;
};

/* ===================== Debug helpers ===================== */
type DebugSlice = { t: string; tag: string; data?: any };
const nowIso = () => new Date().toISOString();
function safeJson(v: any) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

/* ===================== Utils ===================== */
function qp(name: string, fallback?: string) {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}
const isStudentId = (id?: string | null) => !!id && id.toLowerCase().startsWith("student");
const isTutorId = (id?: string | null) => !!id && id.toLowerCase().startsWith("tutor");
const isObserverId = (id?: string | null) => !!id && id.toLowerCase().startsWith("admin");

// Normalize booking key like "docId_1730000000000" → { id:"docId", startMsHint:173..., raw:"..." }
function parseBookingKey(raw?: string | null) {
  if (!raw) return { id: null as string | null, startMsHint: null as number | null, raw: "" };
  const [id, maybeMs] = String(raw).split("_");
  const ms = maybeMs ? Number(maybeMs) : null;
  return { id: id || null, startMsHint: Number.isFinite(ms) ? (ms as number) : null, raw };
}

/* ===================== Presence helpers ===================== */
async function setTutorStatus(uid: string, status: "offline" | "waiting" | "busy") {
  try {
    await setDoc(
      doc(db, "users", uid),
      { status, statusUpdatedAt: Date.now(), lastActiveAt: Date.now() },
      { merge: true }
    );
  } catch {}
}

async function writeRoomMode(
  uid: string,
  mode: RoomMode | null,
  currentBookingId?: string | null
) {
  const patch: Record<string, any> = {
    roomMode: mode ?? null,
    lastActiveAt: Date.now(),
  };
  if (typeof currentBookingId !== "undefined") {
    patch.currentBookingId = currentBookingId;
  }
  try {
    await setDoc(doc(db, "users", uid), patch, { merge: true });
  } catch {}
}

/* ===================== booking → room resolver ===================== */
// Try several lookup strategies so we survive different booking doc ID schemes.
async function fetchBookingDocByAnyKey(
  normalizedId: string,
  startMsHint: number | null,
  rawKey: string | null,
  dbg: (tag: string, data?: any) => void
) {
  // 1) Direct normalized ID
  if (normalizedId) {
    const snap = await getDoc(doc(db, "bookings", normalizedId));
    if (snap.exists()) {
      dbg("resolver:booking-hit:normalized", { id: normalizedId });
      return snap;
    }
  }

  // 2) Normalized + "_" + startMsHint
  if (normalizedId && startMsHint) {
    const composed = `${normalizedId}_${startMsHint}`;
    const snap = await getDoc(doc(db, "bookings", composed));
    if (snap.exists()) {
      dbg("resolver:booking-hit:normalized_with_start", { id: composed });
      return snap;
    }
  }

  // 3) Raw key as doc id
  if (rawKey) {
    const snap = await getDoc(doc(db, "bookings", rawKey));
    if (snap.exists()) {
      dbg("resolver:booking-hit:raw", { id: rawKey });
      return snap;
    }
  }

  // 4) Query by normalizedId field (prefer latest startTime)
  if (normalizedId) {
    try {
      const q = fsQuery(
        collection(db, "bookings"),
        where("normalizedId", "==", normalizedId),
        orderBy("startTime", "desc"),
        fsLimit(1)
      );
      const qs = await getDocs(q);
      if (!qs.empty) {
        const found = qs.docs[0];
        dbg("resolver:booking-hit:query_normalizedId", { id: found.id });
        return found;
      }
    } catch (e) {
      dbg("resolver:booking-query-error", String((e as any)?.message || e));
    }
  }

  return null;
}

async function resolveRoomIdFromBooking(
  bookingIdNormalized: string,
  dbg: (tag: string, data?: any) => void
): Promise<ResolveResult> {
  try {
    dbg("resolver:start", { bookingIdNormalized });

    const raw = qp("bookingId", "") || null;
    const parsed = parseBookingKey(raw);
    const bSnap =
      (await fetchBookingDocByAnyKey(bookingIdNormalized, parsed.startMsHint, raw, dbg)) || null;

    if (!bSnap) {
      dbg("resolver:no-booking");
      return { ok: false, roomId: null, reason: "booking_not_found" };
    }
    const b = bSnap.data() as any;
    dbg("resolver:bookingDoc", { id: bSnap.id, ...b });

    const me = auth.currentUser;
    if (!me) {
      dbg("resolver:not-signed-in");
      return { ok: false, roomId: null, reason: "not_signed_in" };
    }

    // role & identity sanity
    const meDoc = await getDoc(doc(db, "users", me.uid));
    const myRole = (meDoc.data()?.role as Role | undefined) ?? "student";
    const meDisplayName =
      (typeof meDoc.data()?.displayName === "string" && meDoc.data()?.displayName) ||
      (me.email ? me.email.split("@")[0] : me.uid);
    dbg("resolver:user", { uid: me.uid, role: myRole, email: me.email, displayName: meDisplayName });

    // Student-of-record check (admins skip)
    if (myRole !== "admin" && b.studentId && b.studentId !== me.uid) {
      dbg("resolver:student-mismatch", { bookingStudentId: b.studentId, me: me.uid });
      return {
        ok: false,
        roomId: null,
        reason: "student_mismatch",
        details: { bookingStudentId: b.studentId, me: me.uid },
      };
    }

    // time window check (±15 min grace; defaults to 60 min if no duration)
    const startMs: number =
      typeof b.startTime === "number" ? b.startTime : b.startTime?.toMillis?.() ?? 0;
    const durMin: number = Number(b.durationMin || 60);
    const now = Date.now();
    const openFrom = startMs - 15 * 60_000;
    const openUntil = startMs + durMin * 60_000 + 15 * 60_000;
    const withinWindow = startMs && now >= openFrom && now <= openUntil;

    dbg("resolver:time-window", {
      startMs,
      durMin,
      now,
      openFrom,
      openUntil,
      withinWindow,
      startLocal: startMs ? new Date(startMs).toString() : null,
      nowLocal: new Date(now).toString(),
      openFromLocal: new Date(openFrom).toString(),
      openUntilLocal: new Date(openUntil).toString(),
    });

    if (!withinWindow) {
      return {
        ok: false,
        roomId: null,
        reason: "session_not_live",
        details: { startMs, durMin, now, openFrom, openUntil },
      };
    }

    // fetch tutor's roomId
    const tutorId: string = String(b.tutorId || "");
    if (!tutorId) {
      dbg("resolver:no-tutor");
      return { ok: false, roomId: null, reason: "tutor_missing" };
    }
    const tSnap = await getDoc(doc(db, "users", tutorId));
    const roomId = (tSnap.exists() && (tSnap.data() as any).roomId) || "";
    dbg("resolver:tutorDoc", { tutorId, tutorHasRoomId: !!roomId, roomId });

    if (!roomId) {
      return { ok: false, roomId: null, reason: "tutor_no_roomid" };
    }
    return { ok: true, roomId, details: { tutorId, bookingDocId: bSnap.id } };
  } catch (e: any) {
    console.error("[resolveRoomIdFromBooking]", e);
    return { ok: false, roomId: null, reason: "exception", details: String(e?.message || e) };
  }
}

/* ===================== Component ===================== */
export default function RoomPage() {
  const router = useRouter();

  /* ---------- Debug state ---------- */
  const [debugOpen, setDebugOpen] = useState(() => (qp("debug", "") ? true : false));
  const [debug, setDebug] = useState<DebugSlice[]>([]);
  const debugRef = useRef<DebugSlice[]>([]);
  const pushDebug = (tag: string, data?: any) => {
    const slice: DebugSlice = { t: nowIso(), tag, data: safeJson(data) };
    debugRef.current = [...debugRef.current, slice];
    setDebug(debugRef.current);
    // eslint-disable-next-line no-console
    console.log(`[room dbg] ${slice.t} :: ${tag}`, slice.data);
  };

  /* ---------- AUTH / ROLE ---------- */
  const [authed, setAuthed] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [lockedRole, setLockedRole] = useState<Role | null>(null);
  const [profileName, setProfileName] = useState<string>("");

  const [sessionRoomId, setSessionRoomId] = useState<string>("");

  // Query params
  const modeFromQP = (qp("mode", "") || "").toLowerCase() as RoomMode | "";
  const rawBookingKey = qp("bookingId", "") || "";
  const bookingKey = parseBookingKey(rawBookingKey);
  const nameFromQP = qp("name", "");

  /* ---------- BASIC UI ---------- */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [status, setStatus] = useState("Joining…");
  const [error, setError] = useState<string | null>(null);

  const [myIdentity, setMyIdentity] = useState<string>("");
  const myIdRef = useRef<string>("");

  // roster
  const [students, setStudents] = useState<{ id: string; name: string }[]>([]);

  // tiles
  const [tiles, setTiles] = useState<
    {
      id: string;
      name: string;
      isLocal: boolean;
      pub: RemoteTrackPublication | LocalTrackPublication | null;
      pid: string;
      placeholder?: boolean;
    }[]
  >([]);
  const [orderedTiles, setOrderedTiles] = useState<typeof tiles>([]);
  const [tileSize, setTileSize] = useState<{ w: number; h: number }>({ w: 360, h: 270 });

  const [activeSpeakers, setActiveSpeakers] = useState<Set<string>>(new Set());
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);

  const [iCanHearTutor, setICanHearTutor] = useState<boolean | null>(null);
  const [canHearTutor, setCanHearTutor] = useState<Record<string, boolean>>({});
  const [canSpeakToTutor, setCanSpeakToTutor] = useState<Record<string, boolean>>({});
  const hearMapRef = useRef<Record<string, boolean>>({});
  const speakMapRef = useRef<Record<string, boolean>>({});
  const [permVersion, setPermVersion] = useState(0);
  const pendingTutorSubsRef = useRef<Record<string, boolean>>({});

  const mainRef = useRef<HTMLElement>(null);
  const videoColumnRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);

  const tutorAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const studentAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  /* ---------- WHITEBOARD ---------- */
  const [boards, setBoards] = useState<Record<string, Stroke[]>>({});
  const boardsRef = useRef<Record<string, Stroke[]>>({});
  const [viewBoardFor, setViewBoardFor] = useState<string>("");
  const viewBoardForRef = useRef<string>("");
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [strokeColor, setStrokeColor] = useState<string>("#ffffff");
  const [strokeSize, setStrokeSize] = useState<number>(3);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wbContainerRef = useRef<HTMLDivElement>(null);

  /* ---------- NAV STATUS PILL (tutor) ---------- */
  const [navStatus, setNavStatus] = useState<"offline" | "waiting" | "busy" | null>(null);
  const statusLabel = (s: "offline" | "waiting" | "busy") =>
    s === "waiting" ? "Waiting" : s === "busy" ? "Busy" : "Offline";
  const statusPillStyle = (s: "offline" | "waiting" | "busy"): React.CSSProperties => {
    const base: React.CSSProperties = {
      padding: "6px 10px",
      borderRadius: 999,
      fontSize: 12,
      lineHeight: 1,
      fontWeight: 600,
      border: "1px solid",
      userSelect: "none",
      alignSelf: "center",
    };
    if (s === "busy") return { ...base, color: "#fff", background: "#b22", borderColor: "#e88" };
    if (s === "waiting") return { ...base, color: "#231", background: "#f6d58b", borderColor: "#f2c04b" };
    return { ...base, color: "#ddd", background: "#2a2a2a", borderColor: "#555" };
  };

  useEffect(() => {
    viewBoardForRef.current = viewBoardFor;
  }, [viewBoardFor]);

  /* ---------- AUTH + profile name + room id ---------- */
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/auth?from=/room");
        return;
      }
      setAuthed(true);
      setUserEmail(user.email ?? null);

      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.exists() ? snap.data() : null;

      const r = (data?.role as Role) || "student";
      setLockedRole(r);

      const displayName =
        (typeof data?.displayName === "string" && data.displayName.trim()) ||
        (user.email ? user.email.split("@")[0] : "") ||
        (r === "tutor" ? "Tutor" : "Student");

      setProfileName(nameFromQP && nameFromQP.trim() ? nameFromQP.trim() : displayName);

      const tutorRoomIdFromDoc = typeof data?.roomId === "string" ? data.roomId : "";
      const qpRoom = qp("roomId", "") || "";

      pushDebug("auth", {
        uid: user.uid,
        email: user.email,
        role: r,
        displayName,
        qp: { roomId: qpRoom, mode: modeFromQP, rawBookingKey, normalizedBookingId: bookingKey.id },
        userDocRoomId: tutorRoomIdFromDoc,
      });

      if (r === "tutor" && tutorRoomIdFromDoc) setSessionRoomId(tutorRoomIdFromDoc);
      else setSessionRoomId(qpRoom);
    });
    return unsub;
  }, [router, nameFromQP, modeFromQP, rawBookingKey]);

  useEffect(() => {
    if (!sessionRoomId) {
      const qpRoom = qp("roomId", "") || "";
      if (qpRoom) setSessionRoomId(qpRoom);
    }
  }, [sessionRoomId]);

  // Student resolving bookingId → roomId
  useEffect(() => {
    (async () => {
      if (!authed) return;
      if (lockedRole !== "student") return; // <-- key change: only students run resolver
      if (sessionRoomId) return;
      if (modeFromQP !== "session") return;
      if (!bookingKey.id) return;

      setStatus("Resolving your session room…");
      setError(null);

      const res = await resolveRoomIdFromBooking(bookingKey.id, pushDebug);
      pushDebug("resolver:result", res);

      if (res.ok && res.roomId) {
        setSessionRoomId(res.roomId);
      } else {
        const msg =
          res.reason === "student_mismatch"
            ? "This booking belongs to a different student account."
            : res.reason === "session_not_live"
            ? "This session isn’t live yet (or it’s over)."
            : res.reason === "tutor_no_roomid"
            ? "Tutor has no room link configured."
            : res.reason === "booking_not_found"
            ? "Booking can’t be found."
            : "This session isn’t live yet or the booking can’t be found.";
        setError(msg);
      }
    })();
  }, [authed, lockedRole, sessionRoomId, modeFromQP, bookingKey.id]);

  // Live status pill for tutors
  useEffect(() => {
    if (!authed || lockedRole !== "tutor") {
      setNavStatus(null);
      return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const unsub = onSnapshot(doc(db, "users", uid), (snap) => {
      const s = (snap.data()?.status as "offline" | "waiting" | "busy" | undefined) ?? null;
      setNavStatus(s);
    });
    return unsub;
  }, [authed, lockedRole]);

  /* ===================== Whiteboard helpers ===================== */
  const redrawCanvas = (strokes?: Stroke[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    (strokes || []).forEach((s) => {
      if (!s.points.length) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const first = s.points[0];
      ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i];
        ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      }
      ctx.stroke();
    });
  };

  const ensureBoard = (pid: string) => {
    if (!boardsRef.current[pid]) {
      boardsRef.current[pid] = [];
      setBoards((prev) => ({ ...prev, [pid]: boardsRef.current[pid] }));
    }
  };

  const appendStroke = (authorId: string, stroke: Stroke) => {
    ensureBoard(authorId);
    const updated = [...(boardsRef.current[authorId] || []), stroke];
    boardsRef.current[authorId] = updated;
    setBoards((prev) => ({ ...prev, [authorId]: updated }));
    if (authorId === viewBoardForRef.current) redrawCanvas(updated);
  };

  const replaceBoard = (authorId: string, strokes: Stroke[]) => {
    boardsRef.current[authorId] = strokes.slice();
    setBoards((p) => ({ ...p, [authorId]: strokes.slice() }));
    if (authorId === viewBoardForRef.current) redrawCanvas(strokes);
  };

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const holder = wbContainerRef.current;
    if (!canvas || !holder) return;
    const rect = holder.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    const curId = viewBoardForRef.current;
    redrawCanvas(boardsRef.current[curId] || []);
  }, []);

  useEffect(() => {
    resizeCanvas();
  }, [viewBoardFor, resizeCanvas]);
  useEffect(() => {
    function onWinResize() {
      resizeCanvas();
    }
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [resizeCanvas]);

  const canCurrentUserEditBoard = () => {
    const me = myIdRef.current;
    const target = viewBoardForRef.current;
    if (!me || !target || !lockedRole) return false;
    if (lockedRole === "admin") return false;
    if (lockedRole === "tutor") return true;
    if (lockedRole === "student") return me === target;
    return false;
  };

  function computeStudentHearing(meId: string) {
    return !!hearMapRef.current[meId];
  }
  function computeTutorHearingStudent(studId: string) {
    return !!speakMapRef.current[studId];
  }
  function killStudentAudioLocally() {
    if (lockedRole !== "student") return;
    [tutorAudioElsRef.current, studentAudioElsRef.current].forEach((map) => {
      for (const [, el] of map.entries()) {
        if (el) {
          el.pause();
          el.remove();
        }
      }
      map.clear();
    });
  }

  function syncLocalAVFlags(lp: LocalParticipant | undefined) {
    if (!lp) return;
    const micEnabled = Array.from(lp.audioTrackPublications.values()).some((pub) => pub.isEnabled && pub.track);
    const camEnabled = Array.from(lp.videoTrackPublications.values()).some((pub) => pub.isEnabled && pub.track);
    setMicOn(micEnabled);
    setCamOn(camEnabled);
  }

  async function ensureLocalMediaPermission(kind: "camera" | "mic" | "both"): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const constraints: MediaStreamConstraints =
      kind === "camera" ? { video: true } : kind === "mic" ? { audio: true } : { audio: true, video: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  /* ===================== DRAW INPUT ===================== */
  const getActiveColor = () => (tool === "eraser" ? "#111" : strokeColor);
  const getActiveSize = () => strokeSize;

  function startDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!canCurrentUserEditBoard()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawingRef.current = true;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentStrokeRef.current = { color: getActiveColor(), size: getActiveSize(), points: [{ x, y }] };
  }
  function moveDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentStrokeRef.current.points.push({ x, y });
    const curViewedId = viewBoardForRef.current;
    const temp = [...(boardsRef.current[curViewedId] || []), currentStrokeRef.current];
    redrawCanvas(temp);
  }
  async function endDraw() {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    drawingRef.current = false;
    const room = roomRef.current;
    const targetBoardId = viewBoardForRef.current;
    const finalStroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (!room || !targetBoardId) return;
    appendStroke(targetBoardId, finalStroke);
    const msg = { type: "wbstroke", author: targetBoardId, stroke: finalStroke };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }
  async function clearViewedBoard() {
    if (!canCurrentUserEditBoard()) return;
    const targetId = viewBoardForRef.current;
    if (!targetId) return;
    replaceBoard(targetId, []);
    const room = roomRef.current;
    if (room) {
      const msg = { type: "wb_clear", author: targetId };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      try {
        await room.localParticipant.publishData(data, { reliable: true });
      } catch {}
    }
  }
  async function broadcastFullBoard(authorId: string) {
    const room = roomRef.current;
    if (!room) return;
    ensureBoard(authorId);
    const fullBoard = boardsRef.current[authorId] || [];
    const msg = { type: "wb_sync", author: authorId, strokes: fullBoard };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }
  async function requestBoardSync(authorId: string) {
    const room = roomRef.current;
    if (!room) return;
    const have = boardsRef.current[authorId] || [];
    if (have.length > 0) return;
    const msg = { type: "wb_request", author: authorId };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }

  /* ===================== AUDIO: student ↔ tutor ===================== */
  function getTutorMicPub(room: Room) {
    const tutor = Array.from(room.remoteParticipants.values()).find((p) => isTutorId(p.identity));
    if (!tutor) return undefined;
    return Array.from(tutor.audioTrackPublications.values()).find((pub) => pub.source === Track.Source.Microphone);
  }
  function playTutorAudio(pub: RemoteTrackPublication, shouldHear: boolean) {
    const map = tutorAudioElsRef.current;
    const sid = pub.trackSid || pub.track?.sid || "tutor-audio";
    const existing = map.get(sid);
    if (!shouldHear) {
      if (existing) {
        existing.pause();
        pub.track?.detach(existing);
        existing.remove();
        map.delete(sid);
      }
      return;
    }
    const track = pub.track;
    if (!track) return;
    if (existing) {
      existing.muted = false;
      existing.autoplay = true;
      existing.play().catch(() => {});
      return;
    }
    const el = track.attach() as HTMLAudioElement;
    el.style.display = "none";
    el.autoplay = true;
    el.muted = false;
    document.body.appendChild(el);
    el.play().catch(() => {});
    map.set(sid, el);
  }
  function applyStudentHearing(room: Room) {
    if (lockedRole !== "student") return;
    const me = myIdRef.current || room.localParticipant.identity;
    const shouldHear = computeStudentHearing(me);
    killStudentAudioLocally();
    const micPub = getTutorMicPub(room);
    pushDebug("student:apply-hearing", { shouldHear, micPubFound: !!micPub });
    if (!micPub) {
      setICanHearTutor(shouldHear);
      return;
    }
    try {
      micPub.setSubscribed(shouldHear);
    } catch {}
    playTutorAudio(micPub, shouldHear);
    setICanHearTutor(shouldHear);
    setPermVersion((v) => v + 1);
  }

  function handleTutorListenToStudent(pub: RemoteTrackPublication, studentId: string) {
    if (lockedRole !== "tutor") return;
    const allow = computeTutorHearingStudent(studentId);
    const map = studentAudioElsRef.current;
    const sid = pub.trackSid || pub.track?.sid || `student-${studentId}`;
    const existing = map.get(sid);
    try {
      pub.setSubscribed(allow);
    } catch {}
    if (!allow) {
      if (existing) {
        existing.pause();
        pub.track?.detach(existing);
        existing.remove();
        map.delete(sid);
      }
      delete pendingTutorSubsRef.current[studentId];
      return;
    }
    if (pub.track) {
      if (existing) {
        existing.muted = false;
        existing.autoplay = true;
        existing.play().catch(() => {});
        delete pendingTutorSubsRef.current[studentId];
        return;
      }
      const el = pub.track.attach() as HTMLAudioElement;
      el.style.display = "none";
      el.autoplay = true;
      el.muted = false;
      document.body.appendChild(el);
      el.play().catch(() => {});
      map.set(sid, el);
      delete pendingTutorSubsRef.current[studentId];
      return;
    }
    pendingTutorSubsRef.current[studentId] = true;
  }
  function reapplyTutorForStudent(room: Room, studentId: string) {
    if (lockedRole !== "tutor") return;
    const p = Array.from(room.remoteParticipants.values()).find((rp) => rp.identity === studentId);
    if (!p) return;
    for (const pub of p.audioTrackPublications.values()) {
      if (pub.source === Track.Source.Microphone) {
        handleTutorListenToStudent(pub as RemoteTrackPublication, studentId);
      }
    }
  }

  /* ===================== DATA MESSAGES ===================== */
  async function handleDataMessage(msg: any) {
    const room = roomRef.current;
    if (!room || !msg) return;

    if (msg.type === "perm") {
      const { studentId, hear, speak } = msg;
      hearMapRef.current[studentId] = !!hear;
      speakMapRef.current[studentId] = !!speak;

      if (lockedRole === "tutor") {
        setCanHearTutor((prev) => ({ ...prev, [studentId]: !!hear }));
        setCanSpeakToTutor((prev) => ({ ...prev, [studentId]: !!speak }));
        reapplyTutorForStudent(room, studentId);
        setPermVersion((v) => v + 1);
      }
      if (lockedRole === "student" && (myIdRef.current || room.localParticipant.identity) === studentId) {
        applyStudentHearing(room);
      } else if (lockedRole === "student") {
        setPermVersion((v) => v + 1);
      }
    }

    if (msg.type === "wbstroke") {
      const { author, stroke } = msg;
      ensureBoard(author);
      appendStroke(author, stroke);
    }
    if (msg.type === "wb_sync") {
      const { author, strokes } = msg as { author: string; strokes: Stroke[] };
      ensureBoard(author);
      replaceBoard(author, strokes);
    }
    if (msg.type === "wb_request") {
      const { author } = msg as { author: string };
      if (author === myIdRef.current) await broadcastFullBoard(author);
    }
    if (msg.type === "wb_clear") {
      const { author } = msg as { author: string };
      replaceBoard(author, []);
    }
  }
  async function broadcastPermUpdate(studentId: string, hear: boolean, speak: boolean) {
    const room = roomRef.current;
    if (!room) return;
    hearMapRef.current[studentId] = hear;
    speakMapRef.current[studentId] = speak;
    setCanHearTutor((prev) => ({ ...prev, [studentId]: hear }));
    setCanSpeakToTutor((prev) => ({ ...prev, [studentId]: speak }));
    setPermVersion((v) => v + 1);
    const msg = { type: "perm", studentId, hear, speak };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    await room.localParticipant.publishData(data, { reliable: true });
    if (lockedRole === "tutor") reapplyTutorForStudent(room, studentId);
  }

  /* ===================== LiveKit events wiring ===================== */
  function wireEvents(room: Room) {
    room
      .on(RoomEvent.ParticipantConnected, (p: Participant) => {
        pushDebug("lk:participant-connected", { id: p.identity, name: p.name, sid: p.sid });
        refreshTilesAndRoster(room);
        ensureBoard(p.identity || "");
        broadcastFullBoard(myIdRef.current);
        if (lockedRole === "student") applyStudentHearing(room);
        if (lockedRole === "tutor") students.forEach((s) => reapplyTutorForStudent(room, s.id));
        setTimeout(() => resizeCanvas(), 0);
      })
      .on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        pushDebug("lk:participant-disconnected", { id: p.identity, name: p.name, sid: p.sid });
        refreshTilesAndRoster(room);
        setTimeout(() => resizeCanvas(), 0);
      })
      .on(RoomEvent.TrackSubscribed, (_track, pub, participant) => {
        pushDebug("lk:track-subscribed", { participant: participant.identity, kind: pub.kind, source: pub.source });
        refreshTilesAndRoster(room);

        const pid = participant.identity || "";
        const studentPid = isStudentId(pid);
        const tutorPid = isTutorId(pid);

        if (lockedRole === "student") {
          if (pub.kind === "audio" && tutorPid) applyStudentHearing(room);
          if (pub.kind === "audio" && studentPid) {
            const rpub = pub as RemoteTrackPublication;
            try {
              rpub.setSubscribed(false);
            } catch {}
            killStudentAudioLocally();
          }
        }

        if (lockedRole === "tutor") {
          if (pub.kind === "audio" && studentPid) {
            if (pendingTutorSubsRef.current[pid] || computeTutorHearingStudent(pid)) {
              handleTutorListenToStudent(pub as RemoteTrackPublication, pid);
            }
          }
        }

        if (lockedRole === "admin" && pub.kind === "audio") {
          const rpub = pub as RemoteTrackPublication;
          try {
            rpub.setSubscribed(false);
          } catch {}
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
        pushDebug("lk:track-unsubscribed", { participant: participant.identity, kind: pub.kind, source: pub.source });
        refreshTilesAndRoster(room);
      })
      .on(RoomEvent.TrackPublished, (_pub, participant) => {
        pushDebug("lk:track-published", { participant: participant.identity });
        refreshTilesAndRoster(room);
        syncLocalAVFlags(room.localParticipant);
      })
      .on(RoomEvent.TrackUnpublished, (_pub, participant) => {
        pushDebug("lk:track-unpublished", { participant: participant.identity });
        refreshTilesAndRoster(room);
        syncLocalAVFlags(room.localParticipant);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setActiveSpeakers(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.DataReceived, (payload) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          pushDebug("lk:data", msg);
          handleDataMessage(msg);
        } catch {}
      })
      .on(RoomEvent.Disconnected, () => {
        pushDebug("lk:disconnected");
        setStatus("Disconnected");
      });
  }

  /* ===================== CONNECT ===================== */
  useEffect(() => {
    if (!authed || !lockedRole) return;

    // No room yet for student/admin attempting session join: keep waiting while resolver runs.
    if (lockedRole !== "tutor" && !sessionRoomId) {
      if (modeFromQP === "session" && bookingKey.id) {
        setStatus("Resolving your session room…");
        setError(null);
        return;
      }
      setStatus("Missing room link");
      setError("Ask your tutor for their session link (it includes ?roomId=...)");
      return;
    }

    const intendedMode: RoomMode | null =
      lockedRole === "tutor" ? (modeFromQP === "session" ? "session" : "homework") : null;

    const intendedBookingId =
      lockedRole === "tutor" ? bookingKey.id || null : bookingKey.id || "";

    let room: Room | null = null;
    let hb: any = null;
    let byeHandler: (() => void) | null = null;

    (async () => {
      try {
        // Pre-write tutor status/mode
        if (lockedRole === "tutor") {
          const tutorUid = auth.currentUser?.uid || null;
          if (tutorUid) {
            await writeRoomMode(tutorUid, intendedMode, intendedMode === "session" ? intendedBookingId : null);
            if (intendedMode === "session") await setTutorStatus(tutorUid, "busy");
          }
        }

        const idToken = await auth.currentUser?.getIdToken();

        const bodyPayload: any = {
          role: lockedRole,
          name: profileName || (lockedRole === "tutor" ? "Tutor" : "Student"),
          roomId: sessionRoomId,
        };
        if (bookingKey.id) {
          bodyPayload.bookingId = bookingKey.id;
          if (bookingKey.startMsHint) bodyPayload.bookingStartMs = bookingKey.startMsHint;
          if (rawBookingKey) bodyPayload.bookingIdRaw = rawBookingKey; // extra context for your API
        }

        pushDebug("token:req", bodyPayload);

        const res = await fetch("/api/rooms/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify(bodyPayload),
        });
        let tokenJson: TokenResp | null = null;
        try {
          tokenJson = (await res.json()) as TokenResp;
        } catch {
          tokenJson = null;
        }
        if (!res.ok || !tokenJson) {
          pushDebug("token:fail", { status: res.status, body: tokenJson });
          throw new Error((tokenJson as any)?.error || `Token endpoint failed: ${res.status}`);
        }
        pushDebug("token:ok", tokenJson);

        const { token, url, roomName, identity } = tokenJson;

        setError(null);
        setMyIdentity(identity);
        myIdRef.current = identity;
        ensureBoard(identity);
        setViewBoardFor(identity);
        viewBoardForRef.current = identity;

        const signalingUrl = `${url}/${roomName}`;
        const roomInstance = new Room();
        roomRef.current = roomInstance;

        pushDebug("lk:connect:begin", { signalingUrl, identity, role: lockedRole, sessionRoomId });

        await roomInstance.connect(signalingUrl, token);

        // Guard: only one tutor visible to others
        if (lockedRole === "tutor") {
          const otherTutor = Array.from(roomInstance.remoteParticipants.values()).find((p) => isTutorId(p.identity));
          if (otherTutor) {
            setStatus("Another tutor is already in the room. This tab will leave.");
            pushDebug("lk:other-tutor-present", { otherTutor: otherTutor.identity });
            roomInstance.disconnect();
            return;
          }
        }

        if (lockedRole === "admin") {
          try {
            await roomInstance.localParticipant.setMicrophoneEnabled(false);
          } catch {}
          try {
            await roomInstance.localParticipant.setCameraEnabled(false);
          } catch {}
        } else {
          try {
            await roomInstance.localParticipant.setMicrophoneEnabled(true);
          } catch {}
          try {
            await roomInstance.localParticipant.setCameraEnabled(true);
          } catch {}
        }

        syncLocalAVFlags(roomInstance.localParticipant);

        const bannerMode =
          lockedRole === "tutor"
            ? intendedMode
            : modeFromQP === "session"
            ? "session"
            : modeFromQP === "homework"
            ? "homework"
            : undefined;
        const normNote =
          rawBookingKey && bookingKey.id && rawBookingKey !== bookingKey.id
            ? ` (normalized bookingId: ${bookingKey.id})`
            : "";

        if (lockedRole === "admin") setStatus(`Observer mode in ${sessionRoomId} (mic/cam off)${normNote}`);
        else if (lockedRole === "tutor")
          setStatus(
            (bannerMode === "session"
              ? "Tutor connected — Session mode (only booked student may enter)."
              : "Tutor connected — Homework Help mode.") + normNote
          );
        else
          setStatus(
            (bannerMode === "session"
              ? "Connected as Student — Session mode."
              : "Connected as Student — Homework Help.") + normNote
          );

        // presence heartbeat
        const uid = auth.currentUser?.uid || null;
        const touchPresence = async () => {
          if (!uid) return;
          try {
            await updateDoc(doc(db, "users", uid), { lastActiveAt: Date.now() });
          } catch {}
        };
        await touchPresence();
        hb = setInterval(touchPresence, 15_000);
        roomInstance.on(RoomEvent.ParticipantConnected, touchPresence);
        roomInstance.on(RoomEvent.ParticipantDisconnected, touchPresence);
        roomInstance.on(RoomEvent.Connected, touchPresence);
        roomInstance.once(RoomEvent.Disconnected, touchPresence);

        if (lockedRole === "student") {
          hearMapRef.current[identity] = false;
          speakMapRef.current[identity] = false;
          setICanHearTutor(false);
        }

        if (lockedRole === "tutor") {
          hearMapRef.current = {};
          speakMapRef.current = {};
          setCanHearTutor({});
          setCanSpeakToTutor({});

          const tutorUid = auth.currentUser?.uid || null;

          const writeFromOccupancy = async () => {
            if (!tutorUid) return;
            if (intendedMode === "session") {
              await setTutorStatus(tutorUid, "busy");
              return;
            }
            const hasStudent = Array.from(roomInstance.remoteParticipants.values()).some((p) => isStudentId(p.identity));
            await setTutorStatus(tutorUid, hasStudent ? "busy" : "waiting");
          };

          await writeFromOccupancy();
          roomInstance.on(RoomEvent.ParticipantConnected, writeFromOccupancy);
          roomInstance.on(RoomEvent.ParticipantDisconnected, writeFromOccupancy);
          roomInstance.on(RoomEvent.Connected, writeFromOccupancy);

          // Admin Dashboard session tracking
          const sessionRef = doc(db, "sessions", sessionRoomId);
          const rosterSnapshot = () =>
            Array.from(roomInstance.remoteParticipants.values())
              .filter((p) => isStudentId(p.identity))
              .map((p) => ({ id: p.identity || "", name: p.name || "Student" }));

          const primeSession = async () => {
            try {
              const meEmail = auth.currentUser?.email || undefined;
              const tutorName = profileName || (meEmail ? meEmail.split("@")[0] : "Tutor");
              const prev = await getDoc(sessionRef);
              const keepStartedAt =
                (prev.exists() && typeof prev.data()?.startedAt === "number"
                  ? (prev.data()?.startedAt as number)
                  : null) ?? null;
              const studentsNow = rosterSnapshot();
              const payload: SessionDoc = {
                roomId: sessionRoomId,
                active: true,
                tutorUid: tutorUid || "",
                tutorName,
                tutorEmail: meEmail,
                students: studentsNow,
                studentsCount: studentsNow.length,
                startedAt: keepStartedAt ?? Date.now(),
                updatedAt: Date.now(),
              };
              await setDoc(sessionRef, payload, { merge: true });
            } catch {}
          };
          const writeFromOccupancyToSession = async () => {
            try {
              const studentsNow = rosterSnapshot();
              await setDoc(
                sessionRef,
                {
                  active: true,
                  students: studentsNow,
                  studentsCount: studentsNow.length,
                  updatedAt: Date.now(),
                  mode: intendedMode ?? "homework",
                  currentBookingId: intendedMode === "session" ? intendedBookingId || null : null,
                },
                { merge: true }
              );
            } catch {}
          };
          const markSessionInactive = async () => {
            try {
              await setDoc(
                sessionRef,
                { active: false, students: [], studentsCount: 0, updatedAt: Date.now() },
                { merge: true }
              );
            } catch {}
          };

          await primeSession();
          roomInstance.on(RoomEvent.ParticipantConnected, writeFromOccupancyToSession);
          roomInstance.on(RoomEvent.ParticipantDisconnected, writeFromOccupancyToSession);
          roomInstance.on(RoomEvent.Connected, writeFromOccupancyToSession);

          byeHandler = () => {
            if (tutorUid) {
              writeRoomMode(tutorUid, null, null).catch(() => {});
              setTutorStatus(tutorUid, "offline").catch(() => {});
            }
            markSessionInactive().catch(() => {});
          };
          window.addEventListener("beforeunload", byeHandler);
          roomInstance.once(RoomEvent.Disconnected, () => {
            markSessionInactive().catch(() => {});
            if (tutorUid) {
              writeRoomMode(tutorUid, null, null).catch(() => {});
              setTutorStatus(tutorUid, "offline").catch(() => {});
            }
            if (byeHandler) window.removeEventListener("beforeunload", byeHandler);
          });
        }

        wireEvents(roomInstance);
        refreshTilesAndRoster(roomInstance);
        broadcastFullBoard(identity);
        setTimeout(() => resizeCanvas(), 0);

        room = roomInstance;
        pushDebug("lk:connect:ok", { identity, role: lockedRole });
      } catch (e: any) {
        console.error(e);
        pushDebug("lk:connect:error", { message: e?.message || String(e) });
        setError(e?.message || String(e));
        setStatus("Failed to join");
      }
    })();

    return () => {
      try {
        if (byeHandler) window.removeEventListener("beforeunload", byeHandler);
        if (hb) clearInterval(hb);
      } catch {}
      room?.disconnect();
    };
  }, [authed, lockedRole, sessionRoomId, profileName, resizeCanvas, modeFromQP, bookingKey.id, rawBookingKey]);

  /* ===================== ROSTER / TILES ===================== */
  function refreshTilesAndRoster(room: Room) {
    const nextTiles: typeof tiles = [];
    const lp = room.localParticipant;

    if (lockedRole !== "admin") {
      const localVideoPubs: LocalTrackPublication[] = [];
      for (const pub of lp.trackPublications.values()) {
        if (pub.source === Track.Source.Camera) localVideoPubs.push(pub as LocalTrackPublication);
      }
      if (localVideoPubs.length > 0) {
        for (const pub of localVideoPubs) {
          if (pub.track) {
            nextTiles.push({
              id: `local-${pub.trackSid}`,
              name: profileName || lp.name || lp.identity,
              isLocal: true,
              pub,
              pid: lp.identity,
            });
          }
        }
      } else {
        nextTiles.push({
          id: `local-placeholder-${lp.identity}`,
          name: profileName || lp.name || lp.identity,
          isLocal: true,
          pub: null,
          pid: lp.identity,
          placeholder: true,
        });
      }
    }

    const roster: { id: string; name: string }[] = [];
    for (const p of room.remoteParticipants.values()) {
      if (lockedRole !== "admin" && isObserverId(p.identity)) continue;

      roster.push({ id: p.identity, name: p.name ?? p.identity });
      ensureBoard(p.identity);

      let addedCam = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.Camera && pub.track) {
          nextTiles.push({
            id: `remote-${p.sid}-${pub.trackSid}`,
            name: p.name ?? p.identity,
            isLocal: false,
            pub,
            pid: p.identity,
          });
          addedCam = true;
        }
      }
      if (!addedCam) {
        nextTiles.push({
          id: `remote-placeholder-${p.sid}`,
          name: p.name ?? p.identity,
          isLocal: false,
          pub: null,
          pid: p.identity,
          placeholder: true,
        });
      }
    }

    setTiles(nextTiles);

    const onlyStudents = roster.filter((r) => isStudentId(r.id)).sort((a, b) => a.name.localeCompare(b.name));
    setStudents(onlyStudents);
  }

  // Role-aware tile ordering
  useEffect(() => {
    if (!lockedRole) return;

    const meId = myIdentity;

    const tutorTiles: typeof tiles = [];
    const myTiles: typeof tiles = [];
    const studentTiles: typeof tiles = [];
    const misc: typeof tiles = [];

    for (const t of tiles) {
      const pid = t.pid;
      if (lockedRole !== "admin" && isObserverId(pid)) continue;

      if (isTutorId(pid)) tutorTiles.push(t);
      else if (pid === meId) myTiles.push(t);
      else if (isStudentId(pid)) studentTiles.push(t);
      else misc.push(t);
    }

    let tutorTile: (typeof tiles)[number] | undefined;
    if (lockedRole === "tutor") tutorTile = tutorTiles.find((tt) => tt.isLocal) || tutorTiles[0];
    else tutorTile = tutorTiles[0];

    const myTile = myTiles[0];
    studentTiles.sort((a, b) => a.name.localeCompare(b.name));

    if (lockedRole === "tutor") {
      const ordered: typeof tiles = [];
      if (myTile) ordered.push(myTile);
      else if (tutorTile && tutorTile !== myTile) ordered.push(tutorTile);
      ordered.push(...studentTiles, ...misc);
      setOrderedTiles(ordered);
    } else if (lockedRole === "admin") {
      const ordered: typeof tiles = [];
      if (tutorTile) ordered.push(tutorTile);
      ordered.push(...studentTiles, ...misc);
      setOrderedTiles(ordered);
    } else {
      const ordered: typeof tiles = [];
      if (tutorTile) ordered.push(tutorTile);
      if (myTile && myTile !== tutorTile) ordered.push(myTile);
      setOrderedTiles(ordered);
    }
  }, [tiles, lockedRole, myIdentity]);

  /* ===================== Responsive sizes ===================== */
  const resizeCanvasAndTiles = useCallback(() => {
    if (!mainRef.current || !videoColumnRef.current) return;

    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const tileCount = orderedTiles.length || 1;
    const gap = 12;

    const rectMain = mainRef.current.getBoundingClientRect();
    const rectColumn = videoColumnRef.current.getBoundingClientRect();
    const topSpace = rectColumn.top - rectMain.top;

    const bottomReserve = 80;
    const availableH = vh - topSpace - bottomReserve;
    if (availableH <= 0) return;

    const perTileExtra = 50;
    const totalExtra = perTileExtra * tileCount;
    const totalGap = gap * (tileCount - 1);

    const videoBudget = availableH - totalExtra - totalGap;
    const rawVideoH = videoBudget > 0 ? videoBudget / tileCount : 100;

    const maxColW = Math.min(380, vw * 0.4);

    let h_fromHeight = Math.max(rawVideoH, 100);
    let w_fromHeight = h_fromHeight * (4 / 3);
    if (w_fromHeight > maxColW) {
      w_fromHeight = maxColW;
      h_fromHeight = w_fromHeight * (3 / 4);
    }

    let w_fromWidth = maxColW;
    let h_fromWidth = w_fromWidth * (3 / 4);

    if (h_fromWidth > rawVideoH) setTileSize({ w: w_fromHeight, h: h_fromHeight });
    else setTileSize({ w: w_fromWidth, h: h_fromWidth });

    setTimeout(() => resizeCanvas(), 0);
  }, [orderedTiles, resizeCanvas]);

  useEffect(() => {
    resizeCanvasAndTiles();
  }, [orderedTiles, resizeCanvasAndTiles]);
  useEffect(() => {
    function onResize() {
      resizeCanvasAndTiles();
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [resizeCanvasAndTiles]);

  /* ===================== FEED DOM RENDERER ===================== */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.width = "100%";
    container.style.flex = "1 1 auto";
    container.style.minHeight = "0";
    container.style.overflow = "hidden";
    container.style.alignItems = "flex-start";

    container.querySelectorAll("div[data-ordered-tilewrap]").forEach((n) => n.remove());

    orderedTiles.forEach((t) => {
      const wrap = document.createElement("div");
      wrap.setAttribute("data-ordered-tilewrap", t.id);
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.alignItems = "flex-start";
      wrap.style.gap = "6px";
      wrap.style.maxWidth = `${tileSize.w}px`;

      const frame = document.createElement("div");
      frame.style.display = "flex";
      frame.style.flexDirection = "column";
      frame.style.alignItems = "flex-start";
      frame.style.gap = "6px";
      frame.style.cursor = "pointer";

      frame.onclick = () => {
        setViewBoardFor(t.pid);
        viewBoardForRef.current = t.pid;
        const have = boardsRef.current[t.pid] || [];
        if (have.length === 0) requestBoardSync(t.pid);
        redrawCanvas(boardsRef.current[t.pid] || []);
        setTimeout(() => resizeCanvas(), 0);
      };

      if (t.pub && t.pub.track) {
        const el = t.pub.track.attach();
        const vid = el as HTMLVideoElement;
        vid.muted = t.isLocal;
        vid.playsInline = true;
        vid.style.width = `${tileSize.w}px`;
        vid.style.height = `${tileSize.h}px`;
        vid.style.objectFit = "cover";
        vid.style.borderRadius = "12px";
        vid.style.border = "2px solid #4db1ff";
        vid.style.boxShadow = "0 0 0 0 transparent";
        frame.appendChild(vid);
      } else {
        const ph = document.createElement("div");
        ph.style.width = `${tileSize.w}px`;
        ph.style.height = `${tileSize.h}px`;
        ph.style.borderRadius = "12px";
        ph.style.border = "2px solid #4db1ff";
        ph.style.background = "rgba(255,255,255,0.05)";
        ph.style.display = "flex";
        ph.style.alignItems = "center";
        ph.style.justifyContent = "center";
        ph.style.color = "#fff";
        ph.style.fontSize = "14px";
        ph.style.fontFamily = "system-ui, sans-serif";
        ph.textContent = t.isLocal ? "Camera off (you)" : "Camera off";
        frame.appendChild(ph);
      }

      // profile label
      const profileWrap = document.createElement("div");
      profileWrap.style.display = "flex";
      profileWrap.style.flexDirection = "column";
      profileWrap.style.alignItems = "flex-start";
      profileWrap.style.gap = "2px";

      const nameEl = document.createElement("div");
      nameEl.textContent = t.name || t.pid;
      nameEl.style.fontSize = "14px";
      nameEl.style.fontWeight = "600";
      nameEl.style.color = "#fff";

      let roleText =
        isTutorId(t.pid) ? "Tutor" : isStudentId(t.pid) ? "Student" : isObserverId(t.pid) ? "Observer" : "Participant";
      if (t.pid === myIdRef.current) roleText += " (You)";

      const roleEl = document.createElement("div");
      roleEl.textContent = roleText;
      roleEl.style.fontSize = "12px";
      roleEl.style.color = "rgba(255,255,255,0.7)";

      profileWrap.appendChild(nameEl);
      profileWrap.appendChild(roleEl);
      frame.appendChild(profileWrap);

      wrap.appendChild(frame);

      const amTutor = lockedRole === "tutor";
      const amAdmin = lockedRole === "admin";
      const amStudent = lockedRole === "student";

      const isRemoteStudentTile = amTutor && !t.isLocal && isStudentId(t.pid);
      const isMeStudentTile = amStudent && t.pid === myIdRef.current && isStudentId(t.pid);

      if (isRemoteStudentTile && !amAdmin) {
        const ctlRow = document.createElement("div");
        ctlRow.style.display = "flex";
        ctlRow.style.gap = "8px";
        ctlRow.style.flexWrap = "wrap";
        ctlRow.style.alignItems = "center";

        const hearOn = !!canHearTutor[t.pid];
        const speakOn = !!canSpeakToTutor[t.pid];

        const hearBtn = document.createElement("button");
        hearBtn.textContent = "Hear";
        hearBtn.style.padding = "6px 10px";
        hearBtn.style.borderRadius = "8px";
        hearBtn.style.minWidth = "70px";
        hearBtn.style.fontSize = "13px";
        hearBtn.style.lineHeight = "1.2";
        hearBtn.style.background = hearOn ? "#3a6" : "#2a2a2a";
        hearBtn.style.border = hearOn ? "1px solid #6ecf9a" : "1px solid #444";
        hearBtn.style.color = "#fff";
        hearBtn.style.cursor = "pointer";
        hearBtn.onclick = async () => {
          const newHear = !hearMapRef.current[t.pid];
          const currentSpeak = speakMapRef.current[t.pid] || false;
          await broadcastPermUpdate(t.pid, newHear, currentSpeak);
        };

        const speakBtn = document.createElement("button");
        speakBtn.textContent = "Speak";
        speakBtn.style.padding = "6px 10px";
        speakBtn.style.borderRadius = "8px";
        speakBtn.style.minWidth = "70px";
        speakBtn.style.fontSize = "13px";
        speakBtn.style.lineHeight = "1.2";
        speakBtn.style.background = speakOn ? "#3a6" : "#2a2a2a";
        speakBtn.style.border = speakOn ? "1px solid #6ecf9a" : "1px solid #444";
        speakBtn.style.color = "#fff";
        speakBtn.style.cursor = "pointer";
        speakBtn.onclick = async () => {
          const newSpeak = !speakMapRef.current[t.pid];
          const currentHear = hearMapRef.current[t.pid] || false;
          await broadcastPermUpdate(t.pid, currentHear, newSpeak);
        };

        ctlRow.appendChild(hearBtn);
        ctlRow.appendChild(speakBtn);
        wrap.appendChild(ctlRow);
      }

      if (isMeStudentTile && !amAdmin) {
        const indicatorRow = document.createElement("div");
        indicatorRow.style.display = "flex";
        indicatorRow.style.gap = "8px";
        indicatorRow.style.flexWrap = "wrap";
        indicatorRow.style.alignItems = "center";
        const hearAllowed = !!hearMapRef.current[myIdRef.current];
        const speakAllowed = !!speakMapRef.current[myIdRef.current];

        function mkPill(labelText: string, allowed: boolean) {
          const pill = document.createElement("div");
          pill.textContent = labelText;
          pill.style.padding = "6px 10px";
          pill.style.borderRadius = "8px";
          pill.style.minWidth = "70px";
          pill.style.fontSize = "13px";
          pill.style.lineHeight = "1.2";
          pill.style.color = "#fff";
          pill.style.textAlign = "center";
          pill.style.userSelect = "none";
          if (allowed) {
            pill.style.background = "#3a6";
            pill.style.border = "1px solid #6ecf9a";
          } else {
            pill.style.background = "#622";
            pill.style.border = "1px solid #a66";
          }
          return pill;
        }

        indicatorRow.appendChild(mkPill("Hear", hearAllowed));
        indicatorRow.appendChild(mkPill("Speak", speakAllowed));
        wrap.appendChild(indicatorRow);
      }

      container.appendChild(wrap);
    });

    return () => {
      orderedTiles.forEach((t) => {
        if (t.pub?.track) t.pub.track.detach().forEach((el) => el.remove());
      });
    };
  }, [orderedTiles, lockedRole, canHearTutor, canSpeakToTutor, tileSize, permVersion, resizeCanvas]);

  /* ===================== CAMERA/MIC BUTTONS ===================== */
  async function turnCameraOn() {
    const room = roomRef.current;
    if (!room || lockedRole === "admin") return;
    await ensureLocalMediaPermission("camera");
    try {
      await room.localParticipant.setCameraEnabled(true);
      syncLocalAVFlags(room.localParticipant);
      refreshTilesAndRoster(room);
    } catch {}
  }
  async function turnMicOn() {
    const room = roomRef.current;
    if (!room || lockedRole === "admin") return;
    await ensureLocalMediaPermission("mic");
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      syncLocalAVFlags(room.localParticipant);
      refreshTilesAndRoster(room);
    } catch {}
  }

  /* ===================== COPY INVITE LINK ===================== */
  function copyInviteLink() {
    if (!sessionRoomId) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/room?roomId=${encodeURIComponent(sessionRoomId)}${
      modeFromQP ? `&mode=${encodeURIComponent(modeFromQP)}` : ""
    }${rawBookingKey ? `&bookingId=${encodeURIComponent(rawBookingKey)}` : ""}${debugOpen ? "&debug=1" : ""}`;
    navigator.clipboard.writeText(link).catch(() => {});
  }

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  const roleLabel = mounted
    ? lockedRole === "tutor"
      ? "Tutor"
      : lockedRole === "student"
      ? "Student"
      : lockedRole === "admin"
      ? "Observer"
      : "…"
    : "…";

  const currentBannerMode: "Homework Help" | "1-on-1 Session" | null = (() => {
    const m = (modeFromQP || "") as string;
    if (lockedRole === "tutor") return m === "session" ? "1-on-1 Session" : "Homework Help";
    if (m === "session") return "1-on-1 Session";
    if (m === "homework") return "Homework Help";
    return null;
  })();

  const editable = canCurrentUserEditBoard();

  const inviteLinkUI =
    lockedRole === "tutor" && sessionRoomId ? (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 8,
          padding: "8px 12px",
          marginTop: 8,
          maxWidth: "100%",
          color: "#fff",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {currentBannerMode ? `${currentBannerMode} invite:` : "Invite your student:"}
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              lineHeight: 1.4,
              wordBreak: "break-all",
              color: "#9cf",
            }}
          >
            {typeof window !== "undefined"
              ? `${window.location.origin}/room?roomId=${sessionRoomId}${
                  modeFromQP ? `&mode=${modeFromQP}` : ""
                }${rawBookingKey ? `&bookingId=${rawBookingKey}` : ""}${debugOpen ? "&debug=1" : ""}`
              : `/room?roomId=${sessionRoomId}${modeFromQP ? `&mode=${modeFromQP}` : ""}${
                  rawBookingKey ? `&bookingId=${rawBookingKey}` : ""
                }${debugOpen ? "&debug=1" : ""}`}
          </div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>
            {modeFromQP === "session"
              ? "Only the booked student can enter during the session window."
              : "Anyone can drop in for Homework Help."}
          </div>
        </div>
        <button onClick={copyInviteLink} style={ghostButtonStyle}>
          Copy link
        </button>
      </div>
    ) : null;

  const showMissingRoomWarning =
    authed && lockedRole && lockedRole !== "tutor" && !sessionRoomId && !(modeFromQP === "session" && bookingKey.id);

  /* ===================== Render ===================== */
  return (
    <main
      ref={mainRef}
      style={{
        position: "relative",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#0f0f0f",
        color: "#fff",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
      }}
    >
      {/* HEADER */}
      <header
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto 12px",
          padding: "16px 24px",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "stretch",
          borderRadius: 12,
          background: "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(15,15,15,0.0) 100%)",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
        }}
      >
        <div style={{ color: "#fff", display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            Tutoring Room ({roleLabel}){currentBannerMode ? ` — ${currentBannerMode}` : ""}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            style={{
              ...ghostButtonStyle,
              background: debugOpen ? "#2d3f2d" : "#2a2a2a",
              borderColor: debugOpen ? "#4f8f4f" : "#444",
            }}
            onClick={() => setDebugOpen((v) => !v)}
            title="Toggle debug console"
          >
            {debugOpen ? "Hide debug" : "Show debug"}
          </button>
          {lockedRole === "tutor" && navStatus && <div style={statusPillStyle(navStatus)}>{statusLabel(navStatus)}</div>}
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            Home
          </button>
          <button style={ghostButtonStyle} onClick={() => router.push("/profile")}>
            Profile
          </button>
          <button
            style={ghostButtonStyle}
            onClick={() => {
              if (lockedRole === "tutor") router.push("/dashboard/tutor");
              else if (lockedRole === "student") router.push("/dashboard/student");
              else router.push("/admin");
            }}
          >
            Dashboard
          </button>
          {lockedRole === "student" && (
            <button style={ghostButtonStyle} onClick={() => router.push("/tutors")}>
              Find a Tutor
            </button>
          )}
          <button style={ghostButtonStyle} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {/* STATUS / BANNERS */}
      <div style={{ width: "100%", maxWidth: "1280px", margin: "0 auto 8px", flex: "0 0 auto", color: "#fff" }}>
        <p style={{ margin: "0 0 8px", opacity: 0.9, fontSize: 14, lineHeight: 1.4 }}>{status}</p>
        {error && (
          <p style={{ color: "tomato", marginTop: 0, fontSize: 14, lineHeight: 1.4 }}>
            Error: {error}
          </p>
        )}
        {inviteLinkUI}
        {showMissingRoomWarning && (
          <div
            style={{
              background: "rgba(255,0,0,0.08)",
              border: "1px solid rgba(255,0,0,0.4)",
              color: "#ff8b8b",
              borderRadius: 8,
              padding: "8px 12px",
              marginTop: 12,
              fontSize: 13,
              lineHeight: 1.4,
              maxWidth: 480,
            }}
          >
            Ask your tutor for their session link. It should look like: /room?roomId=theirRoomIdHere
          </div>
        )}
      </div>

      {/* DEBUG CONSOLE */}
      {debugOpen && (
        <div
          style={{
            width: "100%",
            maxWidth: 1280,
            margin: "0 auto 12px",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 10,
            background: "rgba(0,0,0,0.35)",
            padding: 12,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 12,
            color: "#cfe9ff",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700, color: "#9bd" }}>Debug Console</div>
            <button
              style={ghostButtonStyle}
              onClick={() => {
                const payload = {
                  query: {
                    modeFromQP,
                    rawBookingKey,
                    normalizedBookingId: bookingKey.id,
                    roomId: sessionRoomId,
                  },
                  user: { email: userEmail, role: lockedRole, profileName, identity: myIdentity },
                  notes: error ? { error } : {},
                  events: debugRef.current,
                };
                const text = JSON.stringify(payload, null, 2);
                navigator.clipboard.writeText(text).catch(() => {});
              }}
            >
              Copy JSON
            </button>
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowX: "auto", maxHeight: 240 }}>
            {JSON.stringify(
              {
                query: { modeFromQP, rawBookingKey, normalizedBookingId: bookingKey.id, roomId: sessionRoomId },
                user: { email: userEmail, role: lockedRole, profileName, identity: myIdentity },
                notes: error ? { error } : {},
              },
              null,
              2
            )}
          </pre>
          <div style={{ height: 8 }} />
          <div style={{ color: "#9bd", fontWeight: 600, marginBottom: 6 }}>Event log ({debug.length})</div>
          <div style={{ maxHeight: 280, overflowY: "auto", borderTop: "1px dashed #345", paddingTop: 8 }}>
            {debug.slice(-200).map((d, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ color: "#7fbfff" }}>
                  {d.t} — <span style={{ color: "#aef" }}>{d.tag}</span>
                </div>
                {d.data !== undefined && (
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowX: "auto" }}>
                    {JSON.stringify(d.data, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MAIN: feeds + board */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "row",
          gap: 16,
          overflow: "hidden",
        }}
      >
        {/* LEFT: FEEDS */}
        <div
          ref={videoColumnRef}
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            width: `${tileSize.w + 4}px`,
            maxWidth: `${tileSize.w + 4}px`,
            minWidth: `${tileSize.w + 4}px`,
            overflow: "hidden",
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: "100%",
              flex: "1 1 auto",
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          />
        </div>

        {/* RIGHT: WHITEBOARD */}
        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 0,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            backgroundColor: "#111",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              padding: "8px 12px",
              fontSize: 13,
              lineHeight: 1.2,
              color: "#fff",
              background: "rgba(255,255,255,0.06)",
              borderBottom: "1px solid rgba(255,255,255,0.15)",
              flexWrap: "wrap",
              rowGap: "8px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 600, color: "#fff" }}>Whiteboard</span>
              <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, lineHeight: 1.2 }}>
                Viewing: {viewBoardFor || "—"}
              </span>
              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, lineHeight: 1.2 }}>
                {canCurrentUserEditBoard() ? "You can draw" : "Read only"}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                color: "#fff",
                fontSize: 12,
                lineHeight: 1.2,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: canCurrentUserEditBoard() ? 1 : 0.4 }}>
                {["#ffffff", "#ffe066", "#ff6b6b", "#4dabf7", "#51cf66"].map((col) => (
                  <div
                    key={col}
                    onClick={() => {
                      if (!canCurrentUserEditBoard()) return;
                      setTool("pen");
                      setStrokeColor(col);
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      backgroundColor: col,
                      border: strokeColor === col && tool === "pen" ? "2px solid #6ecf9a" : "2px solid #444",
                      cursor: canCurrentUserEditBoard() ? "pointer" : "default",
                    }}
                    title={`Color ${col}`}
                  />
                ))}
              </div>

              <div style={{ display: "flex", gap: 6, opacity: canCurrentUserEditBoard() ? 1 : 0.4 }}>
                <button
                  onClick={() => {
                    if (!canCurrentUserEditBoard()) return;
                    setTool("pen");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    background: tool === "pen" && canCurrentUserEditBoard() ? "#3a6" : "#2a2a2a",
                    border: tool === "pen" && canCurrentUserEditBoard() ? "1px solid #6ecf9a" : "1px solid #444",
                    color: "#fff",
                    fontSize: 12,
                    lineHeight: 1.2,
                    cursor: canCurrentUserEditBoard() ? "pointer" : "default",
                    minWidth: 60,
                  }}
                >
                  Pen
                </button>

                <button
                  onClick={() => {
                    if (!canCurrentUserEditBoard()) return;
                    setTool("eraser");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    background: tool === "eraser" && canCurrentUserEditBoard() ? "#3a6" : "#2a2a2a",
                    border: tool === "eraser" && canCurrentUserEditBoard() ? "1px solid #6ecf9a" : "1px solid #444",
                    color: "#fff",
                    fontSize: 12,
                    lineHeight: 1.2,
                    cursor: canCurrentUserEditBoard() ? "pointer" : "default",
                    minWidth: 60,
                  }}
                >
                  Eraser
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#fff",
                  opacity: canCurrentUserEditBoard() ? 1 : 0.4,
                }}
                title="Brush size"
              >
                <span style={{ fontSize: 11 }}>Size</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={strokeSize}
                  onChange={(e) => {
                    if (!canCurrentUserEditBoard()) return;
                    const v = parseInt(e.target.value, 10);
                    setStrokeSize(v);
                  }}
                  style={{ width: 80, cursor: canCurrentUserEditBoard() ? "pointer" : "default" }}
                />
                <span style={{ minWidth: 24, textAlign: "right", fontSize: 11, opacity: 0.8 }}>{strokeSize}</span>
              </div>

              <button
                onClick={async () => {
                  if (!canCurrentUserEditBoard()) return;
                  await clearViewedBoard();
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: canCurrentUserEditBoard() ? "#a33" : "#2a2a2a",
                  border: canCurrentUserEditBoard() ? "1px solid #ff8b8b" : "1px solid #444",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: 1.2,
                  cursor: canCurrentUserEditBoard() ? "pointer" : "default",
                  minWidth: 70,
                }}
              >
                Clear all
              </button>
            </div>
          </div>

          <div
            ref={wbContainerRef}
            style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, position: "relative", backgroundColor: "#111" }}
          >
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                touchAction: "none",
                cursor: canCurrentUserEditBoard() ? (tool === "eraser" ? "cell" : "crosshair") : "default",
              }}
              onPointerDown={startDraw}
              onPointerMove={moveDraw}
              onPointerUp={endDraw}
              onPointerLeave={endDraw}
            />
          </div>
        </div>
      </div>

      {/* mic/cam quick buttons */}
      <div
        style={{
          position: "absolute",
          left: 24,
          bottom: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          color: "#fff",
          zIndex: 10,
        }}
      >
        {lockedRole !== "admin" && !camOn && (
          <button onClick={turnCameraOn} style={ghostButtonStyle}>
            Turn Camera On
          </button>
        )}
        {lockedRole !== "admin" && !micOn && (
          <button onClick={turnMicOn} style={ghostButtonStyle}>
            Mic On
          </button>
        )}
      </div>
    </main>
  );
}

const ghostButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.2,
  cursor: "pointer",
  minWidth: 80,
  textAlign: "center",
};
