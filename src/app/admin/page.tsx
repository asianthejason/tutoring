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
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  DocumentData,
} from "firebase/firestore";

type Role = "tutor" | "student" | "admin";

type SessionDoc = {
  active?: boolean;
  tutorId?: string;
  tutorName?: string;
  tutorEmail?: string;
  studentIds?: string[];
  studentEmails?: Record<string, string>;
  startedAt?: number;
};

export default function AdminPage() {
  const router = useRouter();

  // auth / role state
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<Role | null>(null);

  // session list from Firestore
  const [sessions, setSessions] = useState<
    { roomId: string; data: SessionDoc }[]
  >([]);

  // load auth + role, block non-admin
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        // not logged in
        router.replace("/auth?from=/admin");
        return;
      }

      setUserEmail(fbUser.email ?? null);

      // get role from Firestore
      const token = await fbUser.getIdTokenResult().catch(() => null);
      // We don't actually trust custom claims here. We're using your existing users/{uid} doc pattern in /page.
      // To stay consistent and not duplicate logic, we’ll just fetch once using the same logic:
      const { getDoc, doc } = await import("firebase/firestore");
      const userSnap = await getDoc(doc(db, "users", fbUser.uid));
      const role = (userSnap.data()?.role || "student") as Role;
      setUserRole(role);

      // redirect away if not admin
      if (role !== "admin") {
        router.replace("/");
        return;
      }

      setCheckingAuth(false);
    });

    return unsub;
  }, [router]);

  // subscribe to Firestore sessions for live data
  useEffect(() => {
    if (checkingAuth) return;
    if (userRole !== "admin") return;

    // We listen to all sessions.
    // You can add where("active","==",true) later if you only want live rooms.
    const qRef = query(
      collection(db, "sessions"),
      orderBy("startedAt", "desc"),
      limit(25)
    );

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const items: { roomId: string; data: SessionDoc }[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as DocumentData;
          items.push({
            roomId: docSnap.id,
            data: {
              active: d.active,
              tutorId: d.tutorId,
              tutorName: d.tutorName,
              tutorEmail: d.tutorEmail,
              studentIds: d.studentIds,
              studentEmails: d.studentEmails,
              startedAt: d.startedAt,
            },
          });
        });
        setSessions(items);
      },
      (err) => {
        console.error("[admin sessions onSnapshot error]", err);
      }
    );

    return unsub;
  }, [checkingAuth, userRole]);

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  function joinQuietly(roomId: string) {
    // We’ll send the admin to /room with override flags.
    // name is what will show inside the session.
    const observerName = `Observer-${roomId}`;
    router.push(
      `/room?roomId=${encodeURIComponent(
        roomId
      )}&adminOverride=true&name=${encodeURIComponent(observerName)}`
    );
  }

  // ------ UI helpers ------
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

  const bgPage = "#0f0f0f";
  const cardBg =
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)";

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100vw",
        backgroundColor: bgPage,
        backgroundImage:
          "radial-gradient(circle at 20% 20%, rgba(77,177,255,0.08) 0%, rgba(0,0,0,0) 70%), radial-gradient(circle at 80% 30%, rgba(80,255,150,0.06) 0%, rgba(0,0,0,0) 60%)",
        backgroundRepeat: "no-repeat",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        gap: 24,
      }}
    >
      {/* top nav / header */}
      <header
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          borderRadius: 12,
          background:
            "linear-gradient(to right, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow:
            "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
        }}
      >
        {/* left brand / label */}
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
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
            }}
          >
            Admin Dashboard
          </div>
        </div>

        {/* right actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => router.push("/")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.2,
              minWidth: 80,
              cursor: "pointer",
            }}
          >
            Home
          </button>
          <button
            onClick={handleSignOut}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.2,
              minWidth: 80,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* admin account summary */}
      <section
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          display: "grid",
          gap: "16px",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(320px,100%),1fr))",
        }}
      >
        {/* Account card */}
        <div
          style={{
            background: cardBg,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.15)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 4px rgba(255,255,255,0.08) inset",
            color: "#fff",
            padding: "16px 20px",
            fontSize: 13,
            lineHeight: 1.4,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 140,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 4,
              color: "#fff",
              lineHeight: 1.3,
            }}
          >
            Admin Account
          </div>

          <div style={{ opacity: 0.9 }}>
            <div>
              <span style={{ opacity: 0.6 }}>Email: </span>
              <span>{userEmail || "…"}</span>
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>Role: </span>
              <span>{userRole || "…"}</span>
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>Status: </span>
              <span
                style={{
                  color:
                    userRole === "admin"
                      ? "#6ecf9a"
                      : "rgba(255,255,255,0.6)",
                  fontWeight: 500,
                }}
              >
                {userRole === "admin" ? "Verified admin" : "—"}
              </span>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              fontSize: 11,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Only admins can view this page. Tutors / students get redirected.
          </div>
        </div>

        {/* Live Classroom Overview card */}
        <div
          style={{
            background: cardBg,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.15)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 4px rgba(255,255,255,0.08) inset",
            color: "#fff",
            padding: "16px 20px",
            fontSize: 13,
            lineHeight: 1.4,
            minHeight: 140,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.3,
            }}
          >
            Live Classroom Overview
          </div>

          <div
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.8)",
            }}
          >
            You can:
            <ul
              style={{
                marginTop: 4,
                marginBottom: 4,
                paddingLeft: 18,
                lineHeight: 1.5,
              }}
            >
              <li>See active sessions</li>
              <li>See tutor + which students are in each room</li>
              <li>Quiet join (monitor a session live)</li>
            </ul>
          </div>

          <div
            style={{
              fontSize: 11,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            Quiet join = you enter the LiveKit room as a muted observer.
          </div>
        </div>
      </section>

      {/* Sessions table */}
      <section
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            lineHeight: 1.3,
            marginBottom: 12,
          }}
        >
          Active / Recent Sessions
        </div>

        <div
          style={{
            width: "100%",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.15)",
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.03) 0%, rgba(15,15,15,0.6) 70%)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
            overflowX: "auto",
          }}
        >
          {/* table header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(140px,1fr) minmax(120px,1fr) minmax(160px,1fr) minmax(80px,auto)",
              gap: "12px",
              padding: "12px 16px",
              fontSize: 12,
              lineHeight: 1.3,
              color: "rgba(255,255,255,0.6)",
              borderBottom: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <div>Room / Tutor</div>
            <div>Students</div>
            <div>Started</div>
            <div>Action</div>
          </div>

          {/* table rows */}
          <div style={{ fontSize: 13, lineHeight: 1.4, color: "#fff" }}>
            {sessions.length === 0 ? (
              <div
                style={{
                  padding: "16px",
                  fontSize: 13,
                  color: "rgba(255,255,255,0.6)",
                }}
              >
                No sessions found.
              </div>
            ) : (
              sessions.map(({ roomId, data }) => {
                const {
                  tutorName,
                  tutorEmail,
                  studentIds,
                  startedAt,
                  active,
                } = data;

                const studentList =
                  studentIds && studentIds.length > 0
                    ? studentIds.join(", ")
                    : "—";

                return (
                  <div
                    key={roomId}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(140px,1fr) minmax(120px,1fr) minmax(160px,1fr) minmax(80px,auto)",
                      gap: "12px",
                      padding: "12px 16px",
                      borderBottom:
                        "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    {/* Room / Tutor */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontWeight: 500, color: "#fff" }}>
                        {roomId || "—"}
                      </div>
                      <div
                        style={{
                          color: "rgba(255,255,255,0.8)",
                          fontSize: 12,
                          lineHeight: 1.4,
                        }}
                      >
                        {tutorName || "Tutor"}{" "}
                        <span
                          style={{
                            opacity: 0.6,
                            fontWeight: 400,
                          }}
                        >
                          ({tutorEmail || "—"})
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          lineHeight: 1.3,
                          marginTop: 2,
                          color: active ? "#6ecf9a" : "#888",
                        }}
                      >
                        {active ? "Active" : "Ended"}
                      </div>
                    </div>

                    {/* Students */}
                    <div
                      style={{
                        color: "#fff",
                        fontSize: 12,
                        lineHeight: 1.4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {studentList}
                    </div>

                    {/* Started */}
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.8)",
                        lineHeight: 1.4,
                      }}
                    >
                      {formatTime(startedAt)}
                    </div>

                    {/* Action */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                      }}
                    >
                      <button
                        onClick={() => joinQuietly(roomId)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          background: "#2a2a2a",
                          border: "1px solid #444",
                          color: "#fff",
                          fontSize: 12,
                          lineHeight: 1.2,
                          cursor: "pointer",
                          minWidth: 90,
                          textAlign: "center",
                        }}
                        title="Join as a silent observer"
                      >
                        Join quietly
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.5)",
            textAlign: "center",
          }}
        >
          Internal use only. This dashboard may contain student information.
        </div>
      </section>

      <footer
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto 24px auto",
          textAlign: "center",
          fontSize: 11,
          lineHeight: 1.4,
          color: "rgba(255,255,255,0.4)",
        }}
      >
        © {new Date().getFullYear()} Apex Tutoring · Admin View
      </footer>
    </main>
  );
}
