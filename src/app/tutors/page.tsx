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
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  deleteDoc,
  orderBy,
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
  timezone?: string; // tutor's own timezone
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
  durationMin: number;
  endTime?: number; // ms (derived)
  roomId?: string;
  createdAt?: any;
};

type StudentPrefs = {
  timezone?: string; // student's selected timezone preference
  preferredTimezone?: string; // alt key if used elsewhere
};

// --- helpers -------------------------------------------------------------

/** Normalize Firestore timestamp-ish values into a ms epoch number */
function tsToMs(v: unknown): number | undefined {
  if (!v) return undefined;
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === "object" && v !== null && "seconds" in (v as any)) {
    const s = (v as any).seconds;
    if (typeof s === "number") return s * 1000;
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

function deriveStatusLabel(t: TutorRow) {
  const s = (t.statusRaw || "offline") as "waiting" | "busy" | "offline";
  return {
    label: s === "waiting" ? "Waiting" : s === "busy" ? "Busy" : "Offline",
    online: s !== "offline",
    busy: s === "busy",
  };
}

const DAYS: { key: DayKey; label: string; idx: number }[] = [
  { key: "mon", label: "Mon", idx: 1 },
  { key: "tue", label: "Tue", idx: 2 },
  { key: "wed", label: "Wed", idx: 3 },
  { key: "thu", label: "Thu", idx: 4 },
  { key: "fri", label: "Fri", idx: 5 },
  { key: "sat", label: "Sat", idx: 6 },
  { key: "sun", label: "Sun", idx: 0 },
];

function startOfWeek(d: Date) {
  const copy = new Date(d);
  const day = copy.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // to Monday
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, days: number) {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

function hmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function minutesToHM(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Convert "wall time in timeZone" (y,m,d,h,min) to a real UTC Date using Intl trick
function zonedDateFromParts(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  // Build an "intended" UTC date with those parts
  const utcDate = new Date(Date.UTC(y, m, d, h, min));
  // Convert that instant into the same wall time in the target tz
  const asInTz = new Date(utcDate.toLocaleString("en-US", { timeZone }));
  // The difference tells us the tz shift for that wall time
  const diff = utcDate.getTime() - asInTz.getTime();
  // Apply the difference so the result represents the intended wall-time in the target tz
  return new Date(utcDate.getTime() - diff);
}

function fmtInTZ(ms: number, tz?: string) {
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

function getStudentSelectedTZ(stu: StudentPrefs | undefined): string {
  return (
    (stu?.timezone && typeof stu.timezone === "string" && stu.timezone) ||
    (stu?.preferredTimezone && typeof stu.preferredTimezone === "string" && stu.preferredTimezone) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

const ONE_HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * ONE_HOUR;

// --- main component ------------------------------------------------------

export default function TutorsLobbyPage() {
  const router = useRouter();
  const [tutors, setTutors] = useState<TutorRow[]>([]);
  const [loading, setLoading] = useState(true);

  // modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTutor, setActiveTutor] = useState<(TutorDoc & { uid: string }) | null>(null);
  const [activeWeekStart, setActiveWeekStart] = useState<Date>(startOfWeek(new Date()));

  // bookings/conflicts
  const [bookedThisWeek, setBookedThisWeek] = useState<Booking[]>([]);
  const [myUpcomingWithTutor, setMyUpcomingWithTutor] = useState<Booking[]>([]);

  // student prefs
  const [studentPrefs, setStudentPrefs] = useState<StudentPrefs | undefined>(undefined);
  const studentTZ = getStudentSelectedTZ(studentPrefs);

  // booking form state
  const [formVisible, setFormVisible] = useState(false);
  const [formDate, setFormDate] = useState<Date | null>(null);
  const [formStartHM, setFormStartHM] = useState("18:00");
  const [formDuration, setFormDuration] = useState<number>(60);
  const [formRepeatCount, setFormRepeatCount] = useState<number>(0); // number of additional weekly repeats (0..12)
  const [formBusy, setFormBusy] = useState(false);
  const [toast, setToast] = useState("");

  // ----------------------------------------------------------------------
  // 1) Load ALL tutors (no freshness filter)
  useEffect(() => {
    const qRef = query(collection(db, "users"), where("role", "==", "tutor"));
    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const base: TutorRow[] = [];
        snap.forEach((d) => {
          const data = d.data() as DocumentData;
          base.push({
            uid: d.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            statusRaw: (data.status as any) || "offline",
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
            lastActiveAt: tsToMs(data.lastActiveAt),
          });
        });
        // Sort: Waiting, Busy, Offline; then by name
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

  // ----------------------------------------------------------------------
  // 2) Open modal: fetch tutor doc, student prefs, bookings
  const openTutorModal = useCallback(async (tutorId: string) => {
    setToast("");
    setFormVisible(false);
    setFormRepeatCount(0);
    setFormDuration(60);
    setFormStartHM("18:00");
    setActiveWeekStart(startOfWeek(new Date()));

    // Tutor details
    const tSnap = await getDoc(doc(db, "users", tutorId));
    const tData = (tSnap.exists() ? (tSnap.data() as TutorDoc) : {}) as TutorDoc;
    const tutor: TutorDoc & { uid: string } = {
      uid: tutorId,
      displayName: tData.displayName || "Tutor",
      email: tData.email || "",
      roomId: tData.roomId || "",
      availability: (tData.availability as Availability) || {
        mon: [],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
      timezone: tData.timezone || undefined,
    };
    setActiveTutor(tutor);

    // Student prefs/timezone
    const user = auth.currentUser;
    if (user) {
      const sSnap = await getDoc(doc(db, "users", user.uid));
      const sData = (sSnap.exists() ? (sSnap.data() as StudentPrefs) : undefined) as StudentPrefs | undefined;
      setStudentPrefs(sData);
    } else {
      setStudentPrefs(undefined);
    }

    // Load bookings for visible week (for conflicts)
    await refreshWeekBookings(tutorId, startOfWeek(new Date()));

    // Load student's upcoming bookings with this tutor (for cancel UI)
    await refreshMyUpcomingWithTutor(tutorId);

    setModalOpen(true);
  }, []);

  const refreshWeekBookings = useCallback(async (tutorId: string, weekStart: Date) => {
    const weekEnd = addDays(weekStart, 7).getTime();
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", tutorId));
    const snap = await getDocs(qRef);
    const rows: Booking[] = [];
    snap.forEach((ds) => {
      const d = ds.data() as any;
      const st = Number(d.startTime || 0);
      const et = Number(d.endTime || (st + (Number(d.durationMin || 60) * 60000)));
      if (st < weekEnd && et >= +weekStart) {
        rows.push({
          id: ds.id,
          tutorId: d.tutorId,
          studentId: d.studentId,
          startTime: st,
          durationMin: d.durationMin || 60,
          endTime: et,
          tutorName: d.tutorName,
          tutorEmail: d.tutorEmail,
          studentName: d.studentName,
          studentEmail: d.studentEmail,
          roomId: d.roomId,
          createdAt: d.createdAt,
        });
      }
    });
    setBookedThisWeek(rows);
  }, []);

  const refreshMyUpcomingWithTutor = useCallback(async (tutorId: string) => {
    const user = auth.currentUser;
    if (!user) {
      setMyUpcomingWithTutor([]);
      return;
    }
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", tutorId));
    const snap = await getDocs(qRef);
    const now = Date.now();
    const mine: Booking[] = [];
    snap.forEach((ds) => {
      const d = ds.data() as any;
      if (d.studentId === user.uid && Number(d.startTime || 0) >= now) {
        const st = Number(d.startTime);
        const dur = Number(d.durationMin || 60);
        mine.push({
          id: ds.id,
          tutorId: d.tutorId,
          studentId: d.studentId,
          startTime: st,
          durationMin: dur,
          endTime: st + dur * 60000,
          tutorName: d.tutorName,
          studentName: d.studentName,
          studentEmail: d.studentEmail,
          roomId: d.roomId,
        });
      }
    });
    // sort by soonest
    mine.sort((a, b) => a.startTime - b.startTime);
    setMyUpcomingWithTutor(mine);
  }, []);

  // ----------------------------------------------------------------------
  // 3) Week navigation
  const goPrevWeek = useCallback(async () => {
    if (!activeTutor) return;
    const prev = addDays(activeWeekStart, -7);
    setActiveWeekStart(prev);
    await refreshWeekBookings(activeTutor.uid, prev);
  }, [activeTutor, activeWeekStart, refreshWeekBookings]);

  const goNextWeek = useCallback(async () => {
    if (!activeTutor) return;
    const next = addDays(activeWeekStart, 7);
    setActiveWeekStart(next);
    await refreshWeekBookings(activeTutor.uid, next);
  }, [activeTutor, activeWeekStart, refreshWeekBookings]);

  const jumpToThisWeek = useCallback(async () => {
    if (!activeTutor) return;
    const now = startOfWeek(new Date());
    setActiveWeekStart(now);
    await refreshWeekBookings(activeTutor.uid, now);
  }, [activeTutor, refreshWeekBookings]);

  // ----------------------------------------------------------------------
  // 4) Build availability grid (converted to student's timezone for labels)
  type SlotBlock = {
    label: string;           // e.g., "Mon 5:00 PM–8:00 PM"
    dayDate: Date;           // actual date (student tz display)
    ranges: { startMs: number; endMs: number }[]; // absolute instants covering tutor availability on that day
  };

  const slotBlocks: SlotBlock[] = useMemo(() => {
    if (!activeTutor) return [];
    const tutorTZ = activeTutor.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const week: SlotBlock[] = [];

    for (let i = 0; i < 7; i++) {
      const dayDateLocal = addDays(activeWeekStart, i); // anchor date (Mon..Sun) in local clock (used only for calendar date number)
      const jsDow = dayDateLocal.getDay(); // 0=Sun..6=Sat
      const dayKey = DAYS.find((d) => d.idx === (jsDow === 0 ? 7 : jsDow))?.key || (["sun","mon","tue","wed","thu","fri","sat"][jsDow] as DayKey);

      // Ensure we map correctly: build by the canonical map:
      const key: DayKey = (["sun","mon","tue","wed","thu","fri","sat"][jsDow] === "sun" ? "sun" :
        (["sun","mon","tue","wed","thu","fri","sat"][jsDow] as DayKey));

      const ranges = (activeTutor.availability?.[key] || []) as TimeRange[];

      const absRanges: { startMs: number; endMs: number }[] = [];

      for (const r of ranges) {
        const minsS = hmToMinutes(r.start);
        const minsE = hmToMinutes(r.end);
        if (minsE <= minsS) continue;

        // Build the absolute UTC instants corresponding to the TUTOR'S wall time on this calendar day
        const y = dayDateLocal.getFullYear();
        const m = dayDateLocal.getMonth();
        const d = dayDateLocal.getDate();

        const sDate = zonedDateFromParts(y, m, d, Math.floor(minsS / 60), minsS % 60, tutorTZ);
        const eDate = zonedDateFromParts(y, m, d, Math.floor(minsE / 60), minsE % 60, tutorTZ);

        absRanges.push({ startMs: +sDate, endMs: +eDate });
      }

      // Build a user-facing label in the STUDENT tz for the first range (and include count if multiple)
      let label = `${new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: studentTZ,
      }).format(+dayDateLocal)}`;

      if (absRanges.length) {
        const first = absRanges[0];
        label += ` ${new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: studentTZ,
        }).format(first.startMs)}–${new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: studentTZ,
        }).format(first.endMs)}`;
        if (absRanges.length > 1) label += ` (+${absRanges.length - 1} more)`;
      } else {
        label += ` — no availability`;
      }

      week.push({
        label,
        dayDate: dayDateLocal,
        ranges: absRanges.sort((a, b) => a.startMs - b.startMs),
      });
    }

    return week;
  }, [activeTutor, activeWeekStart, studentTZ]);

  // ----------------------------------------------------------------------
  // 5) Booking form handling: ensure chosen start/duration fits into any available range & no conflict
  function findContainingRange(msStart: number, msEnd: number, ranges: { startMs: number; endMs: number }[]) {
    return ranges.find((r) => msStart >= r.startMs && msEnd <= r.endMs);
  }

  function hasTutorConflict(msStart: number, msEnd: number): boolean {
    // Overlap if (a.start < b.end) && (a.end > b.start)
    return bookedThisWeek.some((b) => {
      const bStart = b.startTime;
      const bEnd = b.endTime || (b.startTime + b.durationMin * 60000);
      return msStart < bEnd && msEnd > bStart;
    });
  }

  const openFormForDay = useCallback((d: Date) => {
    setFormDate(d);
    // Suggest the first available hour rounded forward
    setFormStartHM("18:00");
    setFormDuration(60);
    setFormRepeatCount(0);
    setFormVisible(true);
  }, []);

  // Build valid start options (every 15 minutes) for current form day, filtered by availability & existing bookings
  const formStartOptions = useMemo(() => {
    if (!activeTutor || !formDate) return [];
    const tutorTZ = activeTutor.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayY = formDate.getFullYear();
    const dayM = formDate.getMonth();
    const dayD = formDate.getDate();

    // collect the union of all minutes available that are not conflicting (we’ll still re-check on submit)
    const opts: string[] = [];
    const step = 15; // 15-min granularity for picking a start

    const jsDow = formDate.getDay();
    const key = (["sun","mon","tue","wed","thu","fri","sat"][jsDow] as DayKey);
    const ranges = (activeTutor.availability?.[key] || []) as TimeRange[];

    for (const r of ranges) {
      const sMin = hmToMinutes(r.start);
      const eMin = hmToMinutes(r.end);
      for (let mins = sMin; mins + 30 <= eMin; mins += step) {
        // Show anything that could at least host a 30-min session; duration validation occurs on submit
        const sDate = zonedDateFromParts(dayY, dayM, dayD, Math.floor(mins / 60), mins % 60, tutorTZ);
        if (+sDate <= Date.now()) continue; // past
        const label = new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: studentTZ,
        }).format(+sDate);
        if (!opts.includes(label)) opts.push(label);
      }
    }
    return opts;
  }, [activeTutor, formDate, studentTZ]);

  // Convert student's chosen day + startHM (as displayed in studentTZ) back to an absolute instant respecting the student's tz
  function studentWallToUTC(date: Date, hm: string, tz: string): number {
    const [H, M] = hm.split(":").map((x) => parseInt(x, 10));
    const d = zonedDateFromParts(date.getFullYear(), date.getMonth(), date.getDate(), H, M, tz);
    return +d;
  }

  // Submit booking(s)
  const submitBooking = useCallback(async () => {
    if (!activeTutor || !formDate) return;
    setToast("");
    setFormBusy(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Please sign in as a student to book.");

      // load student profile
      const stuSnap = await getDoc(doc(db, "users", user.uid));
      const stuData = (stuSnap.exists() ? stuSnap.data() : {}) as any;
      const role = (stuData.role as Role) || "student";
      if (role !== "student") throw new Error("Only student accounts can book a session.");

      // compute start/end in absolute ms
      const chosenStartMs = studentWallToUTC(formDate, formStartHM, studentTZ);
      const dur = Number(formDuration || 60);
      const chosenEndMs = chosenStartMs + dur * 60000;

      // validate inside any available range (converted from tutor tz)
      const rangesForDay =
        slotBlocks.find((b) => b.dayDate.toDateString() === formDate.toDateString())?.ranges || [];
      const fitsRange = findContainingRange(chosenStartMs, chosenEndMs, rangesForDay);
      if (!fitsRange) {
        throw new Error("Selected time is outside the tutor's availability.");
      }
      if (chosenStartMs <= Date.now()) throw new Error("Selected time is in the past.");

      // check local conflicts for week view (we still guard in transactions)
      if (hasTutorConflict(chosenStartMs, chosenEndMs)) {
        throw new Error("That time conflicts with an existing booking.");
      }

      // build all occurrences (weekly repeats)
      const repeats = Math.max(0, Math.min(12, formRepeatCount || 0));
      const occurrences: { start: number; end: number }[] = [];
      for (let i = 0; i <= repeats; i++) {
        const start = chosenStartMs + i * 7 * DAY_MS;
        const end = chosenEndMs + i * 7 * DAY_MS;
        occurrences.push({ start, end });
      }

      // Write each occurrence via a transaction with strict collision check.
      for (const occ of occurrences) {
        const bookingId = `${activeTutor.uid}_${occ.start}`;
        const bookingRef = doc(db, "bookings", bookingId);
        // Per-occurrence transaction (ensures no existing at same start; also checks overlap with any booking)
        await runTransaction(db, async (tx) => {
          const existing = await tx.get(bookingRef);
          if (existing.exists()) throw new Error("This time was just booked.");

          // lightweight overlap check against any bookings starting in this 2-day window
          // (client also checked, but this defends against races across users)
          const qRef = query(collection(db, "bookings"), where("tutorId", "==", activeTutor.uid));
          const snap = await getDocs(qRef);
          snap.forEach((ds) => {
            const d = ds.data() as any;
            const st = Number(d.startTime || 0);
            const et = Number(d.endTime || (st + (Number(d.durationMin || 60) * 60000)));
            if (occ.start < et && occ.end > st) {
              throw new Error("Conflict detected with another booking.");
            }
          });

          const studentDisplayName =
            stuData.displayName ||
            `${(stuData.firstName || "").trim()} ${(stuData.lastName || "").trim()}`.trim() ||
            user.email?.split("@")[0] ||
            "Student";

          tx.set(bookingRef, {
            tutorId: activeTutor.uid,
            tutorName: activeTutor.displayName || "Tutor",
            tutorEmail: activeTutor.email || "",
            studentId: user.uid,
            studentName: studentDisplayName,
            studentEmail: user.email || "",
            startTime: occ.start,
            durationMin: dur,
            endTime: occ.end,
            roomId: activeTutor.roomId || "",
            createdAt: serverTimestamp(),
          } as Booking);
        });
      }

      setToast(
        repeats > 0
          ? `Booked ✓ ${repeats + 1} sessions (weekly). Check your dashboard.`
          : "Booked ✓ Check your dashboard."
      );

      // refresh conflicts and my upcoming
      await refreshWeekBookings(activeTutor.uid, activeWeekStart);
      await refreshMyUpcomingWithTutor(activeTutor.uid);

      // reset form
      setFormVisible(false);
    } catch (err: any) {
      console.error("[submitBooking]", err);
      setToast(err?.message || "Could not book this time.");
    } finally {
      setFormBusy(false);
      setTimeout(() => setToast(""), 3000);
    }
  }, [
    activeTutor,
    formDate,
    formStartHM,
    formDuration,
    formRepeatCount,
    studentTZ,
    slotBlocks,
    refreshWeekBookings,
    refreshMyUpcomingWithTutor,
    activeWeekStart,
  ]);

  // Cancel booking (only if ≥ 24h before start)
  const cancelBooking = useCallback(async (b: Booking) => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Please sign in.");
      if (b.studentId !== user.uid) throw new Error("You can only cancel your own sessions.");
      if (b.startTime - Date.now() < 24 * ONE_HOUR)
        throw new Error("Sessions can only be canceled at least 24 hours in advance.");

      await runTransaction(db, async (tx) => {
        const ref = doc(db, "bookings", b.id);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Booking no longer exists.");
        const d = snap.data() as any;
        if (d.studentId !== user.uid)
          throw new Error("You can only cancel your own sessions.");
        if (Number(d.startTime) - Date.now() < 24 * ONE_HOUR)
          throw new Error("Within 24 hours—cannot cancel.");
        tx.delete(ref);
      });

      setToast("Session canceled.");
      await refreshWeekBookings(activeTutor!.uid, activeWeekStart);
      await refreshMyUpcomingWithTutor(activeTutor!.uid);
    } catch (e: any) {
      setToast(e?.message || "Unable to cancel.");
    } finally {
      setTimeout(() => setToast(""), 2500);
    }
  }, [activeTutor, activeWeekStart, refreshWeekBookings, refreshMyUpcomingWithTutor]);

  // ----------------------------------------------------------------------
  // Cards
  const cards = useMemo(() => {
    return tutors.map((t) => {
      const d = deriveStatusLabel(t);
      const canJoin = d.online && !d.busy && Boolean(t.roomId);

      const chip =
        d.label === "Waiting"
          ? { bg: "#163b24", border: "#3a6", text: "#6ecf9a", label: "Waiting" }
          : d.label === "Busy"
          ? { bg: "#3b2f16", border: "#d4a23c", text: "#ffd277", label: "Busy" }
          : { bg: "#2b2b2b", border: "#555", text: "#c2c2c2", label: "Offline" };

      return (
        <div
          key={t.uid}
          style={{
            borderRadius: 12,
            background: "#141414",
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
              onClick={() => t.roomId && router.push(`/room?roomId=${encodeURIComponent(t.roomId)}`)}
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
              title="See weekly availability and book"
            >
              View Availability
            </button>
          </div>
        </div>
      );
    });
  }, [tutors, router, openTutorModal]);

  // ----------------------------------------------------------------------
  // UI

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
            Get live math & CS help
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.8, color: "#fff", marginTop: 8 }}>
            Pick a tutor below. If they’re <b>Waiting</b>, you’ll join instantly. Otherwise, you can book a scheduled
            session: choose your start time, duration, and optionally repeat weekly.
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
              No tutors found yet.
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
          Need help this week?
        </div>
        <div style={{ marginBottom: 12 }}>
          Join a <b>Waiting</b> tutor or click <b>View Availability</b> to schedule.
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
          © {new Date().getFullYear()} Apex Tutoring · Calgary, AB
        </div>
      </footer>

      {/* Availability Modal (solid backdrop + solid panel) */}
      {modalOpen && activeTutor && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.9)", // darker, less transparent
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => {
            setModalOpen(false);
            setActiveTutor(null);
            setBookedThisWeek([]);
            setMyUpcomingWithTutor([]);
            setFormVisible(false);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(1120px, 96vw)",
              maxHeight: "92vh",
              overflow: "hidden",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#111214", // solid panel background
              boxShadow: "0 40px 120px rgba(0,0,0,0.9)",
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
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {activeTutor.displayName || "Tutor"} — Availability & Booking
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Times shown in your timezone: <b>{studentTZ}</b>. (Converted from tutor’s availability.)
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={goPrevWeek} style={navButtonStyle} title="Previous week">← Prev</button>
                <div
                  style={{
                    padding: "8px 10px",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  Week of{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: studentTZ,
                  }).format(activeWeekStart)}
                </div>
                <button onClick={goNextWeek} style={navButtonStyle} title="Next week">Next →</button>
                <button onClick={jumpToThisWeek} style={navButtonStyle} title="Jump to current week">This week</button>
                <button
                  onClick={() => {
                    setModalOpen(false);
                    setActiveTutor(null);
                    setBookedThisWeek([]);
                    setMyUpcomingWithTutor([]);
                    setFormVisible(false);
                  }}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.25)",
                    background: "rgba(255,255,255,0.1)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* modal body */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 0, minHeight: 400 }}>
              {/* left: calendar */}
              <div style={{ padding: 16, overflow: "auto", borderRight: "1px solid rgba(255,255,255,0.12)" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
                    gap: 12,
                    minWidth: 840,
                  }}
                >
                  {slotBlocks.map((b, idx) => (
                    <div
                      key={idx}
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 10,
                        padding: 10,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        minHeight: 180,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{b.label}</div>

                      {b.ranges.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.6 }}>No availability</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {b.ranges.map((r, i) => (
                            <button
                              key={i}
                              onClick={() => openFormForDay(b.dayDate)}
                              style={{
                                padding: "8px 8px",
                                borderRadius: 8,
                                textAlign: "left",
                                border: "1px solid #4ade80",
                                background:
                                  "linear-gradient(180deg, rgba(34,197,94,0.25), rgba(34,197,94,0.15))",
                                color: "#eafff0",
                                cursor: "pointer",
                                fontSize: 12,
                                lineHeight: 1.2,
                              }}
                              title="Pick a start time & duration"
                            >
                              {fmtInTZ(r.startMs, studentTZ)}–{fmtInTZ(r.endMs, studentTZ)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* right: booking form & my bookings */}
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Booking form */}
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 10,
                    padding: 12,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                    Book a session
                  </div>

                  {!formVisible ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      Click an availability block on the left to choose a date/time.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Date:{" "}
                        <b>
                          {formDate
                            ? new Intl.DateTimeFormat(undefined, {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                                timeZone: studentTZ,
                              }).format(formDate)
                            : "—"}
                        </b>
                        {"  "} · Your timezone: <b>{studentTZ}</b>
                      </div>

                      <label style={{ fontSize: 12 }}>
                        Start time (in your timezone)
                        <select
                          value={formStartHM}
                          onChange={(e) => setFormStartHM(e.target.value)}
                          style={inputStyle}
                        >
                          {formStartOptions.length === 0 ? (
                            <option value="18:00">18:00</option>
                          ) : (
                            formStartOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))
                          )}
                        </select>
                      </label>

                      <label style={{ fontSize: 12 }}>
                        Duration
                        <select
                          value={String(formDuration)}
                          onChange={(e) => setFormDuration(parseInt(e.target.value, 10))}
                          style={inputStyle}
                        >
                          <option value="30">30 minutes</option>
                          <option value="60">60 minutes</option>
                          <option value="90">90 minutes</option>
                          <option value="120">120 minutes</option>
                        </select>
                      </label>

                      <label style={{ fontSize: 12 }}>
                        Repeat weekly
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input
                            type="number"
                            min={0}
                            max={12}
                            value={formRepeatCount}
                            onChange={(e) =>
                              setFormRepeatCount(Math.max(0, Math.min(12, parseInt(e.target.value || "0", 10))))
                            }
                            style={{ ...inputStyle, width: 100 }}
                          />
                          <span style={{ fontSize: 12, opacity: 0.8 }}>
                            additional weeks (0–12)
                          </span>
                        </div>
                      </label>

                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={submitBooking}
                          disabled={formBusy || !formDate}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 10,
                            background: "#3a6",
                            border: "1px solid #6ecf9a",
                            color: "#fff",
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: formBusy || !formDate ? "not-allowed" : "pointer",
                          }}
                        >
                          {formBusy ? "Booking…" : "Book"}
                        </button>
                        <button
                          onClick={() => setFormVisible(false)}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 10,
                            background: "#2a2a2a",
                            border: "1px solid #444",
                            color: "#fff",
                            fontSize: 14,
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* My upcoming bookings with this tutor (cancel if >=24h) */}
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 10,
                    padding: 12,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                    My upcoming sessions with {activeTutor.displayName}
                  </div>
                  {myUpcomingWithTutor.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>None scheduled.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {myUpcomingWithTutor.map((b) => {
                        const canCancel = b.startTime - Date.now() >= 24 * ONE_HOUR;
                        return (
                          <div
                            key={b.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 10px",
                              borderRadius: 8,
                              border: "1px solid rgba(255,255,255,0.12)",
                              background: "rgba(255,255,255,0.03)",
                              fontSize: 12,
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {fmtInTZ(b.startTime, studentTZ)} • {b.durationMin} min
                              </div>
                              <div style={{ opacity: 0.7 }}>
                                Your timezone: {studentTZ}
                              </div>
                            </div>
                            <button
                              disabled={!canCancel}
                              onClick={() => cancelBooking(b)}
                              style={{
                                padding: "8px 10px",
                                borderRadius: 8,
                                background: canCancel ? "#6b1f1f" : "#2a2a2a",
                                border: canCancel ? "1px solid #d66" : "1px solid #444",
                                color: "#fff",
                                cursor: canCancel ? "pointer" : "not-allowed",
                              }}
                              title={
                                canCancel
                                  ? "Cancel this session"
                                  : "Can only cancel ≥ 24 hours before start"
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* toast */}
                {toast && (
                  <div
                    style={{
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(20,180,120,0.15)",
                      color: "#d1fae5",
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  >
                    {toast}
                  </div>
                )}
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 6,
  padding: "8px 10px",
  borderRadius: 8,
  background: "#111",
  color: "#fff",
  border: "1px solid #3b3b3b",
  fontSize: 13,
};
