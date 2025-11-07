// src/app/dashboard/tutor/page.tsx
"use client";

import { useEffect, useState } from "react";
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
  updateDoc,
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
  studentName?: string;
  studentEmail?: string;
  startTime?: number; // ms
  durationMin?: number;
  roomId?: string;
};

type QueueStudent = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  joinedAt: number;
};

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

  // queue + sessions
  const [queue, setQueue] = useState<QueueStudent[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

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
      setDisplayName(
        data.displayName || (fbUser.email || "").split("@")[0] || "Tutor"
      );
      setRoomId(data.roomId || "");
      setStatus(data.status || "offline");

      setCheckingAuth(false);
    });

    return () => unsub();
  }, [router]);

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
    updateDoc(doc(db, "users", uid), {
      lastActiveAt: Date.now(),
    }).catch(() => {});

    const intervalId = setInterval(() => {
      updateDoc(doc(db, "users", uid), {
        lastActiveAt: Date.now(),
      }).catch(() => {});
    }, 15000); // every 15s

    return () => {
      clearInterval(intervalId);
    };
  }, [uid]);

  // --- Subscribe to my queue (students waiting for homework help) ---
  useEffect(() => {
    if (!uid) return;

    const qRef = collection(db, "queues", uid, "waitlist");

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const arr: QueueStudent[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as DocumentData;
          arr.push({
            studentId: d.studentId,
            studentName: d.studentName,
            studentEmail: d.studentEmail,
            joinedAt: d.joinedAt,
          });
        });

        // sort oldest first
        arr.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
        setQueue(arr);
      },
      (err) => {
        console.error("[queue onSnapshot error]", err);
      }
    );

    return unsub;
  }, [uid]);

  // --- Subscribe to upcoming 1-on-1 bookings for me ---
  useEffect(() => {
    if (!uid) return;

    const qRef = query(
      collection(db, "bookings"),
      where("tutorId", "==", uid),
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
            studentName: b.studentName,
            studentEmail: b.studentEmail,
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
        console.error("[bookings onSnapshot error]", err);
      }
    );

    return unsub;
  }, [uid]);

  // helpers
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

  function statusColors(s: string) {
    switch (s) {
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
        Loading tutor dashboard…
      </main>
    );
  }

  const statusUI = statusColors(status || "offline");
  const queueCount = queue.length;

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
          <div style={{ fontSize: 11, opacity: 0.7 }}>Tutor Dashboard</div>
        </div>

        {/* right actions — Home first, then Enter Room, Profile, Sign out */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            Home
          </button>
          <button
            style={ghostButtonStyle}
            onClick={() => {
              router.push("/room");
            }}
          >
            Enter My Room
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
          gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 2fr)",
          gap: 24,
          padding: "0 24px",
        }}
      >
        {/* LEFT: Homework Help / Status */}
        <div
          style={{
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
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
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.3,
              }}
            >
              {displayName || "Tutor"}
            </div>
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
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.5)",
                lineHeight: 1.4,
              }}
            >
              Room ID:{" "}
              <span style={{ color: "#fff" }}>
                {roomId || "(no room assigned)"}
              </span>
            </div>
          </div>

          {/* status pill + queue (read-only) */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div
              style={{
                display: "inline-flex",
                flexDirection: "column",
                gap: 4,
                minWidth: 120,
              }}
            >
              <div
                style={{
                  borderRadius: 8,
                  backgroundColor: statusUI.bg,
                  border: `1px solid ${statusUI.border}`,
                  color: statusUI.text,
                  fontSize: 12,
                  lineHeight: 1.2,
                  fontWeight: 500,
                  padding: "6px 10px",
                  textAlign: "center",
                }}
              >
                {statusUI.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: "rgba(255,255,255,0.6)",
                  textAlign: "center",
                }}
              >
                {queue.length === 0
                  ? "No one waiting"
                  : `${queue.length} waiting in queue`}
              </div>
            </div>

            {/* (Removed) manual status controls — status is automatic now */}
          </div>

          <div
            style={{
              fontSize: 11,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            Status is automatic: <b>Waiting</b> (you’re in your room with no
            student), <b>Busy</b> (in your room with a student), and{" "}
            <b>Offline</b> (not in your room or logged out). Open{" "}
            <span style={{ color: "#9cf" }}>Enter My Room</span> to go live.
          </div>
        </div>

        {/* RIGHT: Upcoming 1-on-1 sessions */}
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
            These are scheduled lessons you’ve agreed to.
          </div>

          {bookings.length === 0 ? (
            <div
              style={{
                padding: "12px 0",
                fontSize: 13,
                color: "rgba(255,255,255,0.6)",
              }}
            >
              No sessions scheduled yet.
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
                Join
              </div>

              {bookings.map((b) => {
                const joinHandler = () => {
                  router.push("/room");
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
                      {b.studentName || "Student"}
                      <div
                        style={{
                          fontSize: 11,
                          lineHeight: 1.3,
                          color: "rgba(255,255,255,0.6)",
                        }}
                      >
                        {b.studentEmail || "-"}
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
                        style={primaryCtaStyleSmall}
                        onClick={joinHandler}
                      >
                        Join Session
                      </button>
                    </div>
                  </>
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
          You’re visible to students when you’re in your room as{" "}
          <b>Waiting</b> or <b>Busy</b>.
        </div>

        <div style={{ marginBottom: 12 }}>
          Open <b>Enter My Room</b> to go live. Leave the room (or log out) to
          be <b>Offline</b>.
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
