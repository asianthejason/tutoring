// src/app/tutors/page.tsx
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  collection,
  onSnapshot,
  query,
  where,
  DocumentData,
  Timestamp,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  serverTimestamp,
  getDocs,
} from "firebase/firestore";

type Role = "student" | "tutor" | "admin";
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type TimeRange = { start: string; end: string }; // "HH:mm"
type Availability = Record<DayKey, TimeRange[]>;

type TutorRow = {
  uid: string;
  displayName: string;
  email: string;
  roomId: string;
  statusRaw: "waiting" | "busy" | "offline" | string;
  subjects: string[];
  lastActiveAt?: number; // ms epoch
};

type TutorDoc = {
  displayName?: string;
  email?: string;
  roomId?: string;
  availability?: Availability;
  timezone?: string;
};

type Booking = {
  id: string;
  tutorId: string;
  tutorName?: string;
  tutorEmail?: string;
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  startTime: number; // ms
  durationMin: number; // always 60 here
  roomId?: string;
  createdAt?: any;
};

// consider rows stale after 90s and hide them
const STALE_MS = 90_000;
const DAYS: { key: DayKey; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

/** Normalize Firestore timestamp-ish values into a ms epoch number */
function tsToMs(v: unknown): number | undefined {
  if (!v) return undefined;
  if (v instanceof Timestamp) return v.toMillis();
  if (
    typeof v === "object" &&
    v !== null &&
    "seconds" in (v as any) &&
    typeof (v as any).seconds === "number"
  ) {
    return (v as any).seconds * 1000;
  }
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 10_000_000_000) return n;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return undefined;
}

/** status -> UI label */
function deriveStatusLabel(t: TutorRow) {
  const s = (t.statusRaw || "offline") as "waiting" | "busy" | "offline";
  return {
    label: s === "waiting" ? "Waiting" : s === "busy" ? "Busy" : "Offline",
    online: s !== "offline",
    busy: s === "busy",
  };
}

/** Monday 00:00 of the week containing date `d` (local) */
function startOfWeek(d: Date) {
  const copy = new Date(d);
  const day = copy.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // move to Monday
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Add days to a date (does not mutate input) */
function addDays(d: Date, days: number) {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

/** "HH:mm" -> minutes from midnight */
function hmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** Clamp to 60-min slots on the hour within [start,end) */
function generateHourStarts(startHHMM: string, endHHMM: string): number[] {
  const s = hmToMinutes(startHHMM);
  const e = hmToMinutes(endHHMM);
  const first = Math.ceil(s / 60) * 60;
  const lastStart = e - 60;
  const out: number[] = [];
  for (let m = first; m <= lastStart; m += 60) out.push(m);
  return out;
}

/** format time in a specific timezone (falls back to local) */
function fmtTime(ms: number, tz?: string) {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  try {
    return new Intl.DateTimeFormat(undefined, tz ? { ...opts, timeZone: tz } : opts).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(ms);
  }
}

/** Build a Date at local timezone from y/m/d and minutes since midnight */
function dateAtLocal(y: number, m: number, d: number, minutes: number) {
  const dt = new Date(y, m, d, Math.floor(minutes / 60), minutes % 60, 0, 0);
  return dt;
}

export default function TutorsLobbyPage() {
  const router = useRouter();
  const [tutors, setTutors] = useState<TutorRow[]>([]);
  const [loading, setLoading] = useState(true);

  // modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTutorId, setActiveTutorId] = useState<string | null>(null);
  const [activeTutor, setActiveTutor] = useState<(TutorDoc & { uid: string }) | null>(null);
  const [activeWeekStart, setActiveWeekStart] = useState<Date>(startOfWeek(new Date()));
  const [bookedStarts, setBookedStarts] = useState<number[]>([]); // ms startTimes for active tutor in visible week
  const [bookingBusy, setBookingBusy] = useState(false);
  const [bookingMsg, setBookingMsg] = useState("");

  // Subscribe to all tutors
  useEffect(() => {
    const qRef = query(collection(db, "users"), where("role", "==", "tutor"));

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const now = Date.now();
        const base: TutorRow[] = [];

        snap.forEach((d) => {
          const data = d.data() as DocumentData;

          const item: TutorRow = {
            uid: d.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            statusRaw: (data.status as any) || "offline",
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
            lastActiveAt: tsToMs(data.lastActiveAt),
          };

          const fresh =
            typeof item.lastActiveAt === "number" && now - item.lastActiveAt < STALE_MS;

          if (fresh) base.push(item);
        });

        const ranked = base.slice().sort((a, b) => {
          const sa = deriveStatusLabel(a);
          const sb = deriveStatusLabel(b);
          const rank = (s: ReturnType<typeof deriveStatusLabel>) =>
            s.label === "Waiting" ? 0 : s.label === "Busy" ? 1 : 2;
          const ra = rank(sa);
          const rb = rank(sb);
          if (ra !== rb) return ra - rb;
          return (a.displayName || "").localeCompare(b.displayName || "");
        });

        setTutors(ranked);
        setLoading(false);
      },
      (err) => {
        console.error("[/tutors] onSnapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, []);

  // Open modal for a tutor (load availability + timezone + bookings for week)
  const openTutorModal = useCallback(async (tutorId: string) => {
    setBookingMsg("");
    setActiveTutorId(tutorId);
    setModalOpen(true);

    // fetch full tutor doc
    const docSnap = await getDoc(doc(db, "users", tutorId));
    const data = (docSnap.exists() ? (docSnap.data() as TutorDoc) : {}) as TutorDoc;
    const td: TutorDoc & { uid: string } = {
      uid: tutorId,
      displayName: data.displayName || "Tutor",
      email: data.email || "",
      roomId: data.roomId || "",
      availability: (data.availability as Availability) || {
        mon: [],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
      timezone: data.timezone || undefined,
    };
    setActiveTutor(td);

    // load booked starts for visible week
    const weekStart = startOfWeek(new Date());
    await loadBookedSlots(tutorId, weekStart);
    setActiveWeekStart(weekStart);
  }, []);

  // Load already-booked startTime values for given week (for the active tutor)
  const loadBookedSlots = useCallback(async (tutorId: string, weekStart: Date) => {
    const weekEnd = addDays(weekStart, 7);
    // naive range query on startTime; filter client-side on tutorId (or add composite index if needed)
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", tutorId));
    const snap = await getDocs(qRef);
    const list: number[] = [];
    snap.forEach((ds) => {
      const d = ds.data() as any;
      const st = Number(d.startTime || 0);
      if (st >= +weekStart && st < +weekEnd) list.push(st);
    });
    setBookedStarts(list);
  }, []);

  // Week navigation
  const goPrevWeek = useCallback(async () => {
    if (!activeTutorId) return;
    const prev = addDays(activeWeekStart, -7);
    setActiveWeekStart(prev);
    await loadBookedSlots(activeTutorId, prev);
  }, [activeWeekStart, activeTutorId, loadBookedSlots]);

  const goNextWeek = useCallback(async () => {
    if (!activeTutorId) return;
    const next = addDays(activeWeekStart, 7);
    setActiveWeekStart(next);
    await loadBookedSlots(activeTutorId, next);
  }, [activeWeekStart, activeTutorId, loadBookedSlots]);

  // Build calendar slots (1h) from availability for the visible week
  const calendarColumns = useMemo(() => {
    if (!activeTutor) return [];
    const tz = activeTutor.timezone;
    const avail = activeTutor.availability || {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    const cols: {
      key: DayKey;
      label: string;
      date: Date;
      slots: { startMs: number; label: string; disabled: boolean }[];
    }[] = [];

    const now = Date.now();

    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(activeWeekStart, i);
      const dow = (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
        dayDate.getDay()
      ] || "mon") as DayKey;
      const key = dow;
      const label = DAYS.find((d) => d.key === key)?.label || "Day";
      const Y = dayDate.getFullYear();
      const M = dayDate.getMonth(); // 0-based
      const D = dayDate.getDate();

      const slots: { startMs: number; label: string; disabled: boolean }[] = [];

      for (const rng of avail[key] || []) {
        const starts = generateHourStarts(rng.start, rng.end);
        for (const mins of starts) {
          // Build local date at student's local tz; for most users (incl. you) this matches tutor tz
          const dt = dateAtLocal(Y, M, D, mins);
          const ms = +dt;
          const taken = bookedStarts.includes(ms);
          const past = ms <= now;
          const disabled = taken || past;
          const labelSlot = fmtTime(ms, tz);
          slots.push({ startMs: ms, label: labelSlot, disabled });
        }
      }

      // sort by ms
      slots.sort((a, b) => a.startMs - b.startMs);

      cols.push({ key, label, date: dayDate, slots });
    }

    return cols;
  }, [activeTutor, activeWeekStart, bookedStarts]);

  // Create 1-hour booking at a given start time
  const bookSlot = useCallback(
    async (slotStartMs: number) => {
      setBookingMsg("");
      setBookingBusy(true);
      try {
        const user = auth.currentUser;
        if (!user) {
          setBookingMsg("Please sign in as a student to book.");
          setBookingBusy(false);
          return;
        }
        // get student profile for name/email
        const stuDoc = await getDoc(doc(db, "users", user.uid));
        const stuData = (stuDoc.exists() ? stuDoc.data() : {}) as any;
        const role = (stuData.role as Role) || "student";
        if (role !== "student") {
          setBookingMsg("Only student accounts can book a session.");
          setBookingBusy(false);
          return;
        }

        if (!activeTutor) {
          setBookingMsg("No tutor selected.");
          setBookingBusy(false);
          return;
        }

        const durationMin = 60;
        const bookingId = `${activeTutor.uid}_${slotStartMs}`;
        const bookingRef = doc(db, "bookings", bookingId);

        // Prevent double-booking using a transaction (fail if doc already exists)
        await runTransaction(db, async (tx) => {
          const existing = await tx.get(bookingRef);
          if (existing.exists()) {
            throw new Error("That time has just been booked by someone else.");
          }
          // Minimal overlap guard: ensure no other booking by same tutor at same minute
          // (your dashboards list bookings by tutorId; this ID strategy is strict per-start)
          tx.set(bookingRef, {
            tutorId: activeTutor.uid,
            tutorName: activeTutor.displayName || "Tutor",
            tutorEmail: activeTutor.email || "",
            studentId: user.uid,
            studentName:
              stuData.displayName ||
              `${(stuData.firstName || "").trim()} ${(stuData.lastName || "").trim()}`.trim() ||
              user.email?.split("@")[0] ||
              "Student",
            studentEmail: user.email || "",
            startTime: slotStartMs,
            durationMin,
            roomId: activeTutor.roomId || "",
            createdAt: serverTimestamp(),
          } as Booking);
        });

        setBookingMsg("Booked ✓ This will appear on both dashboards.");
        // Refresh booked slots in modal
        if (activeTutorId) {
          await loadBookedSlots(activeTutorId, activeWeekStart);
        }
      } catch (err: any) {
        console.error("[bookSlot]", err);
        setBookingMsg(err?.message || "Could not book this slot.");
      } finally {
        setBookingBusy(false);
        setTimeout(() => setBookingMsg(""), 2500);
      }
    },
    [activeTutor, activeTutorId, activeWeekStart, loadBookedSlots]
  );

  // Cards (kept from your original with a “View Availability” button)
  const cards = useMemo(() => {
    return tutors.map((t) => {
      const d = deriveStatusLabel(t);
      const canJoin = d.online && !d.busy && Boolean(t.roomId); // instant join if Waiting

      const chip =
        d.label === "Waiting"
          ? { bg: "#163b24", border: "#3a6", text: "#6ecf9a", label: "Waiting" }
          : d.label === "Busy"
          ? { bg: "#3b2f16", border: "#d4a23c", text: "#ffd277", label: "Busy" }
          : { bg: "#442424", border: "#a66", text: "#ff8b8b", label: "Offline" };

      return (
        <div
          key={t.uid}
          style={{
            borderRadius: 12,
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
            padding: "16px 16px 14px",
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 170,
          }}
        >
          {/* header row */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              rowGap: 8,
              alignItems: "flex-start",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#fff",
                  letterSpacing: "-0.03em",
                }}
              >
                {t.displayName || "Tutor"}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.6)",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                  maxWidth: 260,
                }}
              >
                {t.email}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div
                style={{
                  backgroundColor: chip.bg,
                  border: `1px solid ${chip.border}`,
                  color: chip.text,
                  fontSize: 12,
                  lineHeight: 1.2,
                  padding: "6px 10px",
                  borderRadius: 8,
                  minWidth: 70,
                  textAlign: "center",
                  fontWeight: 500,
                }}
                title={
                  typeof t.lastActiveAt === "number"
                    ? `Last active ${new Date(t.lastActiveAt).toLocaleTimeString()}`
                    : "No recent heartbeat"
                }
              >
                {chip.label}
              </div>
            </div>
          </div>

          {/* subjects */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.75)",
              minHeight: 32,
            }}
          >
            {t.subjects?.length ? (
              <>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>Can help with:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {t.subjects.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        backgroundColor: "#2a2a2a",
                        border: "1px solid #444",
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: 1.2,
                        padding: "4px 8px",
                        color: "#fff",
                      }}
                    >
                      {s}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.6 }}>Subjects not listed yet.</div>
            )}
          </div>

          {/* actions */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              disabled={!t.roomId}
              onClick={() => {
                if (!t.roomId) return;
                router.push(`/room?roomId=${encodeURIComponent(t.roomId)}`);
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: canJoin ? "#3a6" : "#2a2a2a",
                border: canJoin ? "1px solid #6ecf9a" : "1px solid #444",
                color: "#fff",
                fontSize: 14,
                lineHeight: 1.2,
                fontWeight: 500,
                cursor: canJoin ? "pointer" : "not-allowed",
                minWidth: 120,
                textAlign: "center",
              }}
              title={
                !t.roomId
                  ? "Tutor does not have a room configured"
                  : canJoin
                  ? "Enter this tutor’s room"
                  : deriveStatusLabel(t).label === "Busy"
                  ? "They’re helping someone—use queue on the dashboard"
                  : "Tutor is offline right now"
              }
            >
              {canJoin ? "Join Room" : deriveStatusLabel(t).label === "Busy" ? "Join Queue" : "Join (offline)"}
            </button>

            <button
              onClick={() => openTutorModal(t.uid)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: "#1f2937",
                border: "1px solid #3b3b3b",
                color: "#fff",
                fontSize: 14,
                lineHeight: 1.2,
                fontWeight: 500,
                cursor: "pointer",
              }}
              title="See weekly availability and book a 1-hour session"
            >
              View Availability
            </button>
          </div>
        </div>
      );
    });
  }, [tutors, router, openTutorModal]);

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100vw",
        backgroundColor: "#0f0f0f",
        backgroundImage:
          "radial-gradient(circle at 20% 20%, rgba(77,177,255,0.12) 0%, rgba(0,0,0,0) 70%), radial-gradient(circle at 80% 30%, rgba(80,255,150,0.08) 0%, rgba(0,0,0,0) 60%)",
        backgroundRepeat: "no-repeat",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* header */}
      <header
        style={{
          width: "100%",
          maxWidth: 1280,
          margin: "0 auto",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          borderRadius: 12,
          background: "linear-gradient(to right, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
        }}
      >
        <div style={{ color: "#fff", display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Calgary Math Specialists</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            style={{
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
            }}
            onClick={() => router.push("/")}
          >
            ← Home
          </button>
        </div>
      </header>

      {/* body */}
      <section
        style={{
          flex: "1 1 auto",
          width: "100%",
          maxWidth: 1280,
          margin: "24px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", color: "#fff", maxWidth: 800, lineHeight: 1.3 }}>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em", color: "#fff" }}>
            Get live math help
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.8, color: "#fff", marginTop: 8 }}>
            Pick a tutor below. If they’re <b>Waiting</b>, you’ll join their 1-on-1 room instantly.
            If they’re <b>Busy</b>, you’ll be placed in queue and they’ll pull you in next. For scheduled sessions,
            click <b>View Availability</b> to book a 1-hour appointment.
          </div>
        </div>

        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px,100%),1fr))",
            gap: 16,
          }}
        >
          {loading ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, color: "#fff", opacity: 0.7 }}>
              Loading tutors…
            </div>
          ) : tutors.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, color: "#fff", opacity: 0.7 }}>
              No tutors live right now. Check back soon.
            </div>
          ) : (
            cards
          )}
        </div>
      </section>

      {/* footer */}
      <footer
        style={{
          flex: "0 0 auto",
          width: "100%",
          maxWidth: 1280,
          margin: "32px auto 0",
          padding: "16px 24px 0",
          color: "rgba(255,255,255,0.5)",
          fontSize: 12,
          lineHeight: 1.4,
          textAlign: "center",
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginBottom: 6 }}>
          Need math help tonight?
        </div>
        <div style={{ marginBottom: 12 }}>
          Join a <b>Waiting</b> tutor’s room to get started right away.
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
          © {new Date().getFullYear()} Apex Tutoring · Calgary, AB
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.4)", paddingBottom: 16 }}>
          Online math tutoring for grades 4–12
        </div>
      </footer>

      {/* Availability Modal */}
      {modalOpen && activeTutor && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => {
            setModalOpen(false);
            setActiveTutorId(null);
            setActiveTutor(null);
            setBookedStarts([]);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(1080px, 96vw)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(20,20,20,0.6) 100%)",
              boxShadow: "0 40px 120px rgba(0,0,0,0.8)",
              color: "#fff",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* modal header */}
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid rgba(255,255,255,0.12)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {activeTutor.displayName || "Tutor"} — Book a 1-hour session
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Times shown in {activeTutor.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={goPrevWeek}
                  style={navButtonStyle}
                  title="Previous week"
                >
                  ← Prev
                </button>
                <div
                  style={{
                    padding: "8px 10px",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                    fontSize: 12,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  Week of{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  }).format(activeWeekStart)}
                </div>
                <button
                  onClick={goNextWeek}
                  style={navButtonStyle}
                  title="Next week"
                >
                  Next →
                </button>
                <button
                  onClick={() => {
                    const now = startOfWeek(new Date());
                    setActiveWeekStart(now);
                    if (activeTutorId) loadBookedSlots(activeTutorId, now);
                  }}
                  style={navButtonStyle}
                  title="Jump to current week"
                >
                  Today
                </button>
              </div>

              <button
                onClick={() => {
                  setModalOpen(false);
                  setActiveTutorId(null);
                  setActiveTutor(null);
                  setBookedStarts([]);
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#fff",
                  cursor: "pointer",
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* calendar */}
            <div
              style={{
                padding: 16,
                overflow: "auto",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
                  gap: 12,
                  minWidth: 720,
                }}
              >
                {calendarColumns.map((col) => (
                  <div
                    key={col.key + +col.date}
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 10,
                      padding: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      minHeight: 180,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {col.label} {col.date.getMonth() + 1}/{col.date.getDate()}
                    </div>

                    {col.slots.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.6 }}>No availability</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {col.slots.map((s) => (
                          <button
                            key={s.startMs}
                            disabled={s.disabled || bookingBusy}
                            onClick={() => bookSlot(s.startMs)}
                            style={{
                              padding: "8px 8px",
                              borderRadius: 8,
                              textAlign: "left",
                              border: s.disabled
                                ? "1px solid rgba(255,255,255,0.15)"
                                : "1px solid #4ade80",
                              background: s.disabled
                                ? "rgba(255,255,255,0.05)"
                                : "linear-gradient(180deg, rgba(34,197,94,0.25), rgba(34,197,94,0.15))",
                              color: s.disabled ? "rgba(255,255,255,0.6)" : "#eafff0",
                              cursor: s.disabled ? "not-allowed" : "pointer",
                              fontSize: 12,
                              lineHeight: 1.2,
                            }}
                            title={s.disabled ? "Unavailable" : "Book this 1-hour slot"}
                          >
                            {s.label}
                            {bookedStarts.includes(s.startMs) ? " — Booked" : ""}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* modal footer */}
            <div
              style={{
                padding: "10px 16px",
                borderTop: "1px solid rgba(255,255,255,0.12)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: 12, color: bookingMsg ? "#a7f3d0" : "rgba(255,255,255,0.6)" }}>
                {bookingMsg || "Select a green time to book a 1-hour session."}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  Bookings appear on your dashboard and the tutor’s dashboard.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// small styles
const navButtonStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  background: "#1f2937",
  border: "1px solid #3b3b3b",
  color: "#fff",
  fontSize: 12,
  lineHeight: 1.2,
  cursor: "pointer",
};
