// src/app/admin/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
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
  where,
  getDoc,
  doc as fsDoc,
  Query,
  DocumentData,
} from "firebase/firestore";

type Role = "tutor" | "student" | "admin";

type SessionRow = {
  roomId: string;
  active: boolean;
  tutorUid?: string;
  tutorName?: string;
  tutorEmail?: string;
  students: { id: string; name: string }[];
  studentsCount: number;
  startedAt?: number;
  updatedAt?: number;
};

export default function AdminPage() {
  const router = useRouter();

  // auth / role state
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<Role | null>(null);

  // live sessions
  const [liveSessions, setLiveSessions] = useState<SessionRow[]>([]);
  const unsubRef = useRef<null | (() => void)>(null);

  // load auth + role, block non-admin
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        router.replace("/auth?from=/admin");
        return;
      }

      setUserEmail(fbUser.email ?? null);

      // check role from users/{uid}
      try {
        const snap = await getDoc(fsDoc(db, "users", fbUser.uid));
        const role = (snap.data()?.role || "student") as Role;
        setUserRole(role);

        if (role !== "admin") {
          router.replace("/");
          return;
        }
      } catch {
        router.replace("/");
        return;
      }

      setCheckingAuth(false);
    });
    return unsub;
  }, [router]);

  // subscribe to sessions; prefer indexed query, fallback to client-side filter
  useEffect(() => {
    if (checkingAuth || userRole !== "admin") return;

    function startListener(qry: Query<DocumentData>, isFallback: boolean) {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      unsubRef.current = onSnapshot(
        qry,
        (snap) => {
          const rows: SessionRow[] = [];
          snap.forEach((d) => {
            const data = d.data() as DocumentData;
            const row: SessionRow = {
              roomId: (data.roomId as string) || d.id,
              active: !!data.active,
              tutorUid: data.tutorUid,
              tutorName: data.tutorName,
              tutorEmail: data.tutorEmail,
              students: Array.isArray(data.students) ? data.students : [],
              studentsCount:
                typeof data.studentsCount === "number"
                  ? data.studentsCount
                  : Array.isArray(data.students)
                  ? data.students.length
                  : 0,
              startedAt: typeof data.startedAt === "number" ? data.startedAt : undefined,
              updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : undefined,
            };
            rows.push(row);
          });

          // If we're on the fallback (no where clause), filter to active here.
          const finalRows = isFallback ? rows.filter((r) => r.active) : rows;

          setLiveSessions(finalRows);
        },
        (err) => {
          // If the "indexed" query fails (likely missing composite index),
          // fall back to a query that needs no index and filter on the client.
          if (!isFallback) {
            try {
              const fallbackQ = query(
                collection(db, "sessions"),
                orderBy("updatedAt", "desc"),
                limit(50)
              );
              startListener(fallbackQ, true);
              return;
            } catch {
              // ignore and show nothing
            }
          }
          console.error("[admin sessions onSnapshot]", err);
          setLiveSessions([]);
        }
      );
    }

    // Try the indexed query first:
    try {
      const indexedQ = query(
        collection(db, "sessions"),
        where("active", "==", true),
        orderBy("updatedAt", "desc"),
        limit(50)
      );
      startListener(indexedQ, false);
    } catch {
      // If constructing the query itself throws (rare), immediately fallback.
      const fallbackQ = query(
        collection(db, "sessions"),
        orderBy("updatedAt", "desc"),
        limit(50)
      );
      startListener(fallbackQ, true);
    }

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [checkingAuth, userRole]);

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  function joinQuietly(roomId: string) {
    // Admins join /room with mic/cam auto-muted in observer mode (handled by room page).
    const observerName = `Observer-${roomId}`;
    router.push(
      `/room?roomId=${encodeURIComponent(roomId)}&name=${encodeURIComponent(
        observerName
      )}`
    );
  }

  // ------ UI helpers ------
  function formatTime(ts?: number) {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "—";
    }
  }

  const bgPage = "#0f0f0f";
  const cardBg =
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)";

  if (checkingAuth) return null;

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
          Active Sessions
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
                "minmax(140px,1fr) minmax(140px,1fr) minmax(160px,1fr) minmax(80px,auto)",
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
            {liveSessions.length === 0 ? (
              <div
                style={{
                  padding: "16px",
                  fontSize: 13,
                  color: "rgba(255,255,255,0.6)",
                }}
              >
                No live sessions right now.
              </div>
            ) : (
              liveSessions.map((s) => {
                const studentList =
                  s.students?.length
                    ? s.students.map((x) => x.name || x.id).join(", ")
                    : "—";
                return (
                  <div
                    key={`${s.roomId}-${s.updatedAt ?? ""}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(140px,1fr) minmax(140px,1fr) minmax(160px,1fr) minmax(80px,auto)",
                      gap: "12px",
                      padding: "12px 16px",
                      borderBottom: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    {/* Room / Tutor */}
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{s.roomId || "—"}</div>
                      <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 12 }}>
                        {s.tutorName || "Tutor"}{" "}
                        <span style={{ opacity: 0.6, fontWeight: 400 }}>
                          ({s.tutorEmail || "—"})
                        </span>
                      </div>
                      <div style={{ fontSize: 11, marginTop: 2, color: "#6ecf9a" }}>
                        Active
                      </div>
                    </div>

                    {/* Students */}
                    <div
                      style={{
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {studentList}
                    </div>

                    {/* Started */}
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                      {formatTime(s.startedAt)}
                    </div>

                    {/* Action */}
                    <div style={{ display: "flex", alignItems: "flex-start" }}>
                      <button
                        onClick={() => joinQuietly(s.roomId)}
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
