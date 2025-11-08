// src/app/admin/page.tsx
"use client";

import { useEffect, useRef, useState, useMemo } from "react";
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
  role: Role;
  displayName?: string;
  email?: string;
  status?: "offline" | "waiting" | "busy";
  lastActiveAt?: number;
  roomId?: string;
  createdAt?: number;
  // keep full doc in case you add more fields later
  _raw?: Record<string, any>;
};

export default function AdminPage() {
  const router = useRouter();

  // auth / role state
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<Role | null>(null);

  // live sessions
  const [liveSessions, setLiveSessions] = useState<SessionRow[]>([]);
  const unsubSessionsRef = useRef<null | (() => void)>(null);

  // users (tutors/students)
  const [tutors, setTutors] = useState<UserRow[]>([]);
  const [students, setStudents] = useState<UserRow[]>([]);
  const unsubTutorsRef = useRef<null | (() => void)>(null);
  const unsubStudentsRef = useRef<null | (() => void)>(null);

  // searching
  const [tutorQuery, setTutorQuery] = useState("");
  const [studentQuery, setStudentQuery] = useState("");

  // profile modal
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);

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

  // subscribe to sessions
  useEffect(() => {
    if (checkingAuth || userRole !== "admin") return;

    function startListener(qry: Query<DocumentData>, isFallback: boolean) {
      if (unsubSessionsRef.current) {
        unsubSessionsRef.current();
        unsubSessionsRef.current = null;
      }
      unsubSessionsRef.current = onSnapshot(
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
    }

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
      if (unsubSessionsRef.current) {
        unsubSessionsRef.current();
        unsubSessionsRef.current = null;
      }
    };
  }, [checkingAuth, userRole]);

  // subscribe to tutors
  useEffect(() => {
    if (checkingAuth || userRole !== "admin") return;

    function startListenerUsers(qry: Query<DocumentData>, isFallback: boolean, setRows: (v: UserRow[]) => void, roleWanted: Role) {
      const refHolder = roleWanted === "tutor" ? unsubTutorsRef : unsubStudentsRef;
      if (refHolder.current) {
        refHolder.current();
        refHolder.current = null;
      }
      const unsub = onSnapshot(
        qry,
        (snap) => {
          const rows: UserRow[] = [];
          snap.forEach((d) => {
            const data = d.data() as DocumentData;
            const row: UserRow = {
              uid: d.id,
              role: (data.role || "student") as Role,
              displayName: typeof data.displayName === "string" ? data.displayName : undefined,
              email: typeof data.email === "string" ? data.email : undefined,
              status: data.status,
              lastActiveAt: typeof data.lastActiveAt === "number" ? data.lastActiveAt : undefined,
              roomId: typeof data.roomId === "string" ? data.roomId : undefined,
              createdAt: typeof data.createdAt === "number" ? data.createdAt : undefined,
              _raw: data,
            };
            rows.push(row);
          });

          const finalRows = isFallback ? rows.filter((r) => r.role === roleWanted) : rows;
          setRows(
            finalRows.sort((a, b) => {
              const an = (a.displayName || a.email || a.uid).toLowerCase();
              const bn = (b.displayName || b.email || b.uid).toLowerCase();
              return an.localeCompare(bn);
            })
          );
        },
        (err) => {
          if (!isFallback) {
            try {
              const fallbackQ = query(collection(db, "users"), limit(300));
              startListenerUsers(fallbackQ, true, setRows, roleWanted);
              return;
            } catch {}
          }
          console.error(`[admin users ${roleWanted} onSnapshot]`, err);
          setRows([]);
        }
      );
      refHolder.current = unsub;
    }

    // Prefer index-friendly queries (role equality + limit) – no orderBy to avoid composite index need
    try {
      const tutorsQ = query(
        collection(db, "users"),
        where("role", "==", "tutor"),
        limit(300)
      );
      startListenerUsers(tutorsQ, false, setTutors, "tutor");
    } catch {
      const fbQ = query(collection(db, "users"), limit(300));
      startListenerUsers(fbQ, true, setTutors, "tutor");
    }

    try {
      const studentsQ = query(
        collection(db, "users"),
        where("role", "==", "student"),
        limit(500)
      );
      startListenerUsers(studentsQ, false, setStudents, "student");
    } catch {
      const fbQ = query(collection(db, "users"), limit(500));
      startListenerUsers(fbQ, true, setStudents, "student");
    }

    return () => {
      if (unsubTutorsRef.current) {
        unsubTutorsRef.current();
        unsubTutorsRef.current = null;
      }
      if (unsubStudentsRef.current) {
        unsubStudentsRef.current();
        unsubStudentsRef.current = null;
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

  const filteredTutors = useMemo(() => {
    const q = tutorQuery.trim().toLowerCase();
    if (!q) return tutors;
    return tutors.filter((u) => {
      const hay =
        `${u.displayName || ""} ${u.email || ""} ${u.uid}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tutors, tutorQuery]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students;
    return students.filter((u) => {
      const hay =
        `${u.displayName || ""} ${u.email || ""} ${u.uid}`.toLowerCase();
      return hay.includes(q);
    });
  }, [students, studentQuery]);

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
          <div style={{ fontSize: 11, opacity: 0.7 }}>Admin Dashboard</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => router.push("/")}
            style={ghostBtn}
          >
            Home
          </button>
          <button onClick={handleSignOut} style={ghostBtn}>
            Sign out
          </button>
        </div>
      </header>

      {/* admin account summary + overview */}
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
        <div style={cardStyle(cardBg)}>
          <div style={cardTitle}>Admin Account</div>

          <div style={{ opacity: 0.9, fontSize: 13 }}>
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
              <span style={{ color: "#6ecf9a", fontWeight: 500 }}>
                Verified admin
              </span>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
            Only admins can view this page. Tutors / students get redirected.
          </div>
        </div>

        {/* Live Classroom Overview card */}
        <div style={cardStyle(cardBg)}>
          <div style={cardTitle}>Live Classroom Overview</div>
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

      {/* Sessions table */}
      <section style={{ width: "100%", maxWidth: "1280px", margin: "0 auto" }}>
        <div style={sectionTitle}>Active Sessions</div>

        <div style={tableWrap}>
          {/* header */}
          <div style={tableHeaderGrid}>
            <div>Room / Tutor</div>
            <div>Students</div>
            <div>Started</div>
            <div>Action</div>
          </div>

          {/* rows */}
          <div style={{ fontSize: 13, lineHeight: 1.4, color: "#fff" }}>
            {liveSessions.length === 0 ? (
              <div style={{ padding: 16, color: "rgba(255,255,255,0.6)" }}>
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
                    style={tableRowGrid}
                  >
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

                    <div style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {studentList}
                    </div>

                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                      {formatTime(s.startedAt)}
                    </div>

                    <div style={{ display: "flex", alignItems: "flex-start" }}>
                      <button
                        onClick={() => joinQuietly(s.roomId)}
                        style={ghostBtnSmall}
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

        <div style={footNote}>
          Internal use only. This dashboard may contain student information.
        </div>
      </section>

      {/* Users: tutors + students */}
      <section
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto 24px",
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(520px,100%),1fr))",
        }}
      >
        {/* Tutors */}
        <div style={tableCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div style={sectionTitle}>All Tutors</div>
            <input
              value={tutorQuery}
              onChange={(e) => setTutorQuery(e.target.value)}
              placeholder="Search tutors by name or email…"
              style={searchInput}
            />
          </div>

          <div style={miniHeaderGrid}>
            <div>Name / Email</div>
            <div>Status</div>
            <div>Last Active</div>
            <div>Room</div>
          </div>

          <div>
            {filteredTutors.length === 0 ? (
              <div style={emptyRow}>No tutors found.</div>
            ) : (
              filteredTutors.map((u) => (
                <button
                  key={u.uid}
                  onClick={() => setSelectedUser(u)}
                  style={miniRowBtn}
                  title="View profile"
                >
                  <div style={{ display: "flex", flexDirection: "column", textAlign: "left" }}>
                    <div style={{ fontWeight: 600 }}>
                      {u.displayName || "—"}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{u.email || u.uid}</div>
                  </div>
                  <div style={{ fontSize: 12 }}>{u.status || "—"}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{formatTime(u.lastActiveAt)}</div>
                  <div style={{ fontSize: 12 }}>{u.roomId || "—"}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Students */}
        <div style={tableCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div style={sectionTitle}>All Students</div>
            <input
              value={studentQuery}
              onChange={(e) => setStudentQuery(e.target.value)}
              placeholder="Search students by name or email…"
              style={searchInput}
            />
          </div>

          <div style={miniHeaderGrid}>
            <div>Name / Email</div>
            <div>Status</div>
            <div>Last Active</div>
            <div>Room</div>
          </div>

          <div>
            {filteredStudents.length === 0 ? (
              <div style={emptyRow}>No students found.</div>
            ) : (
              filteredStudents.map((u) => (
                <button
                  key={u.uid}
                  onClick={() => setSelectedUser(u)}
                  style={miniRowBtn}
                  title="View profile"
                >
                  <div style={{ display: "flex", flexDirection: "column", textAlign: "left" }}>
                    <div style={{ fontWeight: 600 }}>
                      {u.displayName || "—"}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{u.email || u.uid}</div>
                  </div>
                  <div style={{ fontSize: 12 }}>{u.status || "—"}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{formatTime(u.lastActiveAt)}</div>
                  <div style={{ fontSize: 12 }}>{u.roomId || "—"}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      {/* PROFILE MODAL */}
      {selectedUser && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedUser(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 96vw)",
              background:
                "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.06) 0%, rgba(16,16,16,0.9) 70%)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 12,
              color: "#fff",
              padding: "16px 18px",
              boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {selectedUser.displayName || "Profile"}
              </div>
              <button onClick={() => setSelectedUser(null)} style={ghostBtnSmall}>
                Close
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(140px,1fr) minmax(180px,2fr)",
                gap: 10,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <div style={{ opacity: 0.7 }}>UID</div>
              <div style={{ wordBreak: "break-all" }}>{selectedUser.uid}</div>

              <div style={{ opacity: 0.7 }}>Role</div>
              <div>{selectedUser.role}</div>

              <div style={{ opacity: 0.7 }}>Email</div>
              <div>{selectedUser.email || "—"}</div>

              <div style={{ opacity: 0.7 }}>Status</div>
              <div>{selectedUser.status || "—"}</div>

              <div style={{ opacity: 0.7 }}>Last Active</div>
              <div>{formatTime(selectedUser.lastActiveAt)}</div>

              <div style={{ opacity: 0.7 }}>Room</div>
              <div>{selectedUser.roomId || "—"}</div>

              <div style={{ opacity: 0.7 }}>Created</div>
              <div>{formatTime(selectedUser.createdAt)}</div>
            </div>

            {/* Raw JSON (collapsed look) */}
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", opacity: 0.9 }}>Show raw document</summary>
              <pre
                style={{
                  marginTop: 8,
                  maxHeight: 260,
                  overflow: "auto",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 12,
                }}
              >
                {JSON.stringify(selectedUser._raw || {}, null, 2)}
              </pre>
            </details>

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {selectedUser.roomId && (
                <button
                  onClick={() => joinQuietly(selectedUser.roomId!)}
                  style={ghostBtn}
                  title="Join this user's room quietly (if live)"
                >
                  Join their room
                </button>
              )}
              {selectedUser.email && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(selectedUser.email!);
                  }}
                  style={ghostBtn}
                >
                  Copy email
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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

/* ---------- styles ---------- */
const ghostBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.2,
  minWidth: 80,
  cursor: "pointer",
};

const ghostBtnSmall: React.CSSProperties = {
  ...ghostBtn,
  minWidth: 90,
  fontSize: 12,
};

const cardStyle = (bg: string): React.CSSProperties => ({
  background: bg,
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
});

const cardTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 4,
  color: "#fff",
  lineHeight: 1.3,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#fff",
  lineHeight: 1.3,
  marginBottom: 12,
};

const tableWrap: React.CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.15)",
  background:
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.03) 0%, rgba(15,15,15,0.6) 70%)",
  boxShadow:
    "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
  overflowX: "auto",
};

const tableHeaderGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "minmax(140px,1fr) minmax(140px,1fr) minmax(160px,1fr) minmax(80px,auto)",
  gap: "12px",
  padding: "12px 16px",
  fontSize: 12,
  lineHeight: 1.3,
  color: "rgba(255,255,255,0.6)",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
};

const tableRowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "minmax(140px,1fr) minmax(140px,1fr) minmax(160px,1fr) minmax(80px,auto)",
  gap: "12px",
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const footNote: React.CSSProperties = {
  marginTop: 16,
  fontSize: 11,
  lineHeight: 1.4,
  color: "rgba(255,255,255,0.5)",
  textAlign: "center",
};

const tableCard: React.CSSProperties = {
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.15)",
  background:
    "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.03) 0%, rgba(15,15,15,0.6) 70%)",
  boxShadow:
    "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
  padding: 16,
};

const miniHeaderGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px,2fr) minmax(100px,1fr) minmax(120px,1fr) minmax(80px,1fr)",
  gap: 12,
  padding: "10px 12px",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  borderTop: "1px solid rgba(255,255,255,0.12)",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  marginTop: 8,
};

const miniRowBtn: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px,2fr) minmax(100px,1fr) minmax(120px,1fr) minmax(80px,1fr)",
  gap: 12,
  padding: "10px 12px",
  width: "100%",
  background: "transparent",
  border: "none",
  color: "#fff",
  textAlign: "left",
  cursor: "pointer",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const emptyRow: React.CSSProperties = {
  padding: 12,
  color: "rgba(255,255,255,0.6)",
  fontSize: 13,
};

const searchInput: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(0,0,0,0.25)",
  color: "#fff",
  outline: "none",
  minWidth: 220,
  fontSize: 13,
};
