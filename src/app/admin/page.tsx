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

type UserRow = {
  uid: string;
  displayName?: string;
  email?: string;
  role: Role;
  status?: "offline" | "waiting" | "busy";
  lastActiveAt?: number;
  roomId?: string;
  createdAt?: number;
};

export default function AdminPage() {
  const router = useRouter();

  // auth / role state
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<Role | null>(null);

  // tabs
  const [activeTab, setActiveTab] = useState<"sessions" | "tutors" | "students">(
    "sessions"
  );

  // live sessions
  const [liveSessions, setLiveSessions] = useState<SessionRow[]>([]);
  const sessionsUnsubRef = useRef<null | (() => void)>(null);

  // users
  const [tutors, setTutors] = useState<UserRow[]>([]);
  const [students, setStudents] = useState<UserRow[]>([]);
  const tutorsUnsubRef = useRef<null | (() => void)>(null);
  const studentsUnsubRef = useRef<null | (() => void)>(null);

  // search
  const [tutorQuery, setTutorQuery] = useState("");
  const [studentQuery, setStudentQuery] = useState("");

  // modal
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileUser, setProfileUser] = useState<UserRow | null>(null);

  // load auth + role, block non-admin
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      if (!fbUser) {
        router.replace("/auth?from=/admin");
        return;
      }

      setUserEmail(fbUser.email ?? null);

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

  // subscribe to active sessions (with fallback)
  useEffect(() => {
    if (checkingAuth || userRole !== "admin") return;

    const startListener = (qry: Query<DocumentData>, isFallback: boolean) => {
      if (sessionsUnsubRef.current) {
        sessionsUnsubRef.current();
        sessionsUnsubRef.current = null;
      }
      sessionsUnsubRef.current = onSnapshot(
        qry,
        (snap) => {
          const rows: SessionRow[] = [];
          snap.forEach((d) => {
            const data = d.data() as DocumentData;
            rows.push({
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
            });
          });
          const finalRows = isFallback ? rows.filter((r) => r.active) : rows;
          setLiveSessions(finalRows);
        },
        (err) => {
          if (!isFallback) {
            try {
              const fallbackQ = query(
                collection(db, "sessions"),
                orderBy("updatedAt", "desc"),
                limit(50)
              );
              startListener(fallbackQ, true);
              return;
            } catch {}
          }
          console.error("[admin sessions onSnapshot]", err);
          setLiveSessions([]);
        }
      );
    };

    try {
      const indexedQ = query(
        collection(db, "sessions"),
        where("active", "==", true),
        orderBy("updatedAt", "desc"),
        limit(50)
      );
      startListener(indexedQ, false);
    } catch {
      const fallbackQ = query(
        collection(db, "sessions"),
        orderBy("updatedAt", "desc"),
        limit(50)
      );
      startListener(fallbackQ, true);
    }

    return () => {
      if (sessionsUnsubRef.current) {
        sessionsUnsubRef.current();
        sessionsUnsubRef.current = null;
      }
    };
  }, [checkingAuth, userRole]);

  // subscribe to tutors & students (each with gentle fallbacks)
  useEffect(() => {
    if (checkingAuth || userRole !== "admin") return;

    const startUserListener = (
      role: "tutor" | "student",
      setFn: (rows: UserRow[]) => void,
      unsubRef: React.MutableRefObject<null | (() => void)>
    ) => {
      const start = (qry: Query<DocumentData>, _fallback: boolean) => {
        if (unsubRef.current) {
          unsubRef.current();
          unsubRef.current = null;
        }
        unsubRef.current = onSnapshot(
          qry,
          (snap) => {
            const rows: UserRow[] = [];
            snap.forEach((d) => {
              const v = d.data() as DocumentData;
              rows.push({
                uid: d.id,
                displayName: v.displayName,
                email: v.email,
                role: (v.role as Role) ?? "student",
                status: v.status,
                lastActiveAt:
                  typeof v.lastActiveAt === "number" ? (v.lastActiveAt as number) : undefined,
                roomId: typeof v.roomId === "string" ? v.roomId : undefined,
                createdAt: typeof v.createdAt === "number" ? v.createdAt : undefined,
              });
            });
            setFn(rows);
          },
          (err) => {
            console.warn(`[users ${role}] indexed query failed`, err);
            // fallback (no orderBy)
            try {
              const q2 = query(
                collection(db, "users"),
                where("role", "==", role),
                limit(300)
              );
              start(q2, true);
            } catch (err2) {
              console.error(`[users ${role}] fallback query failed`, err2);
              setFn([]);
            }
          }
        );
      };

      try {
        const q1 = query(
          collection(db, "users"),
          where("role", "==", role),
          orderBy("lastActiveAt", "desc"),
          limit(300)
        );
        start(q1, false);
      } catch {
        const q2 = query(collection(db, "users"), where("role", "==", role), limit(300));
        start(q2, true);
      }
    };

    startUserListener("tutor", setTutors, tutorsUnsubRef);
    startUserListener("student", setStudents, studentsUnsubRef);

    return () => {
      if (tutorsUnsubRef.current) {
        tutorsUnsubRef.current();
        tutorsUnsubRef.current = null;
      }
      if (studentsUnsubRef.current) {
        studentsUnsubRef.current();
        studentsUnsubRef.current = null;
      }
    };
  }, [checkingAuth, userRole]);

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  function joinQuietly(roomId: string) {
    const observerName = `Observer-${roomId}`;
    router.push(
      `/room?roomId=${encodeURIComponent(roomId)}&name=${encodeURIComponent(
        observerName
      )}`
    );
  }

  // helpers
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
  function ellipsis(s?: string, n = 24) {
    if (!s) return "—";
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  const bgPage = "#0f0f0f";
  const cardBg =
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(20,20,20,0.7) 60%)";

  if (checkingAuth) return null;

  // filtered lists
  const tq = tutorQuery.trim().toLowerCase();
  const sq = studentQuery.trim().toLowerCase();
  const tutorsShown = tutors.filter((u) =>
    !tq
      ? true
      : (u.displayName || "").toLowerCase().includes(tq) ||
        (u.email || "").toLowerCase().includes(tq)
  );
  const studentsShown = students.filter((u) =>
    !sq
      ? true
      : (u.displayName || "").toLowerCase().includes(sq) ||
        (u.email || "").toLowerCase().includes(sq)
  );

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
      {/* header */}
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
        <div style={{ color: "#fff", display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>
            Apex Tutoring
          </div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Admin Dashboard</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => router.push("/")}
            style={ghostButton}
          >
            Home
          </button>
          <button onClick={handleSignOut} style={ghostButton}>
            Sign out
          </button>
        </div>
      </header>

      {/* account summary */}
      <section
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          display: "grid",
          gap: "16px",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(320px,100%),1fr))",
        }}
      >
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
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Admin Account</div>
          <div style={{ opacity: 0.9 }}>
            <div><span style={{ opacity: 0.6 }}>Email: </span><span>{userEmail || "…"}</span></div>
            <div><span style={{ opacity: 0.6 }}>Role: </span><span>{userRole || "…"}</span></div>
            <div>
              <span style={{ opacity: 0.6 }}>Status: </span>
              <span style={{ color: userRole === "admin" ? "#6ecf9a" : "rgba(255,255,255,0.6)", fontWeight: 500 }}>
                {userRole === "admin" ? "Verified admin" : "—"}
              </span>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
            Only admins can view this page. Tutors / students get redirected.
          </div>
        </div>

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
          <div style={{ fontSize: 14, fontWeight: 600 }}>Live Classroom Overview</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
            You can:
            <ul style={{ marginTop: 4, marginBottom: 4, paddingLeft: 18, lineHeight: 1.5 }}>
              <li>See active sessions</li>
              <li>See tutor + which students are in each room</li>
              <li>Quiet join (monitor a session live)</li>
            </ul>
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
            Quiet join = you enter the LiveKit room as a muted observer.
          </div>
        </div>
      </section>

      {/* TABS */}
      <section
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* tab bar */}
        <div
          style={{
            display: "flex",
            gap: 8,
            borderBottom: "1px solid rgba(255,255,255,0.15)",
            paddingBottom: 8,
          }}
        >
          {[
            { id: "sessions", label: "Active Sessions" },
            { id: "tutors", label: "Tutors" },
            { id: "students", label: "Students" },
          ].map((t) => {
            const active = activeTab === (t.id as any);
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id as any)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: active ? "#3a6" : "#2a2a2a",
                  border: active ? "1px solid #6ecf9a" : "1px solid #444",
                  color: "#fff",
                  fontSize: 13,
                  lineHeight: 1.2,
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* tab content */}
        {activeTab === "sessions" && (
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
            {/* header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(180px,1.2fr) minmax(180px,1fr) minmax(160px,0.8fr) minmax(100px,auto)",
                gap: "12px",
                padding: "12px 16px",
                fontSize: 12,
                color: "rgba(255,255,255,0.6)",
                borderBottom: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              <div>Room / Tutor</div>
              <div>Students</div>
              <div>Started</div>
              <div>Action</div>
            </div>

            {/* rows */}
            <div style={{ fontSize: 13, color: "#fff" }}>
              {liveSessions.length === 0 ? (
                <div style={{ padding: 16, color: "rgba(255,255,255,0.6)" }}>
                  No live sessions right now.
                </div>
              ) : (
                liveSessions.map((s) => {
                  const studentList = s.students?.length
                    ? s.students.map((x) => x.name || x.id).join(", ")
                    : "—";
                  return (
                    <div
                      key={`${s.roomId}-${s.updatedAt ?? ""}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "minmax(180px,1.2fr) minmax(180px,1fr) minmax(160px,0.8fr) minmax(100px,auto)",
                        gap: "12px",
                        padding: "12px 16px",
                        borderBottom: "1px solid rgba(255,255,255,0.06)",
                        alignItems: "center",
                      }}
                    >
                      {/* room/tutor */}
                      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <div
                          title={s.roomId}
                          style={{
                            fontWeight: 500,
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            maxWidth: "100%",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {s.roomId}
                        </div>
                        <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 12 }}>
                          {s.tutorName || "Tutor"}{" "}
                          <span style={{ opacity: 0.6, fontWeight: 400 }}>
                            ({ellipsis(s.tutorEmail, 28)})
                          </span>
                        </div>
                        <div style={{ fontSize: 11, marginTop: 2, color: "#6ecf9a" }}>Active</div>
                      </div>

                      {/* students */}
                      <div
                        style={{
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0,
                        }}
                        title={studentList}
                      >
                        {studentList}
                      </div>

                      {/* started */}
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                        {formatTime(s.startedAt)}
                      </div>

                      {/* action */}
                      <div style={{ display: "flex", justifyContent: "flex-start" }}>
                        <button
                          onClick={() => joinQuietly(s.roomId)}
                          style={ghostButton}
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
        )}

        {activeTab === "tutors" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <input
                value={tutorQuery}
                onChange={(e) => setTutorQuery(e.target.value)}
                placeholder="Search tutors by name or email…"
                style={searchInput}
              />
            </div>

            <div style={tableShell}>
              <div style={tableHeader}>
                <div>Name / Email</div>
                <div>Status</div>
                <div>Last Active</div>
                <div>Room</div>
              </div>

              <div style={{ fontSize: 13, color: "#fff" }}>
                {tutorsShown.length === 0 ? (
                  <div style={{ padding: 16, color: "rgba(255,255,255,0.6)" }}>No tutors.</div>
                ) : (
                  tutorsShown.map((u) => (
                    <button
                      key={u.uid}
                      onClick={() => {
                        setProfileUser(u);
                        setProfileOpen(true);
                      }}
                      style={tableRowButton}
                    >
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 600 }}>{u.displayName || "—"}</div>
                        <div style={{ fontSize: 12, opacity: 0.85 }}>{u.email || "—"}</div>
                      </div>

                      <div style={{ fontSize: 12 }}>{u.status || "—"}</div>

                      <div style={{ fontSize: 12, opacity: 0.9 }}>{formatTime(u.lastActiveAt)}</div>

                      <div
                        style={{
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0,
                        }}
                        title={u.roomId}
                      >
                        {u.roomId ? u.roomId : "—"}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "students" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <input
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
                placeholder="Search students by name or email…"
                style={searchInput}
              />
            </div>

            <div style={tableShell}>
              <div style={tableHeader}>
                <div>Name / Email</div>
                <div>Status</div>
                <div>Last Active</div>
                <div>Room</div>
              </div>

              <div style={{ fontSize: 13, color: "#fff" }}>
                {studentsShown.length === 0 ? (
                  <div style={{ padding: 16, color: "rgba(255,255,255,0.6)" }}>No students.</div>
                ) : (
                  studentsShown.map((u) => (
                    <button
                      key={u.uid}
                      onClick={() => {
                        setProfileUser(u);
                        setProfileOpen(true);
                      }}
                      style={tableRowButton}
                    >
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 600 }}>{u.displayName || "—"}</div>
                        <div style={{ fontSize: 12, opacity: 0.85 }}>{u.email || "—"}</div>
                      </div>

                      <div style={{ fontSize: 12 }}>{u.status || "—"}</div>

                      <div style={{ fontSize: 12, opacity: 0.9 }}>{formatTime(u.lastActiveAt)}</div>

                      <div
                        style={{
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0,
                        }}
                        title={u.roomId}
                      >
                        {u.roomId ? u.roomId : "—"}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
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

      {/* PROFILE MODAL (opaque card, dimmed backdrop) */}
      {profileOpen && profileUser && (
        <>
          <div
            onClick={() => setProfileOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.65)",
              zIndex: 1000,
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(560px, 92vw)",
              background: "#161616",
              color: "#fff",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.2)",
              boxShadow: "0 30px 120px rgba(0,0,0,0.9)",
              zIndex: 1001,
              padding: 16,
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
              <div style={{ fontWeight: 700 }}>{profileUser.displayName || "Profile"}</div>
              <button onClick={() => setProfileOpen(false)} style={ghostButton}>
                Close
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr",
                rowGap: 8,
                columnGap: 12,
                fontSize: 13,
              }}
            >
              <div style={{ opacity: 0.6 }}>UID</div>
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={profileUser.uid}
              >
                {profileUser.uid}
              </div>

              <div style={{ opacity: 0.6 }}>Role</div>
              <div>{profileUser.role}</div>

              <div style={{ opacity: 0.6 }}>Email</div>
              <div>{profileUser.email || "—"}</div>

              <div style={{ opacity: 0.6 }}>Status</div>
              <div>{profileUser.status || "—"}</div>

              <div style={{ opacity: 0.6 }}>Last Active</div>
              <div>{formatTime(profileUser.lastActiveAt)}</div>

              <div style={{ opacity: 0.6 }}>Room</div>
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={profileUser.roomId}
              >
                {profileUser.roomId || "—"}
              </div>

              <div style={{ opacity: 0.6 }}>Created</div>
              <div>{formatTime(profileUser.createdAt)}</div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => profileUser?.email && navigator.clipboard.writeText(profileUser.email)}
                style={ghostButton}
              >
                Copy email
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/* --- tiny styles --- */
const ghostButton: React.CSSProperties = {
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

const searchInput: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #444",
  color: "#fff",
  padding: "8px 10px",
  borderRadius: 8,
  minWidth: 260,
  outline: "none",
};

const tableShell: React.CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.15)",
  background:
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.03) 0%, rgba(15,15,15,0.6) 70%)",
  boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
  overflowX: "auto",
};

const tableHeader: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px,1.4fr) minmax(120px,0.8fr) minmax(160px,0.8fr) minmax(160px,0.8fr)",
  gap: "12px",
  padding: "12px 16px",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
};

const tableRowButton: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px,1.4fr) minmax(120px,0.8fr) minmax(160px,0.8fr) minmax(160px,0.8fr)",
  gap: "12px",
  padding: "12px 16px",
  width: "100%",
  textAlign: "left" as const,
  background: "transparent",
  color: "#fff",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  cursor: "pointer",
};
