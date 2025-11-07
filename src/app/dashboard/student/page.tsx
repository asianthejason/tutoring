// src/app/dashboard/student/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  onAuthStateChanged,
  signOut,
  User as FirebaseUser,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  limit,
  onSnapshot,
  DocumentData,
} from "firebase/firestore";

type Role = "tutor" | "student" | "admin";

type Booking = {
  id: string;
  tutorName?: string;
  tutorEmail?: string;
  startTime?: number;
  durationMin?: number;
  roomId?: string;
};

type TutorInfo = {
  uid: string;
  displayName: string;
  email: string;
  roomId: string;
  status: string; // "waiting" | "busy" | "offline"
  queueCount: number;
  lastActiveAt?: number;
};

export default function StudentDashboardPage() {
  const router = useRouter();

  // auth / profile
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");

  // upcoming sessions
  const [bookings, setBookings] = useState<Booking[]>([]);

  // live tutors for homework help
  const [tutors, setTutors] = useState<TutorInfo[]>([]);

  // ---- auth gate / profile load ----
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        router.replace("/auth");
        return;
      }

      const myUid = fbUser.uid;
      setUid(myUid);
      setUserEmail(fbUser.email ?? null);

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

      setDisplayName(
        data.displayName ||
          (fbUser.email || "").split("@")[0] ||
          "Student"
      );

      setCheckingAuth(false);
    });

    return () => unsub();
  }, [router]);

  // ---- subscribe to my upcoming bookings ----
  useEffect(() => {
    if (!uid) return;

    const qRef = query(
      collection(db, "bookings"),
      where("studentId", "==", uid),
      limit(10)
    );

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
            startTime: b.startTime,
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
        console.error("[student bookings onSnapshot error]", err);
      }
    );

    return unsub;
  }, [uid]);

  // ---- subscribe to tutors who are actually live ----
  useEffect(() => {
    const tutorsRef = query(
      collection(db, "users"),
      where("role", "==", "tutor")
    );

    const unsub = onSnapshot(
      tutorsRef,
      (snap) => {
        const now = Date.now();
        const rows: TutorInfo[] = [];

        snap.forEach((docSnap) => {
          const data = docSnap.data() as DocumentData;
          const tutorUid = docSnap.id;

          const status = data.status || "offline";
          const lastActiveAt = data.lastActiveAt || 0;
          const isFresh = now - lastActiveAt < 30000; // 30s

          // hide offline or stale tutors
          if (status === "offline") return;
          if (!isFresh) return;

          rows.push({
            uid: tutorUid,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            status,
            lastActiveAt,
            queueCount: 0, // placeholder until we live-count queue
          });
        });

        rows.sort((a, b) => {
          // waiting (free) first, then busy, then anything else
          const order = (s: string) => (s === "waiting" ? 0 : s === "busy" ? 1 : 2);
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

  // ---- join tutor's queue ----
  const joinQueue = useCallback(
    async (tutorUid: string) => {
      if (!uid) return;
      const studentName =
        displayName || (userEmail || "").split("@")[0] || "Student";

      try {
        await setDoc(
          doc(db, "queues", tutorUid, "waitlist", uid),
          {
            studentId: uid,
            studentName,
            studentEmail: userEmail || "",
            joinedAt: Date.now(),
          },
          { merge: true }
        );
        alert("You’re in the queue! Stay on this page.");
      } catch (err) {
        console.error("Failed to join queue:", err);
        alert("Could not join queue. Try again.");
      }
    },
    [uid, userEmail, displayName]
  );

  // ---- join live room immediately (waiting tutor) ----
  const joinRoomNow = useCallback(
    (tutorRoomId: string) => {
      if (!tutorRoomId) return;
      router.push(`/room?roomId=${encodeURIComponent(tutorRoomId)}`);
    },
    [router]
  );

  function formatTime(ts?: number) {
    if (!ts) return "-";
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "-";
    }
  }

  // allow join button ~15 min before start
  function canJoinBooking(startTime?: number) {
    if (!startTime) return false;
    const now = Date.now();
    const diffMs = startTime - now;
    const fifteenMinMs = 15 * 60 * 1000;
    return diffMs <= fifteenMinMs;
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

        {/* right actions — Home first, then Find, Profile, Sign out */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            Home
          </button>
          <button
            style={ghostButtonStyle}
            onClick={() => router.push("/tutors")}
          >
            Find a Tutor
          </button>
          <button
            style={ghostButtonStyle}
            onClick={() => router.push("/profile")}
          >
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
          gridTemplateColumns: "minmax(320px, 2fr) minmax(280px, 1fr)",
          gap: 24,
          padding: "0 24px",
        }}
      >
        {/* LEFT: Scheduled Sessions */}
        <div
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
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
            Your Next Sessions
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.6)",
              marginBottom: 12,
            }}
          >
            Join when your tutor is live (about 10–15 min before start).
          </div>

          {bookings.length === 0 ? (
            <div
              style={{
                padding: "12px 0",
                fontSize: 13,
                color: "rgba(255,255,255,0.6)",
              }}
            >
              You don’t have any sessions booked yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(140px,1fr) minmax(120px,1fr) minmax(100px,auto)",
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
                Join
              </div>

              {bookings.map((b) => {
                const allowed = canJoinBooking(b.startTime);
                const handleJoin = () => {
                  if (!b.roomId) return;
                  router.push(
                    `/room?roomId=${encodeURIComponent(b.roomId)}`
                  );
                };

                return (
                  <>
                    <div
                      style={{
                        fontWeight: 500,
                        color: "#fff",
                        wordBreak: "break-word",
                      }}
                    >
                      {b.tutorName || "Tutor"}
                      <div
                        style={{
                          fontSize: 11,
                          lineHeight: 1.3,
                          color: "rgba(255,255,255,0.6)",
                        }}
                      >
                        {b.tutorEmail || "-"}
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.8)",
                      }}
                    >
                      {formatTime(b.startTime)} ({b.durationMin || 60} min)
                    </div>

                    <div>
                      <button
                        style={
                          allowed
                            ? primaryCtaStyleSmall
                            : ghostButtonStyleDisabled
                        }
                        disabled={!allowed}
                        onClick={allowed ? handleJoin : undefined}
                      >
                        {allowed ? "Join Now" : "Not Live Yet"}
                      </button>
                    </div>
                  </>
                );
              })}
            </div>
          )}
        </div>

        {/* RIGHT: Homework Help Lobby */}
        <div
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
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
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.3,
            }}
          >
            Live Homework Help
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Click “Join Room” if the tutor is <b>Waiting</b>.
            If they’re helping someone (<b>Busy</b>), you can join their queue.
          </div>

          {tutors.length === 0 ? (
            <div
              style={{
                paddingTop: 8,
                fontSize: 13,
                color: "rgba(255,255,255,0.6)",
              }}
            >
              No tutors are live right now.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: 12,
              }}
            >
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
                      boxShadow:
                        "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
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
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          lineHeight: 1.3,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 600,
                            letterSpacing: "-0.03em",
                          }}
                        >
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
                        <div
                          style={{
                            fontSize: 11,
                            lineHeight: 1.4,
                            color: "rgba(255,255,255,0.6)",
                          }}
                        >
                          {tutor.queueCount === 0
                            ? "No queue"
                            : `${tutor.queueCount} waiting`}
                        </div>
                      </div>
                    </div>

                    {/* actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {isWaiting && tutor.roomId && (
                        <button
                          style={primaryCtaStyleSmall}
                          onClick={() => joinRoomNow(tutor.roomId)}
                        >
                          Join Room
                        </button>
                      )}

                      {isBusy && (
                        <button
                          style={primaryCtaStyleSmall}
                          onClick={() => joinQueue(tutor.uid)}
                        >
                          Join Queue
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
        <div
          style={{
            color: "rgba(255,255,255,0.8)",
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          Stuck on homework right now?
        </div>

        <div style={{ marginBottom: 12 }}>
          If a tutor is <b>Waiting</b>, you can jump straight in.
          If they’re <b>Busy</b>, you’ll be placed in line. Stay on this page and
          we’ll pull you in next.
        </div>

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
          Online math tutoring for grades 4–12
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

function statusPillColors(status: string) {
  switch (status) {
    case "waiting":
      return {
        bg: "#1f3b24",
        border: "#3a6",
        text: "#6ecf9a",
        label: "Waiting",
      };
    case "busy":
      return {
        bg: "#3b2f16",
        border: "#d4a23c",
        text: "#ffd277",
        label: "Busy (helping)",
      };
    default:
      return {
        bg: "#442424",
        border: "#a66",
        text: "#ff8b8b",
        label: "Offline",
      };
  }
}
