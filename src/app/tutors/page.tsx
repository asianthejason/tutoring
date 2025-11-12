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
  lastActiveAt?: number;

  // NEW for discovery/filtering
  availability?: Availability;
  timezone?: string; // IANA
  introduction?: string;
  country?: string;
};

type TutorDoc = {
  displayName?: string;
  email?: string;
  roomId?: string;
  availability?: Availability;
  timezone?: string; // IANA
  introduction?: string;
  country?: string;
};

type Booking = {
  id: string;
  tutorId: string;
  tutorName?: string;
  tutorEmail?: string;
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  startTime: number; // ms epoch
  durationMin: number;
  endTime?: number; // ms epoch
  roomId?: string;
  createdAt?: any;
};

type StudentPrefs = {
  timezone?: string;
  preferredTimezone?: string;
};

// ---------- helpers ----------
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

const ONE_HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * ONE_HOUR;

function startOfWeekSunday(d: Date) {
  const copy = new Date(d);
  const day = copy.getDay(); // Sun=0..Sat=6
  copy.setDate(copy.getDate() - day);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
function addDays(d: Date, days: number) {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

// sanitize availability to 15-minute grid
function normalizeHM(hhmm: string): string {
  const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{1,2})$/);
  let H = 0,
    M = 0;
  if (m) {
    H = Math.max(0, Math.min(23, parseInt(m[1], 10) || 0));
    M = Math.max(0, Math.min(59, parseInt(m[2], 10) || 0));
  }
  const snapped = Math.floor(M / 15) * 15; // 00,15,30,45
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${pad(H)}:${pad(snapped)}`;
}
function hmToMinutes(hhmm: string): number {
  const norm = normalizeHM(hhmm);
  const [h, m] = norm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

// robust tz math
function getTzOffsetMs(tz: string, ms: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUTC - ms;
}
function wallTimeToUTC(y: number, m: number, d: number, H: number, M: number, tz: string): number {
  const guess = Date.UTC(y, m, d, H, M, 0, 0);
  const offset = getTzOffsetMs(tz, guess);
  return guess - offset;
}

// extract Y/M/D *in a given timezone* for a timestamp
function getYMDInTZ(ms: number | Date, tz: string) {
  const when = typeof ms === "number" ? ms : +ms;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const year = Number(parts.find((p) => p.type === "year")?.value || "1970");
  const month = Number(parts.find((p) => p.type === "month")?.value || "01") - 1; // 0-based
  const day = Number(parts.find((p) => p.type === "day")?.value || "01");
  return { year, month, day };
}

// weekday (Sun=0..Sat=6) *in a given timezone* for a timestamp
function getWeekdayInTZ(ms: number, tz: string): number {
  const { year, month, day } = getYMDInTZ(ms, tz);
  const noonUtc = Date.UTC(year, month, day, 12, 0, 0, 0);
  return new Date(noonUtc).getUTCDay(); // 0..6
}

function fmtDateInTZ(ms: number, tz: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tz,
  }).format(ms);
}
function fmtTimeInTZ(ms: number, tz: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(ms);
}
function hm24InTZ(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).formatToParts(ms);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}
function getStudentSelectedTZ(stu: StudentPrefs | undefined): string {
  return (
    (stu?.timezone && typeof stu.timezone === "string" && stu.timezone) ||
    (stu?.preferredTimezone && typeof stu.preferredTimezone === "string" && stu.preferredTimezone) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}
function studentDayNoonUTC(dateAnchor: Date, studentTZ: string): number {
  const { year, month, day } = getYMDInTZ(+dateAnchor, studentTZ);
  return wallTimeToUTC(year, month, day, 12, 0, studentTZ);
}

// ---------- component ----------
export default function TutorsLobbyPage() {
  const router = useRouter();

  // tutors
  const [tutors, setTutors] = useState<TutorRow[]>([]);
  const [loading, setLoading] = useState(true);

  // modal/tutor
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTutor, setActiveTutor] = useState<(TutorDoc & { uid: string }) | null>(null);

  // page anchor week (SUNDAY) — we render 4 consecutive weeks from this start
  const [activeWeekStart, setActiveWeekStart] = useState<Date>(startOfWeekSunday(new Date()));

  // bookings over the visible 4-week window
  const [bookedInRange, setBookedInRange] = useState<Booking[]>([]);
  const [myUpcomingWithTutor, setMyUpcomingWithTutor] = useState<Booking[]>([]);

  // student prefs / tz
  const [studentPrefs, setStudentPrefs] = useState<StudentPrefs | undefined>(undefined);
  const studentTZ = getStudentSelectedTZ(studentPrefs);

  // booking form
  const [formVisible, setFormVisible] = useState(false);
  const [formDate, setFormDate] = useState<Date | null>(null);
  const [formStartHM, setFormStartHM] = useState<string>("");
  const [formDuration, setFormDuration] = useState<number>(60);
  const [formRepeatCount, setFormRepeatCount] = useState<number>(0);
  const [formBusy, setFormBusy] = useState(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number | null>(null); // 0..27

  // time ticker for live "past" greying (updates every minute)
  const [nowMs, setNowMs] = useState<number>(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [toast, setToast] = useState("");

  // ----------------- NEW: filter state & data -----------------
  const [filterDay, setFilterDay] = useState<number | "">("");
  const [filterStart, setFilterStart] = useState<string>("");
  const [filterEnd, setFilterEnd] = useState<string>("");
  const filterWindowStart = useMemo(() => startOfWeekSunday(new Date()), []);
  const filterWindowEndMs = useMemo(() => +addDays(filterWindowStart, 28), [filterWindowStart]);
  const [bookingsByTutor, setBookingsByTutor] = useState<Record<string, { start: number; end: number }[]>>({});

  // time options (15-min grid)
  const timeOptions = useMemo(() => {
    const arr: string[] = [];
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) arr.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    return arr;
  }, []);

  // ------------------------------------------------------------

  // load all tutors (now also reading intro/country/availability/timezone)
  useEffect(() => {
    const qRef = query(collection(db, "users"), where("role", "==", "tutor"));
    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const rows: TutorRow[] = [];
        snap.forEach((d) => {
          const data = d.data() as DocumentData;
          rows.push({
            uid: d.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            statusRaw: (data.status as any) || "offline",
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
            lastActiveAt: tsToMs(data.lastActiveAt),

            availability: (data.availability as Availability) || undefined,
            timezone: (data.timezone as string) || undefined,
            introduction: (data.introduction as string) || (data.bio as string) || "",
            country: (data.country as string) || (data.countryResidence as string) || "",
          });
        });
        rows.sort((a, b) => {
          const r = (s: ReturnType<typeof deriveStatusLabel>) =>
            s.label === "Waiting" ? 0 : s.label === "Busy" ? 1 : 2;
          const ra = r(deriveStatusLabel(a));
          const rb = r(deriveStatusLabel(b));
          if (ra !== rb) return ra - rb;
          return (a.displayName || "").localeCompare(b.displayName || "");
        });
        setTutors(rows);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // load student prefs once (so the filter uses student tz too)
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    getDoc(doc(db, "users", u.uid)).then((s) =>
      setStudentPrefs((s.exists() ? (s.data() as StudentPrefs) : undefined) || undefined)
    );
  }, []);

  // load ALL bookings in the next 4 weeks (for filtering collisions)
  useEffect(() => {
    (async () => {
      try {
        const qRef = query(
          collection(db, "bookings"),
          where("startTime", ">=", +filterWindowStart),
          where("startTime", "<", filterWindowEndMs)
        );
        const snap = await getDocs(qRef);
        const map: Record<string, { start: number; end: number }[]> = {};
        snap.forEach((ds) => {
          const d = ds.data() as any;
          const st = Number(d.startTime || 0);
          const dur = Number(d.durationMin || 60);
          const et = Number(d.endTime || st + dur * 60000);
          const tid = String(d.tutorId || "");
          if (!tid) return;
          (map[tid] ||= []).push({ start: st, end: et });
        });
        setBookingsByTutor(map);
      } catch (e) {
        console.error("Failed to load bookings for filter window:", e);
        setBookingsByTutor({});
      }
    })();
  }, [filterWindowStart, filterWindowEndMs]);

  // open modal
  const openTutorModal = useCallback(async (tutorId: string) => {
    setToast("");
    setFormVisible(false);
    setFormRepeatCount(0);
    setFormDuration(60);
    setFormStartHM("");
    setSelectedDayIdx(null);

    const week0 = startOfWeekSunday(new Date());
    setActiveWeekStart(week0);

    const tSnap = await getDoc(doc(db, "users", tutorId));
    const t = (tSnap.exists() ? (tSnap.data() as TutorDoc) : {}) as TutorDoc;
    const tutor: TutorDoc & { uid: string } = {
      uid: tutorId,
      displayName: t.displayName || "Tutor",
      email: t.email || "",
      roomId: t.roomId || "",
      availability:
        (t.availability as Availability) || { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      timezone: t.timezone || undefined,
      introduction: t.introduction || "",
      country: t.country || t.countryResidence || "",
    };
    setActiveTutor(tutor);

    const u = auth.currentUser;
    if (u) {
      const sSnap = await getDoc(doc(db, "users", u.uid));
      setStudentPrefs((sSnap.exists() ? (sSnap.data() as StudentPrefs) : undefined) || undefined);
    } else {
      setStudentPrefs(undefined);
    }

    await refreshBookingsRange(tutorId, week0);
    await refreshMyUpcomingWithTutor(tutorId);

    setModalOpen(true);
  }, []);

  const refreshBookingsRange = useCallback(async (tutorId: string, rangeStart: Date) => {
    const rangeEndMs = +addDays(rangeStart, 28);
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", tutorId));
    const snap = await getDocs(qRef);
    const rows: Booking[] = [];
    snap.forEach((ds) => {
      const d = ds.data() as any;
      const st = Number(d.startTime || 0);
      const et = Number(d.endTime || st + Number(d.durationMin || 60) * 60000);
      if (st < rangeEndMs && et >= +rangeStart) {
        rows.push({
          id: ds.id,
          tutorId: d.tutorId,
          studentId: d.studentId,
          startTime: st,
          durationMin: Number(d.durationMin || 60),
          endTime: et,
          tutorName: d.tutorName,
          tutorEmail: d.tutorEmail,
          studentName: d.studentName,
          studentEmail: d.studentEmail,
          roomId: d.roomId,
        });
      }
    });
    setBookedInRange(rows);
  }, []);

  const refreshMyUpcomingWithTutor = useCallback(async (tutorId: string) => {
    const u = auth.currentUser;
    if (!u) {
      setMyUpcomingWithTutor([]);
      return;
    }
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", tutorId));
    const snap = await getDocs(qRef);
    const now = Date.now();
    const mine: Booking[] = [];
    snap.forEach((ds) => {
      const d = ds.data() as any;
      if (d.studentId === u.uid && Number(d.startTime || 0) >= now) {
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
    mine.sort((a, b) => a.startTime - b.startTime);
    setMyUpcomingWithTutor(mine);
  }, []);

  // page nav (jump by 4 weeks)
  const goPrevPage = useCallback(async () => {
    if (!activeTutor) return;
    const prev = addDays(activeWeekStart, -28);
    setActiveWeekStart(prev);
    await refreshBookingsRange(activeTutor.uid, prev);
  }, [activeTutor, activeWeekStart, refreshBookingsRange]);

  const goNextPage = useCallback(async () => {
    if (!activeTutor) return;
    const next = addDays(activeWeekStart, 28);
    setActiveWeekStart(next);
    await refreshBookingsRange(activeTutor.uid, next);
  }, [activeTutor, activeWeekStart, refreshBookingsRange]);

  const jumpToThisWeek = useCallback(async () => {
    if (!activeTutor) return;
    const nowW = startOfWeekSunday(new Date());
    setActiveWeekStart(nowW);
    await refreshBookingsRange(activeTutor.uid, nowW);
  }, [activeTutor, refreshBookingsRange]);

  // ---------- availability blocks ----------
  type AbsRange = { startMs: number; endMs: number };
  type SlotBlock = {
    dayHeader: string; // label in student tz
    dayDate: Date; // student column anchor
    ranges: AbsRange[]; // absolute UTC
  };

  // 28 consecutive days (4 weeks) starting from activeWeekStart
  const slotBlocks: SlotBlock[] = useMemo(() => {
    if (!activeTutor) return [];
    const tutorTZ = activeTutor.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    const dowToKey = (dow: number): DayKey =>
      (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] as DayKey);

    const blocks: SlotBlock[] = [];

    for (let i = 0; i < 28; i++) {
      const dayDateStudent = addDays(activeWeekStart, i);

      const noonUTC = studentDayNoonUTC(dayDateStudent, studentTZ);
      const tutorDOW = getWeekdayInTZ(noonUTC, tutorTZ); // 0..6
      const key = dowToKey(tutorDOW);

      const rangesDef = (activeTutor.availability?.[key] || []) as TimeRange[];
      const cleaned = rangesDef
        .map((r) => ({ start: normalizeHM(r.start), end: normalizeHM(r.end) }))
        .filter((r) => hmToMinutes(r.end) > hmToMinutes(r.start));

      const { year: ty, month: tm, day: td } = getYMDInTZ(noonUTC, tutorTZ);

      const abs: AbsRange[] = cleaned
        .map((r) => {
          const sMin = hmToMinutes(r.start);
          const eMin = hmToMinutes(r.end);
          const sMs = wallTimeToUTC(ty, tm, td, Math.floor(sMin / 60), sMin % 60, tutorTZ);
          const eMs = wallTimeToUTC(ty, tm, td, Math.floor(eMin / 60), eMin % 60, tutorTZ);
          return {
            startMs: Math.floor(sMs / 60000) * 60000,
            endMs: Math.floor(eMs / 60000) * 60000,
          };
        })
        .filter((r) => r.endMs > r.startMs)
        .sort((a, b) => a.startMs - b.startMs);

      blocks.push({
        dayHeader: fmtDateInTZ(+dayDateStudent, studentTZ),
        dayDate: dayDateStudent,
        ranges: abs,
      });
    }
    return blocks;
  }, [activeTutor, activeWeekStart, studentTZ]);

  // Helper: booking overlap
  function overlaps(start: number, end: number, b: { start: number; end: number }) {
    return start < b.end && end > b.start;
  }

  // ---------- start-time options (also hide booked conflicts) ----------
  const formStartOptions = useMemo(() => {
    if (!activeTutor || selectedDayIdx === null) return [];
    const block = slotBlocks[selectedDayIdx];
    if (!block) return [];

    const durMs = (Number(formDuration) || 60) * 60000;
    const bookings = bookedInRange.map((b) => ({
      start: b.startTime,
      end: b.endTime || b.startTime + b.durationMin * 60000,
    }));

    const options: { value: string; label: string }[] = [];
    for (const r of block.ranges) {
      for (let t = r.startMs; t + durMs <= r.endMs; t += 15 * 60000) {
        if (t <= nowMs) continue; // future only
        const hasConflict = bookings.some((bk) => overlaps(t, t + durMs, bk));
        if (hasConflict) continue;

        const value = hm24InTZ(t, studentTZ);
        const label = fmtTimeInTZ(t, studentTZ);
        if (!options.some((o) => o.value === value)) options.push({ value, label });
      }
    }
    return options;
  }, [activeTutor, selectedDayIdx, slotBlocks, studentTZ, formDuration, bookedInRange, nowMs]);

  // keep formStartHM in sync with available options
  useEffect(() => {
    if (!formVisible) return;
    if (formStartOptions.length === 0) {
      setFormStartHM("");
      return;
    }
    const exists = formStartOptions.some((o) => o.value === formStartHM);
    if (!exists) setFormStartHM(formStartOptions[0].value);
  }, [formVisible, formStartOptions, formStartHM]);

  // ---------- booking helpers ----------
  type Range = { startMs: number; endMs: number };

  function findContainingRange(msStart: number, msEnd: number, ranges: Range[]) {
    return ranges.find((r) => msStart >= r.startMs && msEnd <= r.endMs);
  }
  function hasTutorConflict(msStart: number, msEnd: number): boolean {
    return bookedInRange.some((b) => {
      const bStart = b.startTime;
      const bEnd = b.endTime || b.startTime + b.durationMin * 60000;
      return msStart < bEnd && msEnd > bStart;
    });
  }

  function studentWallToUTC(dateAnchor: Date, hm24: string, tz: string): number {
    const safeHM = normalizeHM(hm24);
    const { year, month, day } = getYMDInTZ(+dateAnchor, tz);
    const [H, M] = safeHM.split(":").map((x) => parseInt(x, 10));
    return wallTimeToUTC(year, month, day, H, M, tz);
  }

  const openFormForDay = useCallback((d: Date, dayIdx: number) => {
    setFormDate(d);
    setSelectedDayIdx(dayIdx);
    setFormRepeatCount(0);
    setFormDuration(60);
    setFormVisible(true);
  }, []);

  const submitBooking = useCallback(async () => {
    if (!activeTutor || !formDate || selectedDayIdx === null) return;
    setToast("");
    setFormBusy(true);

    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Please sign in as a student to book.");

      const stuSnap = await getDoc(doc(db, "users", user.uid));
      const stuData = (stuSnap.exists() ? stuSnap.data() : {}) as any;
      const role = (stuData.role as Role) || "student";
      if (role !== "student") throw new Error("Only student accounts can book a session.");

      const dur = Math.max(60, Number(formDuration || 60)); // enforce ≥60
      if (!formStartHM) throw new Error("Select a start time.");

      const chosenStart = studentWallToUTC(formDate, formStartHM, studentTZ);
      const chosenEnd = chosenStart + dur * 60000;

      const block = slotBlocks[selectedDayIdx];
      const ranges = block?.ranges ?? [];
      const containing = findContainingRange(chosenStart, chosenEnd, ranges);

      if (!containing) throw new Error("Selected time is outside the tutor’s availability.");
      if (chosenStart <= Date.now()) throw new Error("Selected time is in the past.");
      if (hasTutorConflict(chosenStart, chosenEnd)) throw new Error("That time conflicts with another booking.");

      // repeats
      const repeats = Math.max(0, Math.min(12, formRepeatCount || 0));
      const occurrences: { start: number; end: number }[] = [];
      for (let i = 0; i <= repeats; i++) {
        const start = chosenStart + i * 7 * DAY_MS;
        const end = chosenEnd + i * 7 * DAY_MS;
        occurrences.push({ start, end });
      }

      for (const occ of occurrences) {
        const bookingId = `${activeTutor.uid}_${occ.start}`;
        const bookingRef = doc(db, "bookings", bookingId);

        await runTransaction(db, async (tx) => {
          const cur = await tx.get(bookingRef);
          if (cur.exists()) throw new Error("This time was just booked.");

          const qRef = query(collection(db, "bookings"), where("tutorId", "==", activeTutor.uid));
          const snap = await getDocs(qRef);
          snap.forEach((ds) => {
            const d = ds.data() as any;
            const st = Number(d.startTime || 0);
            const et = Number(d.endTime || st + Number(d.durationMin || 60) * 60000);
            if (occ.start < et && occ.end > st) throw new Error("Conflict detected with another booking.");
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

      setToast(repeats ? `Booked ✓ ${repeats + 1} sessions (weekly).` : "Booked ✓");
      await refreshBookingsRange(activeTutor.uid, activeWeekStart);
      await refreshMyUpcomingWithTutor(activeTutor.uid);
      setFormVisible(false);
    } catch (e: any) {
      setToast(e?.message || "Could not book this time.");
    } finally {
      setFormBusy(false);
      setTimeout(() => setToast(""), 3000);
    }
  }, [
    activeTutor,
    formDate,
    selectedDayIdx,
    formStartHM,
    formDuration,
    formRepeatCount,
    slotBlocks,
    studentTZ,
    activeWeekStart,
    refreshBookingsRange,
    refreshMyUpcomingWithTutor,
  ]);

  const cancelBooking = useCallback(
    async (b: Booking) => {
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
          if (d.studentId !== user.uid) throw new Error("You can only cancel your own sessions.");
          if (Number(d.startTime) - Date.now() < 24 * ONE_HOUR) throw new Error("Within 24 hours — cannot cancel.");
          tx.delete(ref);
        });

        setToast("Session canceled.");
        await refreshBookingsRange(activeTutor!.uid, activeWeekStart);
        await refreshMyUpcomingWithTutor(activeTutor!.uid);
      } catch (e: any) {
        setToast(e?.message || "Unable to cancel.");
      } finally {
        setTimeout(() => setToast(""), 2500);
      }
    },
    [activeTutor, activeWeekStart, refreshBookingsRange, refreshMyUpcomingWithTutor]
  );

  // ----------------- FILTERING LOGIC -----------------
  const dayKeys: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  function studentSlotToUTC(dayIndex: number, startHM: string, endHM: string, tz: string) {
    const anchor = addDays(startOfWeekSunday(new Date()), dayIndex);
    const { year, month, day } = getYMDInTZ(+anchor, tz);
    const [sH, sM] = normalizeHM(startHM).split(":").map((n) => parseInt(n, 10));
    const [eH, eM] = normalizeHM(endHM).split(":").map((n) => parseInt(n, 10));
    const start = wallTimeToUTC(year, month, day, sH, sM, tz);
    const end = wallTimeToUTC(year, month, day, eH, eM, tz);
    return { start, end, anchorDate: anchor };
  }

  function tutorHasWeeklySlot(t: TutorRow): boolean {
    if (filterDay === "" || !filterStart || !filterEnd) return true; // no filter
    if (!t.availability || !t.timezone) return false;

    const studentDay = Number(filterDay); // 0..6
    const { start, end, anchorDate } = studentSlotToUTC(studentDay, filterStart, filterEnd, studentTZ);

    // map that student anchor date to tutor's weekday (DST-safe)
    const noonUTC = studentDayNoonUTC(anchorDate, studentTZ);
    const tutorDow = getWeekdayInTZ(noonUTC, t.timezone); // 0..6
    const tutorKey = dayKeys[tutorDow];

    const rangesDef = (t.availability[tutorKey] || []) as TimeRange[];
    const cleaned = rangesDef
      .map((r) => ({ start: normalizeHM(r.start), end: normalizeHM(r.end) }))
      .filter((r) => hmToMinutes(r.end) > hmToMinutes(r.start));

    const { year: ty, month: tm, day: td } = getYMDInTZ(noonUTC, t.timezone);

    const abs = cleaned
      .map((r) => {
        const sMin = hmToMinutes(r.start);
        const eMin = hmToMinutes(r.end);
        const sMs = wallTimeToUTC(ty, tm, td, Math.floor(sMin / 60), sMin % 60, t.timezone!);
        const eMs = wallTimeToUTC(ty, tm, td, Math.floor(eMin / 60), eMin % 60, t.timezone!);
        return { start: Math.floor(sMs / 60000) * 60000, end: Math.floor(eMs / 60000) * 60000 };
      })
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);

    const isNormallyAvailable = abs.some((r) => start >= r.start && end <= r.end);
    if (!isNormallyAvailable) return false;

    // Exclude if any of the next 4 weekly occurrences is booked
    const tb = bookingsByTutor[t.uid] || [];
    for (let i = 0; i < 4; i++) {
      const s = start + i * 7 * DAY_MS;
      const e = end + i * 7 * DAY_MS;
      if (tb.some((b) => s < b.end && e > b.start)) return false;
    }
    return true;
  }

  const filteredTutors = useMemo(
    () => tutors.filter(tutorHasWeeklySlot),
    [tutors, bookingsByTutor, filterDay, filterStart, filterEnd, studentTZ]
  );
  // ----------------------------------------------------

  // tutor cards
  const cards = useMemo(() => {
    return filteredTutors.map((t) => {
      const d = deriveStatusLabel(t);

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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              rowGap: 8,
              alignItems: "flex-start",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3, gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>
                  {t.displayName || "Tutor"}
                </div>
                {t.country && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "4px 8px",
                      borderRadius: 999,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      whiteSpace: "nowrap",
                    }}
                    title="Country of residence"
                  >
                    {t.country}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", maxWidth: 260 }}>{t.email}</div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  backgroundColor: chip.bg,
                  border: `1px solid ${chip.border}`,
                  color: chip.text,
                  fontSize: 12,
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

          {/* Introduction replaces subjects */}
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", minHeight: 40, lineHeight: 1.35 }}>
            {t.introduction ? t.introduction : <span style={{ opacity: 0.6 }}>No introduction yet.</span>}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {/* Removed Join button to make this a discovery page */}
            <button
              onClick={() => openTutorModal(t.uid)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: "#1f2937",
                border: "1px solid #3b3b3b",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
              title="See availability & book"
            >
              View Availability
            </button>
          </div>
        </div>
      );
    });
  }, [filteredTutors, openTutorModal]);

  // ---------- UI ----------
  // break 28 days into 4 arrays of 7 for rendering
  const weeks4 = useMemo(() => {
    const chunks: SlotBlock[][] = [];
    for (let w = 0; w < 4; w++) {
      chunks.push(slotBlocks.slice(w * 7, w * 7 + 7));
    }
    return chunks;
  }, [slotBlocks]);

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
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Calgary Math Specialists</div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              cursor: "pointer",
              minWidth: 80,
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
          gap: 16,
        }}
      >
        {/* Filter bar */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))",
            borderRadius: 12,
            padding: 12,
            display: "grid",
            gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <div style={{ gridColumn: "1 / -1", fontSize: 12, opacity: 0.85 }}>
            Find tutors available <b>every week</b> at a specific time (your timezone: <b>{studentTZ}</b>). We hide
            tutors already booked in that slot across the next 4 weeks.
          </div>

          <label style={{ fontSize: 12 }}>
            Day of week
            <select
              value={filterDay}
              onChange={(e) => setFilterDay(e.target.value === "" ? "" : Number(e.target.value))}
              style={inputStyle}
            >
              <option value="">Any</option>
              <option value={0}>Sunday</option>
              <option value={1}>Monday</option>
              <option value={2}>Tuesday</option>
              <option value={3}>Wednesday</option>
              <option value={4}>Thursday</option>
              <option value={5}>Friday</option>
              <option value={6}>Saturday</option>
            </select>
          </label>

          <label style={{ fontSize: 12 }}>
            Start time
            <select value={filterStart} onChange={(e) => setFilterStart(e.target.value)} style={inputStyle}>
              <option value="">Any</option>
              {timeOptions.map((t) => (
                <option key={`s-${t}`} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 12 }}>
            End time
            <select value={filterEnd} onChange={(e) => setFilterEnd(e.target.value)} style={inputStyle}>
              <option value="">Any</option>
              {timeOptions.map((t) => (
                <option key={`e-${t}`} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => {
              setFilterDay("");
              setFilterStart("");
              setFilterEnd("");
            }}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              cursor: "pointer",
              height: 44,
            }}
            title="Clear filters"
          >
            Clear
          </button>

          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Showing: <b>{loading ? "…" : filteredTutors.length}</b>{" "}
            {filteredTutors.length === 1 ? "tutor" : "tutors"}
          </div>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 800, lineHeight: 1.3 }}>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em" }}>
            Find your math & CS tutor
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.8, marginTop: 8 }}>
            Browse tutors below and click <b>View Availability</b> to schedule — times are shown in{" "}
            <b>your timezone</b>.
          </div>
        </div>

        {/* Tutor grid */}
        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px,100%),1fr))",
            gap: 16,
          }}
        >
          {loading ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, opacity: 0.7 }}>Loading tutors…</div>
          ) : filteredTutors.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, opacity: 0.7 }}>
              No tutors match that weekly time. Try a different day/time.
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
          textAlign: "center",
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginBottom: 6 }}>
          Need help this week?
        </div>
        <div style={{ marginBottom: 12 }}>
          Use the filters above, then click <b>View Availability</b> to book.
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
          © {new Date().getFullYear()} Apex Tutoring · Calgary, AB
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
            background: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => {
            setModalOpen(false);
            setActiveTutor(null);
            setBookedInRange([]);
            setMyUpcomingWithTutor([]);
            setFormVisible(false);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(1220px, 97vw)",
              maxHeight: "92vh",
              overflow: "hidden",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#111214",
              boxShadow: "0 40px 120px rgba(0,0,0,0.9)",
              color: "#fff",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* header */}
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid rgba(255,255,255,0.12)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {activeTutor.displayName || "Tutor"} — Availability & Booking
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Times shown in your timezone: <b>{studentTZ}</b>. (Converted from tutor’s availability.)
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button style={navButtonStyle} onClick={goPrevPage}>
                  ← Prev 4 weeks
                </button>
                <div
                  style={{
                    padding: "6px 8px",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  From{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: studentTZ,
                  }).format(activeWeekStart)}{" "}
                  to{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: studentTZ,
                  }).format(addDays(activeWeekStart, 27))}
                </div>
                <button style={navButtonStyle} onClick={goNextPage}>
                  Next 4 weeks →
                </button>
                <button style={navButtonStyle} onClick={jumpToThisWeek}>
                  This week
                </button>
                <button
                  onClick={() => {
                    setModalOpen(false);
                    setActiveTutor(null);
                    setBookedInRange([]);
                    setMyUpcomingWithTutor([]);
                    setFormVisible(false);
                  }}
                  style={{
                    padding: "6px 10px",
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

            {/* body */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", minHeight: 380 }}>
              {/* left: 4 weeks (scrollable) */}
              <div
                style={{
                  padding: 12,
                  borderRight: "1px solid rgba(255,255,255,0.12)",
                  maxHeight: "calc(92vh - 120px)",
                  overflowY: "auto",
                  gap: 12,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {weeks4.map((week, wIdx) => (
                  <div key={wIdx} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.85,
                        padding: "4px 6px",
                        borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.04)",
                        width: "fit-content",
                      }}
                    >
                      Week of{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        timeZone: studentTZ,
                      }).format(addDays(activeWeekStart, wIdx * 7))}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(7, 1fr)",
                        gap: 8,
                      }}
                    >
                      {week.map((b, idxWithin) => {
                        const idx = wIdx * 7 + idxWithin;

                        // piece segmentation for availability vs booked vs past
                        type Piece = { startMs: number; endMs: number; kind: "past" | "booked" | "free" };
                        const piecesAll: Piece[] = [];

                        for (const r of b.ranges) {
                          const booked = bookedInRange
                            .map((bk) => ({
                              start: bk.startTime,
                              end: bk.endTime || bk.startTime + bk.durationMin * 60000,
                            }))
                            .map((bk) => ({
                              start: Math.max(bk.start, r.startMs),
                              end: Math.min(bk.end, r.endMs),
                            }))
                            .filter((bk) => bk.end > bk.start);

                          const cutSet = new Set<number>([r.startMs, r.endMs]);
                          if (nowMs > r.startMs && nowMs < r.endMs) cutSet.add(nowMs);
                          for (const bk of booked) {
                            cutSet.add(bk.start);
                            cutSet.add(bk.end);
                          }
                          const pts = Array.from(cutSet).sort((a, b2) => a - b2);
                          for (let i2 = 0; i2 < pts.length - 1; i2++) {
                            const s = pts[i2],
                              e = pts[i2 + 1];
                            if (e <= s) continue;
                            const isBooked = booked.some((bk) => s < bk.end && e > bk.start);
                            const kind: Piece["kind"] = isBooked ? "booked" : s < nowMs && e <= nowMs ? "past" : "free";
                            piecesAll.push({ startMs: s, endMs: e, kind });
                          }
                        }

                        return (
                          <div
                            key={idx}
                            style={{
                              background: "rgba(255,255,255,0.06)",
                              border: "1px solid rgba(255,255,255,0.12)",
                              borderRadius: 10,
                              padding: 8,
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                              minHeight: 160,
                            }}
                          >
                            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.dayHeader}</div>

                            {b.ranges.length === 0 ? (
                              <div style={{ fontSize: 12, opacity: 0.6 }}>No availability</div>
                            ) : piecesAll.length === 0 ? (
                              <div style={{ fontSize: 12, opacity: 0.6 }}>No bookable time</div>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {piecesAll.map((p, i) => {
                                  const label = `${fmtTimeInTZ(p.startMs, studentTZ)}–${fmtTimeInTZ(
                                    p.endMs,
                                    studentTZ
                                  )}`;
                                  const isClickable = p.kind === "free" && p.startMs > nowMs;
                                  return (
                                    <button
                                      key={i}
                                      onClick={() => isClickable && openFormForDay(b.dayDate, idx)}
                                      disabled={!isClickable}
                                      style={{
                                        padding: "6px 8px",
                                        borderRadius: 8,
                                        textAlign: "left",
                                        fontSize: 12,
                                        lineHeight: 1.2,
                                        cursor: isClickable ? "pointer" : "not-allowed",
                                        border:
                                          p.kind === "free"
                                            ? "1px solid #4ade80"
                                            : p.kind === "booked"
                                            ? "1px solid #885555"
                                            : "1px solid rgba(255,255,255,0.15)",
                                        background:
                                          p.kind === "free"
                                            ? "linear-gradient(180deg, rgba(34,197,94,0.25), rgba(34,197,94,0.15))"
                                            : p.kind === "booked"
                                            ? "linear-gradient(180deg, rgba(120,120,120,0.25), rgba(120,120,120,0.15))"
                                            : "rgba(255,255,255,0.05)",
                                        color:
                                          p.kind === "free"
                                            ? "#eafff0"
                                            : p.kind === "booked"
                                            ? "rgba(255,255,255,0.85)"
                                            : "rgba(255,255,255,0.55)",
                                      }}
                                      title={
                                        p.kind === "booked"
                                          ? "Booked"
                                          : p.kind === "past"
                                          ? "This block is in the past"
                                          : "Pick a start time & duration"
                                      }
                                    >
                                      {label}
                                      {p.kind === "booked" && <span style={{ opacity: 0.8 }}> · Booked</span>}
                                      {p.kind === "past" && <span style={{ opacity: 0.6 }}> · Past</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* right: booking form & my bookings (scrollable) */}
              <div
                style={{
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  maxHeight: "calc(92vh - 120px)",
                  overflowY: "auto",
                }}
              >
                {/* Booking form */}
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Book a session</div>

                  {!formVisible ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      Click an availability block on the left to choose a date/time.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                      <div style={{ fontSize: 12, opacity: 0.85 }}>
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
                        </b>{" "}
                        · Your timezone: <b>{studentTZ}</b>
                      </div>

                      <label style={{ fontSize: 12 }}>
                        Start time (in your timezone)
                        <select
                          value={formStartHM}
                          onChange={(e) => setFormStartHM(e.target.value)}
                          style={inputStyle}
                        >
                          {formStartOptions.length === 0 ? (
                            <option value="">No times available</option>
                          ) : (
                            formStartOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))
                          )}
                        </select>
                      </label>

                      <label style={{ fontSize: 12 }}>
                        Duration
                        <select
                          value={String(formDuration)}
                          onChange={(e) => setFormDuration(Math.max(60, parseInt(e.target.value, 10)))}
                          style={inputStyle}
                        >
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
                            style={{ ...inputStyle, width: 90 }}
                          />
                          <span style={{ fontSize: 12, opacity: 0.8 }}>additional weeks (0–12)</span>
                        </div>
                      </label>

                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={submitBooking}
                          disabled={formBusy || !formDate || selectedDayIdx === null || !formStartHM}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            background: "#3a6",
                            border: "1px solid #6ecf9a",
                            color: "#fff",
                            fontSize: 14,
                            fontWeight: 600,
                            cursor:
                              formBusy || !formDate || selectedDayIdx === null || !formStartHM
                                ? "not-allowed"
                                : "pointer",
                          }}
                        >
                          {formBusy ? "Booking…" : "Book"}
                        </button>
                        <button
                          onClick={() => setFormVisible(false)}
                          style={{
                            padding: "8px 12px",
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

                {/* My upcoming with this tutor */}
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 10,
                    padding: 10,
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                    My upcoming sessions with {activeTutor?.displayName}
                  </div>
                  {myUpcomingWithTutor.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>None scheduled.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                              padding: "6px 8px",
                              borderRadius: 8,
                              border: "1px solid rgba(255,255,255,0.12)",
                              background: "rgba(255,255,255,0.03)",
                              fontSize: 12,
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {new Intl.DateTimeFormat(undefined, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  timeZone: studentTZ,
                                }).format(b.startTime)}{" "}
                                •{" "}
                                {new Intl.DateTimeFormat(undefined, {
                                  hour: "numeric",
                                  minute: "2-digit",
                                  timeZone: studentTZ,
                                }).format(b.startTime)}{" "}
                                ({b.durationMin} min)
                              </div>
                              <div style={{ opacity: 0.7 }}>Your timezone: {studentTZ}</div>
                            </div>
                            <button
                              disabled={!canCancel}
                              onClick={() => cancelBooking(b)}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 8,
                                background: canCancel ? "#6b1f1f" : "#2a2a2a",
                                border: canCancel ? "1px solid #d66" : "1px solid #444",
                                color: "#fff",
                                cursor: canCancel ? "pointer" : "not-allowed",
                              }}
                              title={canCancel ? "Cancel this session" : "Can only cancel ≥ 24h before start"}
                            >
                              Cancel
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {toast && (
                  <div
                    style={{
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(20,180,120,0.15)",
                      color: "#d1fae5",
                      borderRadius: 8,
                      padding: "6px 8px",
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

// styles
const navButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  background: "#1f2937",
  border: "1px solid #3b3b3b",
  color: "#fff",
  fontSize: 12,
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
