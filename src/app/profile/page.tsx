// /src/app/profile/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  User,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  increment,
  collection,
  getDocs,
  query as fsQuery,
  orderBy,
  limit as fsLimit,
  startAfter,
  DocumentData,
  QueryDocumentSnapshot,
} from "firebase/firestore";

// Stripe (client)
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";

/* ===================== Types ===================== */

type Role = "student" | "tutor" | "admin";
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type TimeRange = { start: string; end: string }; // "HH:mm"
type Availability = Record<DayKey, TimeRange[]>;

type UserDoc = {
  email: string;
  role: Role;
  displayName?: string;

  // Common
  firstName?: string;
  lastName?: string;
  birthday?: string; // yyyy-mm-dd
  country?: string;
  timezone?: string;

  // Tutor
  availability?: Availability;
  tutorIntro?: string;
  paypalEmail?: string;

  // Student
  gradeLevel?: string;
  minutesBalance?: number;

  // Audit
  profileUpdatedAt?: any;
};

// ---- Payment result types & guard ----
type PaymentSuccess = { hours: number; paymentId: string };
type PaymentError = { message: string };
function isPaymentSuccess(p: unknown): p is PaymentSuccess {
  return !!p && typeof p === "object" && "hours" in (p as any) && "paymentId" in (p as any);
}

/* ===================== Constants ===================== */

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

const COUNTRIES = [
  "Canada","United States","Mexico","United Kingdom","Australia","New Zealand","Singapore","Hong Kong",
  "China","Taiwan","Japan","South Korea","India","Philippines","Vietnam","Thailand","Malaysia","Indonesia",
  "France","Germany","Spain","Italy","Netherlands","Sweden","Norway","Denmark","Finland","Poland","Portugal",
  "Brazil","Argentina","Chile","Colombia","Peru","South Africa","Nigeria","Kenya","Egypt","Turkey","UAE",
  "Saudi Arabia","Israel","Ireland","Switzerland","Austria","Belgium","Czechia","Greece","Hungary",
];

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";

const STUDENT_PACKAGES: {
  id: "1h" | "5h" | "10h" | "20h" | "40h";
  label: string;
  hours: number;
  price: number; // USD
}[] = [
  { id: "1h",  label: "1 hour",  hours: 1,  price: 55 },
  { id: "5h",  label: "5 hours", hours: 5,  price: 265 },
  { id: "10h", label: "10 hours",hours: 10, price: 500 },
  { id: "20h", label: "20 hours",hours: 20, price: 900 },
  { id: "40h", label: "40 hours",hours: 40, price: 1600 },
];

/* ===================== Helpers ===================== */

function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function allTimezones(): string[] {
  try {
    // @ts-ignore
    if (Intl.supportedValuesOf) {
      // @ts-ignore
      const tzs = Intl.supportedValuesOf("timeZone") as string[];
      if (Array.isArray(tzs) && tzs.length > 0) return tzs;
    }
  } catch {}
  return [
    "UTC",
    // Americas
    "America/St_Johns","America/Halifax","America/Toronto","America/Winnipeg","America/Edmonton","America/Vancouver",
    "America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Phoenix","America/Anchorage","America/Adak","Pacific/Honolulu",
    "America/Mexico_City","America/Bogota","America/Lima","America/Caracas","America/Santiago","America/Sao_Paulo","America/Buenos_Aires",
    // Europe/Africa
    "Europe/London","Europe/Dublin","Europe/Lisbon","Europe/Madrid","Europe/Paris","Europe/Berlin","Europe/Rome","Europe/Amsterdam","Europe/Brussels",
    "Europe/Zurich","Europe/Stockholm","Europe/Oslo","Europe/Copenhagen","Europe/Helsinki","Europe/Athens","Europe/Bucharest","Europe/Sofia",
    "Europe/Kiev","Europe/Warsaw","Europe/Prague","Europe/Vienna","Europe/Budapest","Europe/Moscow","Africa/Cairo","Africa/Johannesburg",
    // Middle East / Asia
    "Asia/Jerusalem","Asia/Istanbul","Europe/Istanbul","Asia/Dubai","Asia/Kolkata","Asia/Karachi","Asia/Dhaka","Asia/Bangkok","Asia/Jakarta",
    "Asia/Ho_Chi_Minh","Asia/Kuala_Lumpur","Asia/Singapore","Asia/Hong_Kong","Asia/Taipei","Asia/Manila","Asia/Tokyo","Asia/Seoul",
    "Asia/Shanghai","Asia/Chongqing","Asia/Urumqi",
    // Oceania
    "Australia/Adelaide","Australia/Brisbane","Australia/Sydney","Australia/Melbourne","Australia/Perth","Pacific/Auckland","Pacific/Guam","Pacific/Fiji",
  ];
}
const ALL_TIMEZONES = allTimezones();

function formatNowInTZ(tz: string) {
  try {
    return new Date().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || "UTC",
    });
  } catch {
    return "";
  }
}
function fmtUsd(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD`;
}
function fmtDate(d?: Date | null) {
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ===================== Main Component ===================== */

export default function ProfileSettingsPage() {
  const router = useRouter();

  // auth
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<Role | null>(null);

  // common
  const [displayName, setDisplayName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [birthday, setBirthday]   = useState("");
  const [country, setCountry]     = useState("");
  const [timezone, setTimezone]   = useState<string>("");

  // student
  const [gradeLevel, setGradeLevel] = useState<string>("");
  const [minutesBalance, setMinutesBalance] = useState<number>(0);

  // purchase history (student)
  type Purchase = {
    id: string;
    hours: number;
    amountUsd: number;
    method: string;
    createdAt?: Date | null;
  };
  const PAGE_SIZE = 10;
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [historyCursor, setHistoryCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);

  // tutor
  const [availability, setAvailability] = useState<Availability>(emptyAvailability());
  const [tutorIntro, setTutorIntro] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");

  // password
  const [currPw, setCurrPw] = useState("");
  const [newPw, setNewPw]   = useState("");
  const [pwMessage, setPwMessage] = useState("");

  // payments (student)
  const [selectedPkg, setSelectedPkg] = useState<typeof STUDENT_PACKAGES[number]>(STUDENT_PACKAGES[0]);
  const [cardholder, setCardholder] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState("");

  // misc
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Stripe
  const stripePromise = useMemo(
    () => (STRIPE_PK ? loadStripe(STRIPE_PK) : null),
    []
  );

  // Load user and initial history page
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user: User | null) => {
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

      // common
      setDisplayName(data?.displayName || (user.email?.split("@")[0] ?? ""));
      setTimezone(data?.timezone || guessTimezone());
      setFirstName(data?.firstName || "");
      setLastName(data?.lastName || "");
      setBirthday(data?.birthday || "");
      setCountry(data?.country || "");

      if (r === "student") {
        setGradeLevel(data?.gradeLevel || "");
        setMinutesBalance(Number(data?.minutesBalance || 0));
        await loadHistoryPage(user.uid, true);
      }
      if (r === "tutor") {
        setAvailability({ ...emptyAvailability(), ...(data?.availability || {}) });
        setTutorIntro(data?.tutorIntro || "");
        setPaypalEmail(data?.paypalEmail || "");
      }

      setLoading(false);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // ---- History pagination ----
  async function loadHistoryPage(userId: string, reset = false) {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      const colRef = collection(db, "users", userId, "payments");
      const base = fsQuery(colRef, orderBy("createdAt", "desc"));
      const q = reset
        ? fsQuery(base, fsLimit(PAGE_SIZE))
        : historyCursor
        ? fsQuery(base, startAfter(historyCursor), fsLimit(PAGE_SIZE))
        : fsQuery(base, fsLimit(PAGE_SIZE));

      const list = await getDocs(q);
      const docs = list.docs;
      const rows: Purchase[] = docs.map((d) => {
        const v = d.data() as any;
        return {
          id: d.id,
          hours: Number(v.hours || 0),
          amountUsd: Number(v.amountUsd || 0),
          method: String(v.method || ""),
          createdAt: v?.createdAt?.toDate ? (v.createdAt.toDate() as Date) : null,
        };
      });

      if (reset) {
        setPurchases(rows);
      } else {
        setPurchases((prev) => [...prev, ...rows]);
      }

      const last = docs.length > 0 ? docs[docs.length - 1] : null;
      setHistoryCursor(last);
      setHistoryHasMore(docs.length === PAGE_SIZE);
    } finally {
      setHistoryBusy(false);
    }
  }

  /* ===================== Save Handlers ===================== */

  async function saveStudentProfile() {
    if (!uid) return;
    setSaving(true);
    setSaveMsg("");
    try {
      await setDoc(
        doc(db, "users", uid),
        {
          displayName: displayName.trim() || email.split("@")[0],
          timezone: timezone || guessTimezone(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          birthday: birthday || "",
          country: country || "",
          gradeLevel: gradeLevel || "",
          profileUpdatedAt: serverTimestamp() as any,
        },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(""), 1500);
    }
  }

  async function saveTutorDetails() {
    if (!uid) return;
    setSaving(true);
    setSaveMsg("");
    try {
      await setDoc(
        doc(db, "users", uid),
        {
          displayName: displayName.trim() || email.split("@")?.[0],
          timezone: timezone || guessTimezone(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          birthday: birthday || "",
          country: country || "",
          tutorIntro: tutorIntro || "",
          paypalEmail: paypalEmail || "",
          availability,
          profileUpdatedAt: serverTimestamp() as any,
        },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(""), 1500);
    }
  }

  /* ===================== Password ===================== */

  async function handleChangePassword() {
    setPwMessage("");
    const user = auth.currentUser;
    if (!user) return;

    if (!currPw || !newPw) {
      setPwMessage("Please enter both current and new password.");
      return;
    }
    if (newPw.length < 6) {
      setPwMessage("New password must be at least 6 characters.");
      return;
    }

    try {
      const cred = EmailAuthProvider.credential(email, currPw);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPw);
      setPwMessage("Password updated ✓");
      setCurrPw("");
      setNewPw("");
    } catch (e: any) {
      setPwMessage(e?.message || "Could not update password.");
    }
  }

  /* ===================== Availability helpers ===================== */

  function addTimeRange(day: DayKey) {
    setAvailability((prev) => ({ ...prev, [day]: [...prev[day], { start: "16:00", end: "17:00" }] }));
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

  /* ===================== Stripe (card only) ===================== */

  const [confirmParams, setConfirmParams] = useState<{
    clientSecret: string;
    hours: number;
    amount: number;
  } | null>(null);
  const [confirmNow, setConfirmNow] = useState(0);

  async function handleCardPay() {
    if (!uid) return;
    if (!STRIPE_PK) {
      setPayMsg("Stripe publishable key not set.");
      return;
    }
    setPayMsg("");
    setPayBusy(true);

    try {
      const res = await fetch("/api/stripe/create-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: selectedPkg.id }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.clientSecret) {
        throw new Error(json?.error || "Failed to create payment intent");
      }

      const stripe = await stripePromise!;
      if (!stripe) throw new Error("Stripe not initialized");

      setConfirmParams({
        clientSecret: json.clientSecret as string,
        hours: Number(json.hours),
        amount: Number(json.amount),
      });
      setConfirmNow((c) => c + 1);
    } catch (e: any) {
      setPayMsg(e?.message || "Payment error.");
      setPayBusy(false);
    }
  }

  async function onCardPaymentSucceeded(hoursPurchased: number, paymentId: string) {
    if (!uid) return;
    try {
      const paymentRow = {
        createdAt: serverTimestamp() as any,
        method: "card",
        packageId: selectedPkg.id,
        hours: hoursPurchased,
        amountUsd: selectedPkg.price,
        status: "succeeded",
      };

      await setDoc(doc(db, "users", uid, "payments", paymentId), paymentRow, { merge: true });
      await updateDoc(doc(db, "users", uid), {
        minutesBalance: increment(hoursPurchased * 60),
        profileUpdatedAt: serverTimestamp() as any,
      });

      // optimistic UI
      setMinutesBalance((m) => (m || 0) + hoursPurchased * 60);
      setPurchases((prev) => [
        { id: paymentId, hours: hoursPurchased, amountUsd: selectedPkg.price, method: "card", createdAt: new Date() },
        ...prev,
      ]);
      setPayMsg("Payment successful ✓ Minutes added to your balance.");
      setConfirmParams(null);
      setCardholder("");
    } catch (e: any) {
      setPayMsg("Payment succeeded, but failed to update balance. Please contact support.");
      console.error("post-success update error", e);
    } finally {
      setPayBusy(false);
    }
  }

  /* ===================== Layout ===================== */

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

  const currentTime = formatNowInTZ(timezone || "UTC");
  const balanceH = Math.floor((minutesBalance || 0) / 60);
  const balanceM = (minutesBalance || 0) % 60;

  return (
    <main style={pageShell}>
      <header style={headerBar}>
        <Brand />
        {headerRight}
      </header>

      {/* 3-col grid; tutor availability spans 2 cols. Student splits Payments and History. */}
      <section style={bodyGrid3}>
        {role === "tutor" ? (
          <>
            {/* Col 1: Profile + Change Password in SAME card */}
            <Card style={{ gridColumn: "1 / span 1" }}>
              <CardTitle>Profile</CardTitle>

              <Field label="Email">
                <input disabled value={email} style={input} />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="First name">
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={input} />
                </Field>
                <Field label="Last name">
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} style={input} />
                </Field>
              </div>

              <Field label="Display name">
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={input} />
              </Field>

              <Field label="Birthday">
                <div style={{ position: "relative" }}>
                  <input
                    type="date"
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    style={{ ...input, paddingRight: 36 }}
                  />
                  <div aria-hidden style={miniSuffixBox}>⌚</div>
                </div>
              </Field>

              <Field label="Country of residence">
                <select value={country} onChange={(e) => setCountry(e.target.value)} style={select}>
                  <option value="">Select a country…</option>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>

              <Field label={`Timezone (Current time: ${currentTime || "—"})`}>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  style={select}
                >
                  {ALL_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </Field>

              <CardSubTitle>Tutor Details</CardSubTitle>

              <Field label="PayPal email (for payouts)">
                <input
                  value={paypalEmail}
                  onChange={(e) => setPaypalEmail(e.target.value)}
                  style={input}
                  placeholder="your-paypal-email@example.com"
                />
              </Field>

              <Field label="Tutor introduction">
                <textarea
                  rows={5}
                  value={tutorIntro}
                  onChange={(e) => setTutorIntro(e.target.value)}
                  style={{ ...input, minHeight: 120, resize: "vertical" as const }}
                  placeholder="Write a short introduction students will see…"
                />
              </Field>

              <div style={row}>
                <button onClick={saveTutorDetails} style={primaryBtn} disabled={saving}>
                  Save Tutor Details
                </button>
                {saveMsg && <div style={muted}>{saveMsg}</div>}
              </div>

              {/* --- Horizontal rule & Change Password inside same card --- */}
              <hr style={hr} />
              <CardSubTitle>Change Password</CardSubTitle>
              <Field label="Current password">
                <input
                  type="password"
                  value={currPw}
                  onChange={(e) => setCurrPw(e.target.value)}
                  style={input}
                  placeholder="Enter your current password"
                />
              </Field>
              <Field label="New password">
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  style={input}
                  placeholder="At least 6 characters"
                />
              </Field>
              <div style={row}>
                <button onClick={handleChangePassword} style={primaryBtn}>
                  Update Password
                </button>
                {pwMessage && <div style={{ ...muted, maxWidth: 420 }}>{pwMessage}</div>}
              </div>
            </Card>

            {/* Cols 2-3: Availability (double width; one day per row) */}
            <Card style={{ gridColumn: "2 / span 2" }}>
              <CardTitle>Tutor Availability</CardTitle>
              <div style={{ fontSize: 12, color: "#bbb", marginBottom: 10 }}>
                Times are saved in your timezone (<strong>{timezone || "UTC"}</strong>). Add one or more
                ranges per day (24-hour format).
              </div>

              {/* One row per day */}
              <div style={availRows}>
                {DAYS.map(({ key, label }) => (
                  <div key={key} style={dayRow}>
                    <div style={dayHead}>{label}</div>
                    <div style={rangesWrap}>
                      {(availability[key] ?? []).map((r, i) => (
                        <div key={i} style={rangeRowGrid}>
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
                  </div>
                ))}
              </div>

              <div style={row}>
                <button onClick={saveTutorDetails} style={primaryBtn} disabled={saving}>
                  Save Tutor Details & Availability
                </button>
                {saveMsg && <div style={muted}>{saveMsg}</div>}
              </div>
            </Card>
          </>
        ) : (
          /* ===== Student layout =====
             Left: Profile + Change Password (same card)
             Middle: Hours & Payments (one package per row)
             Right: Purchase History
          */
          <>
            {/* Col 1: Profile + Change Password in SAME card */}
            <Card style={{ gridColumn: "1 / span 1" }}>
              <CardTitle>Profile</CardTitle>

              <Field label="Email">
                <input disabled value={email} style={input} />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="First name">
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={input} />
                </Field>
                <Field label="Last name">
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} style={input} />
                </Field>
              </div>

              <Field label="Display name">
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={input} />
              </Field>

              <Field label="Grade level">
                <select value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)} style={select}>
                  <option value="">Select…</option>
                  {[
                    "Grade 4","Grade 5","Grade 6","Grade 7","Grade 8","Grade 9",
                    "Grade 10","Grade 11","Grade 12","IB / AP"
                  ].map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </Field>

              <Field label="Birthday">
                <div style={{ position: "relative" }}>
                  <input
                    type="date"
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    style={{ ...input, paddingRight: 36 }}
                  />
                  <div aria-hidden style={miniSuffixBox}>⌚</div>
                </div>
              </Field>

              <Field label="Country of residence">
                <select value={country} onChange={(e) => setCountry(e.target.value)} style={select}>
                  <option value="">Select a country…</option>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>

              <Field label={`Timezone (Current time: ${currentTime || "—"})`}>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  style={select}
                >
                  {ALL_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </Field>

              <div style={{ ...row, marginTop: 6 }}>
                <button onClick={saveStudentProfile} style={primaryBtn} disabled={saving}>
                  Save Student Profile
                </button>
                {saveMsg && <div style={muted}>{saveMsg}</div>}
              </div>

              {/* --- Horizontal rule & Change Password inside same card --- */}
              <hr style={hr} />
              <CardSubTitle>Change Password</CardSubTitle>
              <Field label="Current password">
                <input
                  type="password"
                  value={currPw}
                  onChange={(e) => setCurrPw(e.target.value)}
                  style={input}
                  placeholder="Enter your current password"
                />
              </Field>
              <Field label="New password">
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  style={input}
                  placeholder="At least 6 characters"
                />
              </Field>
              <div style={row}>
                <button onClick={handleChangePassword} style={primaryBtn}>
                  Update Password
                </button>
                {pwMessage && <div style={{ ...muted, maxWidth: 420 }}>{pwMessage}</div>}
              </div>
            </Card>

            {/* Col 2: Hours & Payments (package cards one per row) */}
            <Card style={{ gridColumn: "2 / span 1" }}>
              <CardTitle>Hours & Payments</CardTitle>

              <div style={balanceWrap}>
                <div style={{ fontSize: 12, opacity: 0.85 }}>Current balance</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em" }}>
                    {balanceH}
                    <span style={{ fontSize: 16, marginLeft: 4, opacity: 0.9 }}>h</span>
                  </span>
                  <span style={{ fontSize: 28, fontWeight: 700 }}>
                    {balanceM}
                    <span style={{ fontSize: 14, marginLeft: 4, opacity: 0.9 }}>m</span>
                  </span>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 12 }}>
                {STUDENT_PACKAGES.map((p) => {
                  const selected = selectedPkg.id === p.id;
                  const perHour = (p.price / p.hours).toFixed(2);
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPkg(p)}
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        border: selected ? "1px solid #6ecf9a" : "1px solid #444",
                        background: selected ? "rgba(110,207,154,0.12)" : "rgba(255,255,255,0.03)",
                        textAlign: "left",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{p.label}</div>
                      <div style={{ opacity: 0.9 }}>{fmtUsd(p.price)}</div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>${perHour}/hr</div>
                    </button>
                  );
                })}
              </div>

              <div style={{ fontSize: 12, color: "#bbb", marginBottom: 10 }}>
                Selected: <strong>{selectedPkg.hours}h</strong> for{" "}
                <strong>{fmtUsd(selectedPkg.price)}</strong> (${(selectedPkg.price/selectedPkg.hours).toFixed(2)}/hr)
              </div>

              {!STRIPE_PK ? (
                <div style={{ ...muted, marginBottom: 10 }}>
                  Stripe key missing. Set <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>.
                </div>
              ) : (
                <>
                  <Field label="Cardholder name">
                    <input
                      value={cardholder}
                      onChange={(e) => setCardholder(e.target.value)}
                      style={input}
                      placeholder="Name on card"
                    />
                  </Field>

                  <Elements stripe={stripePromise!} options={{ appearance: { theme: "night" } }}>
                    <StripeConfirmSection
                      confirmNow={confirmNow}
                      params={confirmParams}
                      cardholder={cardholder}
                      onDone={(ok, payload) => {
                        if (ok && isPaymentSuccess(payload)) {
                          onCardPaymentSucceeded(payload.hours, payload.paymentId);
                        } else {
                          const msg = (payload as PaymentError)?.message || "Payment failed.";
                          setPayMsg(msg);
                          setPayBusy(false);
                        }
                      }}
                    />
                  </Elements>
                </>
              )}

              <div style={{ marginTop: 12 }}>
                <button
                  style={{ ...primaryBtn, width: "100%", opacity: payBusy ? 0.7 : 1 }}
                  onClick={handleCardPay}
                  disabled={payBusy || !STRIPE_PK}
                >
                  {payBusy ? "Processing…" : `Pay ${fmtUsd(selectedPkg.price)}`}
                </button>
              </div>

              {payMsg && <div style={{ ...muted, marginTop: 8 }}>{payMsg}</div>}
            </Card>

            {/* Col 3: Purchase history */}
            <Card style={{ gridColumn: "3 / span 1" }}>
              <CardTitle>Purchase history</CardTitle>
              {purchases.length === 0 ? (
                <div style={{ ...muted, marginTop: 6 }}>No purchases yet.</div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 12px", display: "grid", gap: 8 }}>
                  {purchases.map((p) => (
                    <li
                      key={p.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.03)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                        <span style={{ fontWeight: 700 }}>{p.hours}h</span>
                        <span style={{ ...muted }}>• {p.method}</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div>{fmtUsd(p.amountUsd)}</div>
                        <div style={{ ...muted, fontSize: 11 }}>{fmtDate(p.createdAt || null)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {historyHasMore && uid && (
                <button
                  style={{ ...ghostButton, width: "100%" }}
                  disabled={historyBusy}
                  onClick={() => loadHistoryPage(uid, false)}
                  title="Load more purchases"
                >
                  {historyBusy ? "Loading…" : "Load more"}
                </button>
              )}
            </Card>
          </>
        )}
      </section>
    </main>
  );
}

/* ===================== Stripe sub-component ===================== */

function StripeConfirmSection({
  confirmNow,
  params,
  cardholder,
  onDone,
}: {
  confirmNow: number;
  params: { clientSecret: string; hours: number; amount: number } | null;
  cardholder: string;
  onDone: (ok: boolean, payload: PaymentSuccess | PaymentError) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  useEffect(() => {
    (async () => {
      if (!params || !stripe || !elements || !confirmNow) return;

      const card = elements.getElement(CardElement);
      if (!card) {
        onDone(false, { message: "Card element not ready." });
        return;
      }

      const { clientSecret, hours } = params;

      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card,
          billing_details: { name: cardholder || undefined },
        },
      });

      if (result.error) {
        onDone(false, { message: result.error.message || "Card error." });
      } else if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
        try { (card as any).clear?.(); } catch {}
        onDone(true, { hours, paymentId: result.paymentIntent.id });
      } else {
        onDone(false, { message: "Payment not completed." });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmNow]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...input, padding: 12 }}>
        <CardElement options={{ style: { base: { color: "#fff", "::placeholder": { color: "#bbb" } } } }} />
      </div>
    </div>
  );
}

/* ===================== Tiny UI helpers ===================== */

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

/* Grid */
const bodyGrid3: React.CSSProperties = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto",
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(300px, 1fr))",
  gap: 16,
};

/* Card + Field styling */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: 12,
        background:
          "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
        padding: "16px 16px 14px",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 120,
        ...style,
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
function CardSubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em", marginTop: 6 }}>
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

const miniSuffixBox: React.CSSProperties = {
  position: "absolute",
  right: 10,
  top: "50%",
  transform: "translateY(-50%)",
  width: 18,
  height: 18,
  borderRadius: 4,
  border: "1px solid #777",
  color: "#fff",
  fontSize: 10,
  display: "grid",
  placeItems: "center",
  opacity: 0.9,
};

const hr: React.CSSProperties = {
  width: "100%",
  border: 0,
  height: 1,
  background: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.18), rgba(255,255,255,0))",
  margin: "8px 0 4px",
};

/* === Availability (one day per row) === */
const availRows: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 10,
};
const dayRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "100px 1fr",
  gap: 10,
  alignItems: "start",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.03)",
};
const dayHead: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 12,
  color: "#fff",
  paddingTop: 6,
};
const rangesWrap: React.CSSProperties = {
  display: "grid",
  gap: 8,
};
const rangeRowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px,1fr) 24px minmax(140px,1fr) auto",
  alignItems: "center",
  gap: 8,
};
const timeInput: React.CSSProperties = { ...input, width: "100%", padding: "8px 10px" };
const smallAddBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12, width: "fit-content" };
const smallGhostBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12 };

const balanceWrap: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))",
  borderRadius: 12,
  padding: "12px 14px",
  marginBottom: 12,
  display: "grid",
  alignItems: "center",
  gap: 4,
};

/* ===================== END ===================== */
