// src/app/dashboard/student/page.tsx
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signOut, User as FirebaseUser } from "firebase/auth";
import {
  doc,
  getDoc,
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
  tutorName?: string;
  tutorEmail?: string;
  startTime?: number;     // ms epoch
  durationMin?: number;
  roomId?: string;        // tutor's roomId (still stored for back-compat)
};

type TutorInfo = {
  uid: string;
  displayName: string;
  email: string;
  roomId: string;
  status: "waiting" | "busy" | "offline";
  roomMode: RoomMode;
  lastActiveAt?: number;
};

/** -------- time helpers -------- */
const GRACE_BEFORE_MIN = 15;
const GRACE_AFTER_MIN = 15;
const FRESH_WINDOW_MS = 30_000;

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
function hasEnded(startMs?: number, durationMin?: number) {
  if (!startMs || !durationMin) return false;
  const end = startMs + minutes(durationMin) + minutes(GRACE_AFTER_MIN);
  return Date.now() > end;
}

export default function StudentDashboardPage() {
  const router = useRouter();

  // auth / profile
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");

  // sessions (mine)
  const [bookings, setBookings] = useState<Booking[]>([]);

  // live tutors for homework help (only roomMode=homework)
  const [tutors, setTutors] = useState<TutorInfo[]>([]);

  // tabs
  type MainTab = "sessions" | "homework";
  type SessionSubtab = "upcoming" | "past";
  const [mainTab, setMainTab] = useState<MainTab>("sessions");
  const [sessionTab, setSessionTab] = useState<SessionSubtab>("upcoming");

  // render tick for potential countdown badges
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- auth gate / profile load ----
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        router.replace("/auth");
        return;
      }

      const myUid = fbUser.uid;
      setUid(myUid);

      // grab profile for displayName + role
      const snap = await getDoc(doc(db, "users", myUid));
      const data = snap.data() || {};
      const role = (data.role as Role) || "student";

      if (role !== "student") {
        if (role === "tutor") {
          router.replace("/dashboard/tutor");
        } else if (role === "admin") {
          router.replace("/admin");
        } else {
          router.replace("/");
        }
        return;
      }

      setDisplayName(data.displayName || (fbUser.email || "").split("@")[0] || "Student");
      setCheckingAuth(false);
    });

    return () => unsub();
  }, [router]);

  // ---- subscribe to my bookings (both future + past; we split client-side) ----
  useEffect(() => {
    if (!uid) return;
    const qRef = query(collection(db, "bookings"), where("studentId", "==", uid), limit(100));

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const list: Booking[] = [];
        snap.forEach((docSnap) => {
          const b = docSnap.data() as DocumentData;
          list.push({
            id: docSnap.id,
            tutorName: b.tutorName,
            tutorEmail: b.tutorEmail,
            startTime: typeof b.startTime === "number" ? b.startTime : (b.startTime?.toMillis?.() ?? undefined),
            durationMin: b.durationMin,
            roomId: b.roomId,
          });
        });

        // sort chronological by start
        list.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        setBookings(list);
      },
      (err) => {
        console.error("[student bookings onSnapshot error]", err);
      }
    );

    return unsub;
  }, [uid]);

  // ---- subscribe to tutors who are live in HOMEWORK HELP ----
  useEffect(() => {
    const tutorsRef = query(
      collection(db, "users"),
      where("role", "==", "tutor"),
      where("roomMode", "==", "homework")
    );

    const unsub = onSnapshot(
      tutorsRef,
      (snap) => {
        const now = Date.now();
        const rows: TutorInfo[] = [];

        snap.forEach((docSnap) => {
          const data = docSnap.data() as DocumentData;

          const status = (data.status as TutorInfo["status"]) || "offline";
          const lastActiveAt =
            typeof data.lastActiveAt === "number"
              ? data.lastActiveAt
              : typeof data.lastActiveAt?.toMillis === "function"
              ? data.lastActiveAt.toMillis()
              : 0;

          const isFresh = now - lastActiveAt < FRESH_WINDOW_MS;
          if (!isFresh) return;
          if (status === "offline") return;

          rows.push({
            uid: docSnap.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            status,
            roomMode: (data.roomMode as RoomMode) ?? null,
            lastActiveAt,
          });
        });

        rows.sort((a, b) => {
          const order = (s: TutorInfo["status"]) => (s === "waiting" ? 0 : s === "busy" ? 1 : 2);
          const diff = order(a.status) - order(b.status);
          if (diff !== 0) return diff;
          return a.displayName.localeCompare(b.displayName);
        });

        setTutors(rows);
      },
      (err) => {
        console.error("[tutors onSnapshot error]", err);
      }
    );

    return unsub;
  }, []);

  // ---- join helpers ----
  const joinHomeworkRoom = useCallback(
    (tutorRoomId: string) => {
      if (!tutorRoomId) return;
      router.push(`/room?mode=homework&roomId=${encodeURIComponent(tutorRoomId)}`);
    },
    [router]
  );

  function canJoinBooking(b: Booking) {
    return withinJoinWindow(b.startTime, b.durationMin || 60);
  }
  function joinScheduled(b: Booking) {
    router.push(`/room?mode=session&bookingId=${encodeURIComponent(b.id)}`);
  }

  // ---- derived lists for subtabs ----
  const { upcoming, past } = useMemo(() => {
    const up: Booking[] = [];
    const pa: Booking[] = [];
    for (const b of bookings) {
      if (hasEnded(b.startTime, b.durationMin || 60)) {
        pa.push(b);
      } else {
        up.push(b);
      }
    }
    // Upcoming ascending (soonest first); Past descending (latest first)
    up.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    pa.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    return { upcoming: up, past: pa };
  }, [bookings, _tick]);

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

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
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
        Loading student dashboard…
      </main>
    );
  }

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
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(15,15,15,0.0) 100%)",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow:
            "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
        }}
      >
        {/* left info */}
        <div
          style={{
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.2,
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: "-0.03em",
            }}
          >
            Apex Tutoring
          </div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Student Dashboard</div>
        </div>

        {/* right actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            Home
          </button>
          <button style={ghostButtonStyle} onClick={() => router.push("/tutors")}>
            Find a Tutor
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
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "0 24px",
        }}
      >
        {/* TOP-LEVEL TABS */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            aria-pressed={mainTab === "sessions"}
            onClick={() => setMainTab("sessions")}
            style={tabStyle(mainTab === "sessions")}
          >
            One-on-One Sessions
          </button>
          <button
            aria-pressed={mainTab === "homework"}
            onClick={() => setMainTab("homework")}
            style={tabStyle(mainTab === "homework")}
          >
            Available Homework Tutors
          </button>
        </div>

        {/* CONTENT AREA */}
        {mainTab === "sessions" ? (
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
            {/* SUBTABS */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                aria-pressed={sessionTab === "upcoming"}
                onClick={() => setSessionTab("upcoming")}
                style={pillTabStyle(sessionTab === "upcoming")}
              >
                Upcoming
              </button>
              <button
                aria-pressed={sessionTab === "past"}
                onClick={() => setSessionTab("past")}
                style={pillTabStyle(sessionTab === "past")}
              >
                Past
              </button>
            </div>

            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                color: "rgba(255,255,255,0.6)",
                marginBottom: 12,
              }}
            >
              {sessionTab === "upcoming"
                ? `You can enter your session about ${GRACE_BEFORE_MIN} minutes before the scheduled time.`
                : "These are your recently completed sessions."}
            </div>

            {/* TABLE */}
            {(sessionTab === "upcoming" ? upcoming : past).length === 0 ? (
              <div style={{ padding: "12px 0", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
                {sessionTab === "upcoming"
                  ? "You don’t have any upcoming sessions."
                  : "No past sessions to show yet."}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(180px,1.3fr) minmax(180px,1fr) minmax(160px,auto)",
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
                  Tutor
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
                  {sessionTab === "upcoming" ? "Join" : "Status"}
                </div>

                {(sessionTab === "upcoming" ? upcoming : past).map((b) => {
                  const allowed = canJoinBooking(b);
                  const ended = hasEnded(b.startTime, b.durationMin || 60);
                  return (
                    <div key={b.id} style={{ display: "contents" }}>
                      <div style={{ fontWeight: 500, color: "#fff", wordBreak: "break-word" }}>
                        {b.tutorName || "Tutor"}
                        <div style={{ fontSize: 11, lineHeight: 1.3, color: "rgba(255,255,255,0.6)" }}>
                          {b.tutorEmail || "-"}
                        </div>
                      </div>

                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                        {formatTime(b.startTime)} ({b.durationMin || 60} min)
                      </div>

                      {sessionTab === "upcoming" ? (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            style={allowed ? primaryCtaStyleSmall : ghostButtonStyleDisabled}
                            disabled={!allowed}
                            onClick={allowed ? () => joinScheduled(b) : undefined}
                            title={allowed ? "Enter your 1-on-1 session" : "Opens ~15 min before start"}
                          >
                            {allowed ? "Join Now" : "Not Live Yet"}
                          </button>

                          <button
                            style={ghostButtonStyle}
                            onClick={() => {
                              const url = `${window.location.origin}/room?mode=session&bookingId=${encodeURIComponent(
                                b.id
                              )}`;
                              navigator.clipboard.writeText(url).catch(() => {});
                            }}
                            title="Copy your session link"
                          >
                            Copy Link
                          </button>
                        </div>
                      ) : (
                        <div>
                          <span
                            style={{
                              padding: "6px 10px",
                              borderRadius: 8,
                              border: "1px solid rgba(255,255,255,0.2)",
                              background: "rgba(255,255,255,0.06)",
                              fontSize: 12,
                              color: "rgba(255,255,255,0.8)",
                            }}
                          >
                            {ended ? "Ended" : "In progress"}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          // HOMEWORK TUTORS TAB
          <div
            style={{
              background:
                "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
              borderRadius: 16,
              padding: "16px 20px",
              minHeight: 220,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>Live Homework Help</div>
            <div style={{ fontSize: 12, lineHeight: 1.4, color: "rgba(255,255,255,0.6)" }}>
              You’ll only see tutors who are currently in their <b>Homework Help</b> room. If they’re <b>Busy</b>,
              check back in a moment.
            </div>

            {tutors.length === 0 ? (
              <div style={{ paddingTop: 8, fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
                No tutors are live in Homework Help right now.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {tutors.map((tutor) => {
                  const isWaiting = tutor.status === "waiting";
                  const isBusy = tutor.status === "busy";
                  const pill = statusPillColors(tutor.status);

                  return (
                    <div
                      key={tutor.uid}
                      style={{
                        borderRadius: 12,
                        background:
                          "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
                        padding: "16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      {/* top row: name + status */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.03em" }}>
                            {tutor.displayName || "Tutor"}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: "rgba(255,255,255,0.6)",
                              lineHeight: 1.4,
                              wordBreak: "break-word",
                            }}
                          >
                            {tutor.email}
                          </div>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            minWidth: 100,
                            textAlign: "center",
                          }}
                        >
                          <div
                            style={{
                              borderRadius: 8,
                              backgroundColor: pill.bg,
                              border: `1px solid ${pill.border}`,
                              color: pill.text,
                              fontSize: 12,
                              lineHeight: 1.2,
                              fontWeight: 500,
                              padding: "6px 10px",
                            }}
                          >
                            {pill.label}
                          </div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                            {tutor.roomMode === "homework" ? "Homework Help" : "—"}
                          </div>
                        </div>
                      </div>

                      {/* actions */}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {isWaiting && tutor.roomId && (
                          <button style={primaryCtaStyleSmall} onClick={() => joinHomeworkRoom(tutor.roomId)}>
                            Join Room
                          </button>
                        )}

                        {isBusy && (
                          <button style={ghostButtonStyleDisabled} disabled>
                            Currently Helping
                          </button>
                        )}

                        {!isWaiting && !isBusy && (
                          <button style={ghostButtonStyleDisabled} disabled>
                            Offline
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
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
        {mainTab === "homework" ? (
          <>
            <div style={{ color: "rgba(255,255,255,0.85)", fontWeight: 500, marginBottom: 6 }}>
              Stuck on homework right now?
            </div>
            <div style={{ marginBottom: 12 }}>
              If a tutor is <b>Waiting</b> in the list, you can jump straight in. If they’re <b>Busy</b>, check back soon.
            </div>
          </>
        ) : (
          <>
            <div style={{ color: "rgba(255,255,255,0.85)", fontWeight: 500, marginBottom: 6 }}>
              Manage your one-on-one sessions
            </div>
            <div style={{ marginBottom: 12 }}>
              Use <b>Upcoming</b> to join when your window opens; <b>Past</b> shows recently completed sessions.
            </div>
          </>
        )}

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.4)",
            marginBottom: 4,
          }}
        >
          © {new Date().getFullYear()} Apex Tutoring · Student View
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.4)",
            paddingBottom: 16,
          }}
        >
          Online math & computer science tutoring
        </div>
      </footer>
    </main>
  );
}

/* styles */

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

const ghostButtonStyleDisabled: React.CSSProperties = {
  ...ghostButtonStyle,
  opacity: 0.4,
  cursor: "default",
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

function statusPillColors(status: TutorInfo["status"]) {
  switch (status) {
    case "waiting":
      return { bg: "#1f3b24", border: "#3a6", text: "#6ecf9a", label: "Waiting" };
    case "busy":
      return { bg: "#3b2f16", border: "#d4a23c", text: "#ffd277", label: "Busy (helping)" };
    default:
      return { bg: "#442424", border: "#a66", text: "#ff8b8b", label: "Offline" };
  }
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    background: active ? "#1f2937" : "#161616",
    border: active ? "1px solid #3b3b3b" : "1px solid #2a2a2a",
    color: active ? "#fff" : "rgba(255,255,255,0.85)",
    boxShadow: active ? "0 10px 30px rgba(0,0,0,0.6)" : "none",
  };
}

function pillTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
    border: active ? "1px solid rgba(255,255,255,0.28)" : "1px solid rgba(255,255,255,0.14)",
    color: active ? "#fff" : "rgba(255,255,255,0.85)",
  };
}
