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
  firstName?: string;
  lastName?: string;
  timezone?: string;
  availability?: Availability; // tutors
  gradeLevel?: string;         // students
  intro?: string;              // tutors
  birthday?: string;           // yyyy-mm-dd
  country?: string;            // tutors
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
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

const TZ_FALLBACK = [
  "America/Edmonton","America/Vancouver","America/Denver","America/Chicago",
  "America/New_York","UTC","Europe/London","Europe/Paris","Asia/Hong_Kong",
  "Asia/Shanghai","Asia/Tokyo","Australia/Sydney"
];
function getTimezones(): string[] {
  try {
    // @ts-ignore
    const list: string[] = Intl.supportedValuesOf?.("timeZone") || TZ_FALLBACK;
    return list.slice().sort((a,b) => a.localeCompare(b));
  } catch {
    return TZ_FALLBACK;
  }
}

// ISO 3166-ish country list (UN members + a few common territories)
const ALL_COUNTRIES = [
  "Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda","Argentina","Armenia","Australia","Austria",
  "Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia",
  "Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia",
  "Cameroon","Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo (Congo-Brazzaville)",
  "Costa Rica","Côte d’Ivoire","Croatia","Cuba","Cyprus","Czechia","Democratic Republic of the Congo","Denmark","Djibouti",
  "Dominica","Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini",
  "Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany","Ghana","Greece","Grenada","Guatemala",
  "Guinea","Guinea-Bissau","Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland",
  "Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Kuwait","Kyrgyzstan","Laos","Latvia",
  "Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Madagascar","Malawi","Malaysia",
  "Maldives","Mali","Malta","Marshall Islands","Mauritania","Mauritius","Mexico","Micronesia","Moldova","Monaco",
  "Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","New Zealand",
  "Nicaragua","Niger","Nigeria","North Korea","North Macedonia","Norway","Oman","Pakistan","Palau","Panama",
  "Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda",
  "Saint Kitts and Nevis","Saint Lucia","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome and Principe",
  "Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Slovakia","Slovenia","Solomon Islands",
  "Somalia","South Africa","South Korea","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland",
  "Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo","Tonga","Trinidad and Tobago","Tunisia",
  "Turkey","Turkmenistan","Tuvalu","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay",
  "Uzbekistan","Vanuatu","Vatican City","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe",
  // Common territories / regions often used by users
  "Hong Kong","Macau","Puerto Rico","Greenland","Aruba","Bermuda","Cayman Islands","Curacao","Faroe Islands",
  "Gibraltar","Guernsey","Isle of Man","Jersey","Kosovo","New Caledonia","Northern Mariana Islands","Reunion",
  "French Polynesia","Guadeloupe","Martinique","Mayotte"
];

export default function ProfileSettingsPage() {
  const router = useRouter();

  // auth
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<Role | null>(null);

  // common
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState<string>("");
  const [tzOptions] = useState<string[]>(getTimezones());

  // live clock tick (updates current time text)
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000); // refresh every 30s
    return () => clearInterval(id);
  }, []);
  const currentTimeInTZ = useMemo(() => {
    try {
      return new Date().toLocaleTimeString(undefined, {
        timeZone: timezone || "UTC",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [timezone]);

  // student
  const [gradeLevel, setGradeLevel] = useState<string>("");

  // tutor-only extras
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [intro, setIntro] = useState<string>("");
  const [birthday, setBirthday] = useState<string>("");
  const [country, setCountry] = useState<string>("");

  const [availability, setAvailability] = useState<Availability>(emptyAvailability());

  // password
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
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

      const initialDisplay =
        data?.displayName || (user.email?.split("@")[0] ?? "");
      setDisplayName(initialDisplay);

      setTimezone(data?.timezone || guessTimezone());

      if (r === "student") {
        setGradeLevel(data?.gradeLevel || "");
      }
      if (r === "tutor") {
        setAvailability({ ...emptyAvailability(), ...(data?.availability || {}) });
        setFirstName(data?.firstName || "");
        setLastName(data?.lastName || "");
        setIntro(data?.intro || "");
        setBirthday(data?.birthday || "");
        setCountry(data?.country || "");
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
      ...(role === "tutor"
        ? {
            firstName: firstName.trim() || undefined,
            lastName: lastName.trim() || undefined,
            intro: intro.trim() || "",
            birthday: birthday || "",
            country: country.trim() || "",
          }
        : {}),
      // @ts-ignore
      profileUpdatedAt: serverTimestamp(),
    };

    try {
      await updateDoc(doc(db, "users", uid), payload as any);
      setSaveMsg("Saved ✓");
    } catch {
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
    // validate ranges
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
        <button style={ghostButton} onClick={() => router.push("/")} title="Home">
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
      {/* make date icon white for dark UI */}
      <style jsx global>{`
        input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(1);
        }
      `}</style>

      {/* Header */}
      <header style={headerBar}>
        <Brand />
        {headerRight}
      </header>

      {/* Body */}
      <section style={bodyGrid}>
        {/* Profile + Tutor details on the LEFT */}
        <Card>
          <CardTitle>Profile</CardTitle>

          <Field label="Email">
            <input disabled value={email} style={input} />
          </Field>

          {role === "tutor" && (
            <div style={twoCol}>
              <Field label="First name">
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  style={input}
                  placeholder="Jane"
                />
              </Field>
              <Field label="Last name">
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  style={input}
                  placeholder="Doe"
                />
              </Field>
            </div>
          )}

          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={input}
              placeholder="Your name"
            />
          </Field>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
              Timezone{" "}
              <span style={{ color: "#a5b0a9" }}>
                (Current time: <strong style={{ color: "#fff" }}>{currentTimeInTZ}</strong>)
              </span>
            </div>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={select}
            >
              {(!timezone || !tzOptions.includes(timezone)) && (
                <option value="">{timezone || "Select a timezone…"}</option>
              )}
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>

          {role === "tutor" && (
            <>
              <CardTitle>Tutor Details</CardTitle>

              <Field label="Tutor introduction">
                <textarea
                  value={intro}
                  onChange={(e) => setIntro(e.target.value)}
                  style={textarea}
                  placeholder="Write a short introduction students will see (teaching style, subjects, achievements, etc.)"
                  rows={5}
                />
              </Field>

              <div style={twoCol}>
                <Field label="Birthday">
                  <input
                    type="date"
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    style={input}
                  />
                </Field>

                <Field label="Country of residence">
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    style={select}
                  >
                    <option value="">Select a country…</option>
                    {ALL_COUNTRIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}

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

        {/* Availability on the RIGHT */}
        {role === "tutor" && (
          <Card>
            <CardTitle>Tutor Availability</CardTitle>
            <div style={{ fontSize: 12, color: "#bbb", marginTop: -6 }}>
              Times are saved in your timezone (<strong>{timezone || "UTC"}</strong>). Add one or
              more ranges per day (24-hour format).
            </div>

            <div style={availGrid}>
              {DAYS.map(({ key, label }) => (
                <div key={key} style={availCol}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 8 }}>{label}</div>

                  {(availability[key] ?? []).map((r, i) => (
                    <div key={i} style={rangeRow}>
                      <input
                        type="time"
                        value={r.start}
                        onChange={(e) => updateRange(key, i, "start", e.target.value)}
                        style={timeInput}
                      />
                      <span style={{ color: "#888", textAlign: "center" }}>–</span>
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
                Save Tutor Details & Availability
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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

const textarea: React.CSSProperties = {
  ...input,
  resize: "vertical",
  minHeight: 110,
};

const select: React.CSSProperties = {
  ...input,
  appearance: "none",
};

const twoCol: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))",
  gap: 10,
};

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

/* Availability layout (no overlap) */
const availGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginTop: 8,
};

const availCol: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rangeRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(90px,1fr) 18px minmax(90px,1fr) auto",
  alignItems: "center",
  columnGap: 8,
};

const timeInput: React.CSSProperties = { ...input, padding: "8px 10px", width: "100%" };

const smallAddBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12, width: "fit-content" };
const smallGhostBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12, width: "fit-content" };
