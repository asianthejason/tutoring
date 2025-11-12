// src/app/dashboard/tutor/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signOut, User as FirebaseUser } from "firebase/auth";
import {
  doc,
  getDoc,
  updateDoc,
  setDoc,
  collection,
  query,
  where,
  limit,
  onSnapshot,
  DocumentData,
} from "firebase/firestore";

type Role = "tutor" | "student" | "admin";
type RoomMode = "homework" | "session" | null;

type Booking = {
  id: string;
  studentName?: string;
  studentEmail?: string;
  startTime?: number; // ms
  durationMin?: number;
  roomId?: string;
};

const GRACE_BEFORE_MIN = 15;
const GRACE_AFTER_MIN = 15;

function minutes(n: number) {
  return n * 60 * 1000;
}

function withinJoinWindow(startMs?: number, durationMin?: number) {
  if (!startMs || !durationMin) return false;
  const now = Date.now();
  const windowStart = startMs - minutes(GRACE_BEFORE_MIN);
  const windowEnd = startMs + minutes(durationMin) + minutes(GRACE_AFTER_MIN);
  return now >= windowStart && now <= windowEnd;
}

function untilWindowOpensMs(startMs?: number) {
  if (!startMs) return null;
  const openAt = startMs - minutes(GRACE_BEFORE_MIN);
  const delta = openAt - Date.now();
  return delta > 0 ? delta : 0;
}

function formatCountdown(ms: number) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m <= 0 && s <= 0) return "now";
  if (m <= 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export default function TutorDashboardPage() {
  const router = useRouter();

  // auth / profile
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [role, setRole] = useState<Role | null>(null);
  const [roomId, setRoomId] = useState<string>("");
  const [status, setStatus] = useState<string>("offline"); // "waiting" | "busy" | "offline"

  // live mode signals
  const [roomMode, setRoomMode] = useState<RoomMode>(null);
  const [currentBookingId, setCurrentBookingId] = useState<string | null>(null);

  // sessions
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tick, setTick] = useState(0); // for countdown rerender

  // --- Auth gate / load basic tutor data ---
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        router.replace("/auth");
        return;
      }

      const myUid = fbUser.uid;
      setUid(myUid);
      setUserEmail(fbUser.email ?? null);

      // read their Firestore profile
      const snap = await getDoc(doc(db, "users", myUid));
      const data = snap.data() || {};

      const fixedRole = (data.role as Role) || "student";
      if (fixedRole !== "tutor") {
        if (fixedRole === "student") {
          router.replace("/dashboard/student");
        } else if (fixedRole === "admin") {
          router.replace("/admin");
        } else {
          router.replace("/");
        }
        return;
      }

      setRole("tutor");
      setDisplayName(data.displayName || (fbUser.email || "").split("@")[0] || "Tutor");
      setRoomId(data.roomId || "");
      setStatus(data.status || "offline");
      setRoomMode((data.roomMode as RoomMode) ?? null);
      setCurrentBookingId(typeof data.currentBookingId === "string" ? data.currentBookingId : null);

      setCheckingAuth(false);
    });

    return () => unsub();
  }, [router]);

  // --- Subscribe to my user doc for live status/mode updates ---
  useEffect(() => {
    if (!uid) return;
    const unsub = onSnapshot(doc(db, "users", uid), (snap) => {
      const d = snap.data() || {};
      setStatus(d.status || "offline");
      setRoomMode((d.roomMode as RoomMode) ?? null);
      setCurrentBookingId(typeof d.currentBookingId === "string" ? d.currentBookingId : null);
      setRoomId(d.roomId || "");
    });
    return () => unsub();
  }, [uid]);

  // --- On dashboard (not /room), force status "offline" once we know uid+role ---
  useEffect(() => {
    if (!uid || role !== "tutor") return;
    updateDoc(doc(db, "users", uid), {
      status: "offline",
      statusUpdatedAt: Date.now(),
      lastActiveAt: Date.now(),
    }).catch(() => {});
  }, [uid, role]);

  // --- HEARTBEAT: regularly update lastActiveAt while tutor dashboard is open ---
  useEffect(() => {
    if (!uid) return;

    // update immediately
    updateDoc(doc(db, "users", uid), { lastActiveAt: Date.now() }).catch(() => {});

    const intervalId = setInterval(() => {
      updateDoc(doc(db, "users", uid), { lastActiveAt: Date.now() }).catch(() => {});
    }, 15000); // every 15s

    return () => clearInterval(intervalId);
  }, [uid]);

  // --- Subscribe to upcoming 1-on-1 bookings for me ---
  useEffect(() => {
    if (!uid) return;

    // NOTE: your schema uses "tutorId" in this page (we'll keep it consistent here).
    const qRef = query(collection(db, "bookings"), where("tutorId", "==", uid), limit(20));

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const list: Booking[] = [];
        snap.forEach((docSnap) => {
          const b = docSnap.data() as DocumentData;
          list.push({
            id: docSnap.id,
            studentName: b.studentName,
            studentEmail: b.studentEmail,
            startTime: typeof b.startTime === "number" ? b.startTime : (b.startTime?.toMillis?.() ?? undefined),
            durationMin: b.durationMin,
            roomId: b.roomId,
          });
        });

        list.sort((a, b) => {
          const ta = a.startTime || 0;
          const tb = b.startTime || 0;
          return ta - tb;
        });

        setBookings(list);
      },
      (err) => {
        console.error("[bookings onSnapshot error]", err);
      }
    );

    return unsub;
  }, [uid]);

  // small ticker for countdown labels
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // helpers
  function formatTime(ts?: number) {
    if (!ts) return "-";
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "-";
    }
  }

  function statusColors(s: string) {
    switch (s) {
      case "waiting":
        return { bg: "#1f3b24", border: "#3a6", text: "#6ecf9a", label: "Waiting" };
      case "busy":
        return { bg: "#3b2f16", border: "#d4a23c", text: "#ffd277", label: "Busy (in session)" };
      default:
        return { bg: "#442424", border: "#a66", text: "#ff8b8b", label: "Offline" };
    }
  }

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  // --- write helpers for room mode ---
  async function setRoomMeta(mode: RoomMode, bookingId?: string | null) {
    if (!uid) return;
    const patch: Record<string, any> = {
      roomMode: mode ?? null,
      lastActiveAt: Date.now(),
    };
    if (typeof bookingId !== "undefined") patch.currentBookingId = bookingId;
    await setDoc(doc(db, "users", uid), patch, { merge: true }).catch(() => {});
  }

  // Actions
  async function openHomeworkHelp() {
    if (!roomId) return router.push("/room?mode=homework"); // room page will pick tutor's roomId from profile
    await setRoomMeta("homework", null);
    router.push(`/room?mode=homework`);
  }

  async function startSession(b: Booking) {
    if (!b?.id) return;
    await setRoomMeta("session", b.id);
    router.push(`/room?mode=session&bookingId=${encodeURIComponent(b.id)}`);
  }

  function joinEnabled(b: Booking) {
    return withinJoinWindow(b.startTime, b.durationMin || 60);
  }

  function joinCtaLabel(b: Booking) {
    if (joinEnabled(b)) return "Start Session";
    const ms = untilWindowOpensMs(b.startTime);
    if (ms === null) return "Start Session";
    if (ms === 0) return "Start Session";
    return `Opens in ${formatCountdown(ms)}`;
  }

  if (checkingAuth) {
    return (
      <main
        style={{
          minHeight: "100vh",
          backgroundColor: "#0f0f0f",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        Loading tutor dashboard…
      </main>
    );
  }

  const statusUI = statusColors(status || "offline");

  // small live banner describing current mode (if any)
  const modeBanner =
    roomMode ? (
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          lineHeight: 1.4,
          color: "rgba(255,255,255,0.85)",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            padding: "4px 8px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.2)",
            background: roomMode === "session" ? "rgba(212,162,60,0.15)" : "rgba(80,200,120,0.15)",
          }}
        >
          {roomMode === "session" ? "1-on-1 Session mode" : "Homework Help mode"}
        </span>
        {roomMode === "session" && currentBookingId ? (
          <span style={{ opacity: 0.8 }}>Booking: {currentBookingId}</span>
        ) : null}
      </div>
    ) : null;

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
        paddingTop: 24,
        paddingBottom: 24,
      }}
    >
      {/* HEADER BAR */}
      <header
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
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
        <div
          style={{
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.2,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Tutor Dashboard</div>
          {modeBanner}
        </div>

        {/* right actions — Home, Open Homework Help, Profile, Sign out */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            Home
          </button>
          <button style={ghostButtonStyle} onClick={openHomeworkHelp}>
            Open Homework Help Room
          </button>
          <button style={ghostButtonStyle} onClick={() => router.push("/profile")}>
            Profile
          </button>
          <button style={ghostButtonStyle} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <section
        style={{
          flex: "1 1 auto",
          width: "100%",
          maxWidth: "1280px",
          margin: "24px auto 0",
          display: "grid",
          gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 2fr)",
          gap: 24,
          padding: "0 24px",
        }}
      >
        {/* LEFT: Status card */}
        <div
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
            borderRadius: 16,
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minHeight: 220,
          }}
        >
          {/* tutor info */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>{displayName || "Tutor"}</div>
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.6)",
                wordBreak: "break-word",
                lineHeight: 1.4,
              }}
            >
              {userEmail}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
              Room ID: <span style={{ color: "#fff" }}>{roomId || "(no room assigned)"}</span>
            </div>
          </div>

          {/* status pill */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 120 }}>
              <div
                style={{
                  borderRadius: 8,
                  backgroundColor: statusColors(status || "offline").bg,
                  border: `1px solid ${statusColors(status || "offline").border}`,
                  color: statusColors(status || "offline").text,
                  fontSize: 12,
                  lineHeight: 1.2,
                  fontWeight: 500,
                  padding: "6px 10px",
                  textAlign: "center",
                }}
              >
                {statusColors(status || "offline").label}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.5)" }}>
            Status is automatic inside the room:
            {" "}
            <b>Waiting</b> (in room, no student) · <b>Busy</b> (with student) · <b>Offline</b> (not in room).
            {" "}
            Use <span style={{ color: "#9cf" }}>Open Homework Help Room</span> or a session’s{" "}
            <span style={{ color: "#9cf" }}>Start Session</span>.
          </div>
        </div>

        {/* RIGHT: Upcoming 1-on-1 sessions */}
        <div
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
            borderRadius: 16,
            padding: "16px 20px",
            minHeight: 220,
            fontSize: 13,
            lineHeight: 1.4,
            color: "#fff",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.3,
              marginBottom: 8,
            }}
          >
            Your Upcoming 1-on-1 Sessions
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.6)",
              marginBottom: 12,
            }}
          >
            You can enter a session up to {GRACE_BEFORE_MIN} minutes before the start time.
          </div>

          {bookings.length === 0 ? (
            <div style={{ padding: "12px 0", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
              No sessions scheduled yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(200px,1.4fr) minmax(180px,1fr) minmax(140px,auto)",
                gap: "12px",
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  borderBottom: "1px solid rgba(255,255,255,0.12)",
                  paddingBottom: 4,
                }}
              >
                Student
              </div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  borderBottom: "1px solid rgba(255,255,255,0.12)",
                  paddingBottom: 4,
                }}
              >
                Time
              </div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  borderBottom: "1px solid rgba(255,255,255,0.12)",
                  paddingBottom: 4,
                }}
              >
                Action
              </div>

              {bookings.map((b) => {
                const enabled = joinEnabled(b);
                const label = joinCtaLabel(b);
                return (
                  <div key={b.id} style={{ display: "contents" }}>
                    <div style={{ fontWeight: 500, color: "#fff", wordBreak: "break-word" }}>
                      {b.studentName || "Student"}
                      <div style={{ fontSize: 11, lineHeight: 1.3, color: "rgba(255,255,255,0.6)" }}>
                        {b.studentEmail || "-"}
                      </div>
                    </div>

                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                      {formatTime(b.startTime)} ({b.durationMin || 60} min)
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        style={{
                          ...primaryCtaStyleSmall,
                          opacity: enabled ? 1 : 0.6,
                          cursor: enabled ? "pointer" : "not-allowed",
                          minWidth: 130,
                        }}
                        disabled={!enabled}
                        onClick={() => startSession(b)}
                        title={enabled ? "Enter your 1-on-1 session" : "Available 15 min before start"}
                      >
                        {label}
                      </button>

                      {/* fallback deep link you can copy/share with your student */}
                      <button
                        style={ghostButtonStyle}
                        onClick={() => {
                          const url = `${window.location.origin}/room?mode=session&bookingId=${encodeURIComponent(b.id)}`;
                          navigator.clipboard.writeText(url).catch(() => {});
                        }}
                        title="Copy student join link"
                      >
                        Copy Link
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* FOOTER */}
      <footer
        style={{
          flex: "0 0 auto",
          width: "100%",
          maxWidth: "1280px",
          margin: "32px auto 0",
          padding: "16px 24px 0",
          color: "rgba(255,255,255,0.5)",
          fontSize: 12,
          lineHeight: 1.4,
          textAlign: "center",
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginBottom: 6 }}>
          You’re visible to students in the Homework Help list only when your room is open in{" "}
          <b>Homework Help</b> mode.
        </div>

        <div style={{ marginBottom: 12 }}>
          Use <b>Open Homework Help Room</b> for drop-ins, or <b>Start Session</b> for scheduled students.
        </div>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.4)",
            marginBottom: 4,
          }}
        >
          © {new Date().getFullYear()} Apex Tutoring · Tutor View
        </div>
      </footer>
    </main>
  );
}

/* --- tiny shared styles --- */
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

const primaryCtaStyleSmall: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "#3a6",
  border: "1px solid #6ecf9a",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.2,
  fontWeight: 500,
  cursor: "pointer",
  minWidth: 110,
  textAlign: "center",
};
