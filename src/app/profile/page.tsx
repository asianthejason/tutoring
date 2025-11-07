// src/app/profile/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";

type Role = "student" | "tutor" | "admin";
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

type TimeRange = { start: string; end: string }; // "HH:mm" 24h
type Availability = Record<DayKey, TimeRange[]>;

type UserDoc = {
  email: string;
  role: Role;
  displayName?: string;
  timezone?: string;
  availability?: Availability; // tutors
  gradeLevel?: string; // students
};

const DAYS: { key: DayKey; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

function emptyAvailability(): Availability {
  return {
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
}

export default function ProfileSettingsPage() {
  const router = useRouter();

  // auth
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<Role | null>(null);

  // common
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState<string>("");

  // student
  const [gradeLevel, setGradeLevel] = useState<string>("");

  // tutor
  const [availability, setAvailability] = useState<Availability>(emptyAvailability());

  // password
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState(""); // for reauth fallback
  const [pwMessage, setPwMessage] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Load auth + user doc
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/auth");
        return;
      }
      setUid(user.uid);
      setEmail(user.email ?? "");

      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.data() as UserDoc | undefined;

      const r: Role = (data?.role as Role) || "student";
      setRole(r);
      setDisplayName(data?.displayName || (user.email?.split("@")[0] ?? ""));
      setTimezone(data?.timezone || guessTimezone());

      if (r === "student") {
        setGradeLevel(data?.gradeLevel || "");
      }
      if (r === "tutor") {
        setAvailability({
          ...emptyAvailability(),
          ...(data?.availability || {}),
        });
      }

      setLoading(false);
    });
    return unsub;
  }, [router]);

  function guessTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  async function saveCommon() {
    if (!uid) return;
    setSaving(true);
    setSaveMsg("");

    const payload: Partial<UserDoc> = {
      displayName: displayName.trim() || email.split("@")[0],
      timezone: timezone || guessTimezone(),
      // write a heartbeat field for auditing
      // @ts-ignore
      profileUpdatedAt: serverTimestamp(),
    };

    try {
      await updateDoc(doc(db, "users", uid), payload as any);
      setSaveMsg("Saved ✓");
    } catch {
      // If doc might not exist (older accounts), setDoc with merge
      await setDoc(doc(db, "users", uid), payload as any, { merge: true });
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(""), 1500);
    }
  }

  async function saveStudent() {
    if (!uid) return;
    setSaving(true);
    setSaveMsg("");
    try {
      await updateDoc(doc(db, "users", uid), {
        gradeLevel: gradeLevel || "",
        // @ts-ignore
        profileUpdatedAt: serverTimestamp(),
      });
      setSaveMsg("Saved ✓");
    } catch {
      await setDoc(
        doc(db, "users", uid),
        { gradeLevel: gradeLevel || "", profileUpdatedAt: serverTimestamp() as any },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(""), 1500);
    }
  }

  function addTimeRange(day: DayKey) {
    setAvailability((prev) => ({
      ...prev,
      [day]: [...prev[day], { start: "16:00", end: "17:00" }],
    }));
  }

  function updateRange(day: DayKey, idx: number, field: "start" | "end", value: string) {
    setAvailability((prev) => {
      const copy = { ...prev };
      copy[day] = copy[day].map((r, i) => (i === idx ? { ...r, [field]: value } : r));
      return copy;
    });
  }

  function removeRange(day: DayKey, idx: number) {
    setAvailability((prev) => {
      const copy = { ...prev };
      copy[day] = copy[day].filter((_, i) => i !== idx);
      return copy;
    });
  }

  function isRangeValid(r: TimeRange) {
    return r.start < r.end;
  }

  async function saveTutor() {
    if (!uid) return;
    // basic validation
    for (const d of DAYS) {
      for (const r of availability[d.key]) {
        if (!isRangeValid(r)) {
          setSaveMsg(`Invalid time range on ${d.label}`);
          return;
        }
      }
    }

    setSaving(true);
    setSaveMsg("");
    try {
      await updateDoc(doc(db, "users", uid), {
        availability,
        timezone: timezone || guessTimezone(),
        // @ts-ignore
        profileUpdatedAt: serverTimestamp(),
      });
      setSaveMsg("Saved ✓");
    } catch {
      await setDoc(
        doc(db, "users", uid),
        { availability, timezone: timezone || guessTimezone(), profileUpdatedAt: serverTimestamp() as any },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(""), 1500);
    }
  }

  async function handleChangePassword() {
    setPwMessage("");
    const user = auth.currentUser;
    if (!user) return;

    if (!newPassword || newPassword.length < 6) {
      setPwMessage("Password must be at least 6 characters.");
      return;
    }

    try {
      await updatePassword(user, newPassword);
      setPwMessage("Password updated ✓");
      setNewPassword("");
      setCurrentPassword("");
    } catch (err: any) {
      // If we need recent login, try reauth with the current password the user entered
      if (err?.code === "auth/requires-recent-login") {
        if (!email || !currentPassword) {
          setPwMessage("Please enter your current password to re-authenticate.");
          return;
        }
        try {
          const cred = EmailAuthProvider.credential(email, currentPassword);
          await reauthenticateWithCredential(user, cred);
          await updatePassword(user, newPassword);
          setPwMessage("Password updated ✓");
          setNewPassword("");
          setCurrentPassword("");
        } catch (e2: any) {
          setPwMessage(e2?.message || "Re-authentication failed.");
        }
      } else {
        setPwMessage(err?.message || "Could not update password.");
      }
    }
  }

  const headerRight = useMemo(
    () => (
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={ghostButton}
          onClick={() => router.push("/")}
          title="Home"
        >
          ← Home
        </button>
        <button
          style={ghostButton}
          onClick={() =>
            router.push(
              role === "tutor"
                ? "/dashboard/tutor"
                : role === "admin"
                ? "/admin"
                : "/dashboard/student"
            )
          }
          title="Dashboard"
        >
          Dashboard
        </button>
      </div>
    ),
    [router, role]
  );

  if (loading) {
    return (
      <main style={pageShell}>
        <header style={headerBar}>
          <Brand />
          <div style={{ color: "#aaa", fontSize: 13 }}>Loading…</div>
        </header>
      </main>
    );
  }

  return (
    <main style={pageShell}>
      {/* Header */}
      <header style={headerBar}>
        <Brand />
        {headerRight}
      </header>

      {/* Body */}
      <section style={bodyGrid}>
        {/* Profile card (everyone) */}
        <Card>
          <CardTitle>Profile</CardTitle>
          <Field label="Email">
            <input disabled value={email} style={input} />
          </Field>
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={input}
              placeholder="Your name"
            />
          </Field>
          <Field label="Timezone">
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={input}
              placeholder="America/Edmonton"
              list="tzlist"
            />
            <datalist id="tzlist">
              <option value="America/Edmonton" />
              <option value="America/Denver" />
              <option value="America/Los_Angeles" />
              <option value="America/Chicago" />
              <option value="America/New_York" />
              <option value="UTC" />
            </datalist>
          </Field>
          <div style={row}>
            <button onClick={saveCommon} style={primaryBtn} disabled={saving}>
              Save Profile
            </button>
            {saveMsg && <div style={muted}>{saveMsg}</div>}
          </div>
        </Card>

        {/* Student section */}
        {role === "student" && (
          <Card>
            <CardTitle>Student Details</CardTitle>
            <Field label="Grade level">
              <select
                value={gradeLevel}
                onChange={(e) => setGradeLevel(e.target.value)}
                style={select}
              >
                <option value="">Select…</option>
                {[
                  "Grade 4","Grade 5","Grade 6","Grade 7","Grade 8","Grade 9",
                  "Grade 10","Grade 11","Grade 12","IB / AP"
                ].map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </Field>
            <div style={row}>
              <button onClick={saveStudent} style={primaryBtn} disabled={saving}>
                Save Student Info
              </button>
              {saveMsg && <div style={muted}>{saveMsg}</div>}
            </div>
          </Card>
        )}

        {/* Tutor section */}
        {role === "tutor" && (
          <Card>
            <CardTitle>Tutor Availability</CardTitle>
            <div style={{ fontSize: 12, color: "#bbb", marginBottom: 10 }}>
              Times are saved in your timezone (<strong>{timezone || "UTC"}</strong>). Add one or
              more ranges per day (24-hour format).
            </div>
            <div style={availGrid}>
              {DAYS.map(({ key, label }) => (
                <div key={key} style={availCol}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 6 }}>{label}</div>
                  {(availability[key] ?? []).map((r, i) => (
                    <div key={i} style={rangeRow}>
                      <input
                        type="time"
                        value={r.start}
                        onChange={(e) => updateRange(key, i, "start", e.target.value)}
                        style={timeInput}
                      />
                      <span style={{ color: "#888" }}>–</span>
                      <input
                        type="time"
                        value={r.end}
                        onChange={(e) => updateRange(key, i, "end", e.target.value)}
                        style={timeInput}
                      />
                      <button onClick={() => removeRange(key, i)} style={smallGhostBtn}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button onClick={() => addTimeRange(key)} style={smallAddBtn}>
                    + Add time
                  </button>
                </div>
              ))}
            </div>
            <div style={row}>
              <button onClick={saveTutor} style={primaryBtn} disabled={saving}>
                Save Availability
              </button>
              {saveMsg && <div style={muted}>{saveMsg}</div>}
            </div>
          </Card>
        )}

        {/* Password */}
        <Card>
          <CardTitle>Change Password</CardTitle>
          <Field label="New password">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={input}
              placeholder="••••••••"
            />
          </Field>
          <Field label="Current password (only if asked)">
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              style={input}
              placeholder="Needed if re-authentication required"
            />
          </Field>
          <div style={row}>
            <button onClick={handleChangePassword} style={primaryBtn}>
              Update Password
            </button>
            {pwMessage && <div style={{ ...muted, maxWidth: 420 }}>{pwMessage}</div>}
          </div>
        </Card>
      </section>
    </main>
  );
}

/* ----------------- tiny UI helpers ----------------- */

const pageShell: React.CSSProperties = {
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
};

const headerBar: React.CSSProperties = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto 16px",
  padding: "16px 24px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderRadius: 12,
  background: "linear-gradient(to right, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
  border: "1px solid rgba(255,255,255,0.15)",
  boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
};

function Brand() {
  return (
    <div style={{ color: "#fff", display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
      <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>Profile & Settings</div>
    </div>
  );
}

const bodyGrid: React.CSSProperties = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: 16,
};

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 12,
        background: "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
        padding: "16px 16px 14px",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em", marginBottom: 4 }}>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>{label}</div>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "#111",
  border: "1px solid #444",
  color: "#fff",
  fontSize: 14,
  lineHeight: 1.4,
  outline: "none",
};

const select: React.CSSProperties = { ...input, appearance: "none" };

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const primaryBtn: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  background: "#3a6",
  border: "1px solid #6ecf9a",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

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

const muted: React.CSSProperties = { color: "#a5b0a9", fontSize: 12 };

const availGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const availCol: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 10,
};

const rangeRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 6,
};

const timeInput: React.CSSProperties = {
  ...input,
  width: "100%",
  padding: "8px 10px",
};

const smallAddBtn: React.CSSProperties = {
  ...ghostButton,
  padding: "6px 8px",
  fontSize: 12,
};

const smallGhostBtn: React.CSSProperties = {
  ...ghostButton,
  padding: "6px 8px",
  fontSize: 12,
};
