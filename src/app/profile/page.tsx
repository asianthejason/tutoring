// src/app/profile/page.tsx
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
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
  serverTimestamp,
} from "firebase/firestore";

// ─────────── STRIPE (real Elements) ───────────
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

// ─────────── Types ───────────
type Role = "student" | "tutor" | "admin";
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type TimeRange = { start: string; end: string };
type Availability = Record<DayKey, TimeRange[]>;

type UserDoc = {
  email: string;
  role: Role;

  // shared
  displayName?: string;
  firstName?: string;
  lastName?: string;
  birthday?: string; // yyyy-mm-dd
  country?: string;

  // tutor
  timezone?: string;
  tutorIntro?: string;
  paypalEmail?: string;
  availability?: Availability;

  // student
  gradeLevel?: string;

  // balance (minutes)
  minutesBalance?: number;
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

// Pricing (USD) — 5 hours = 265
const PACKS = [
  { hours: 1, price: 55 },
  { hours: 5, price: 265 },
  { hours: 10, price: 500 },
  { hours: 20, price: 900 },
  { hours: 40, price: 1600 },
];

const COUNTRIES = [
  "Canada","United States","Mexico","United Kingdom","Ireland","Germany","France","Spain","Italy","Portugal","Netherlands","Belgium","Switzerland","Austria","Sweden","Norway","Denmark","Finland","Poland","Czechia","Slovakia","Hungary","Romania","Bulgaria","Greece","Turkey","Israel","United Arab Emirates","Saudi Arabia","Qatar","India","Pakistan","Bangladesh","Sri Lanka","Nepal","China","Japan","South Korea","Taiwan","Hong Kong","Singapore","Malaysia","Thailand","Vietnam","Philippines","Indonesia","Australia","New Zealand","Brazil","Argentina","Chile","Colombia","Peru","South Africa","Nigeria","Kenya","Egypt","Morocco"
].sort((a,b)=>a.localeCompare(b));

const TIMEZONES = [
  "UTC","America/Edmonton","America/Vancouver","America/Los_Angeles","America/Denver","America/Chicago","America/New_York","America/Toronto","Europe/London","Europe/Paris","Europe/Berlin","Europe/Amsterdam","Europe/Madrid","Europe/Rome","Europe/Zurich","Asia/Dubai","Asia/Kolkata","Asia/Singapore","Asia/Hong_Kong","Asia/Tokyo","Asia/Seoul","Australia/Sydney","Pacific/Auckland"
];

// ─────────── Card checkout subcomponent ───────────
// Uses Elements context. Calls your backend to create a PaymentIntent.
function CardCheckout({
  uid,
  email,
  pack,
  cardholderName,
  onPaid,
}: {
  uid: string;
  email: string;
  pack: { hours: number; price: number };
  cardholderName: string;
  onPaid: (piId: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const handlePay = useCallback(async () => {
    if (!stripe || !elements) return;
    setErr("");
    setBusy(true);

    try {
      // Create PI on your server (amount in cents)
      const res = await fetch("/api/payments/stripe/create-payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: uid,
          email,
          hours: pack.hours,
          amountUsd: pack.price,
          // Optional: metadata for reconciliation
          metadata: { product: `${pack.hours}h_package` },
        }),
      });

      const { clientSecret, error } = await res.json();
      if (error || !clientSecret) {
        throw new Error(error || "Could not create payment intent");
      }

      const card = elements.getElement(CardElement);
      if (!card) throw new Error("Card element not ready.");

      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card,
          billing_details: {
            name: cardholderName || email,
            email,
          },
        },
      });

      if (result.error) {
        throw new Error(result.error.message || "Payment failed.");
      }

      if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
        onPaid(result.paymentIntent.id);
      } else {
        throw new Error("Payment did not complete.");
      }
    } catch (e: any) {
      setErr(e?.message || "Payment failed.");
    } finally {
      setBusy(false);
    }
  }, [stripe, elements, uid, email, pack, cardholderName, onPaid]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ ...input, padding: 12 }}>
        <CardElement options={{ style: { base: { color: "#fff", "::placeholder": { color: "#bbb" } } } }} />
      </div>
      {err && <div style={{ color: "#ffb3b3", fontSize: 12 }}>{err}</div>}
      <button onClick={handlePay} style={{ ...primaryBtn, width: "100%" }} disabled={busy || !stripe}>
        {busy ? "Processing…" : `Pay $${pack.price} USD`}
      </button>
    </div>
  );
}

// ─────────── Page ───────────
export default function ProfileSettingsPage() {
  const router = useRouter();

  // auth
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<Role | null>(null);

  // shared profile
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [birthday, setBirthday] = useState<string>("");
  const [country, setCountry] = useState<string>("");

  // timezone with live clock
  const [timezone, setTimezone] = useState<string>("");
  const [tzNow, setTzNow] = useState<string>("");

  // student
  const [gradeLevel, setGradeLevel] = useState<string>("");

  // tutor
  const [tutorIntro, setTutorIntro] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [availability, setAvailability] = useState<Availability>(emptyAvailability());

  // balance (minutes)
  const [minutesBalance, setMinutesBalance] = useState<number>(0);

  // password
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [pwMessage, setPwMessage] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // purchase UI
  const [selectedPack, setSelectedPack] = useState(PACKS[2]); // default 10h
  const [payMethod, setPayMethod] = useState<"paypal"|"card">("paypal");
  const [cardholderName, setCardholderName] = useState("");

  // auth+user load
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

      setFirstName(data?.firstName || "");
      setLastName(data?.lastName || "");
      setDisplayName(data?.displayName || (user.email?.split("@")[0] ?? ""));
      setBirthday(data?.birthday || "");
      setCountry(data?.country || "");
      setTimezone(data?.timezone || guessTimezone());
      setMinutesBalance(typeof data?.minutesBalance === "number" ? data!.minutesBalance! : 0);

      if (r === "student") {
        setGradeLevel(data?.gradeLevel || "");
      }
      if (r === "tutor") {
        setTutorIntro(data?.tutorIntro || "");
        setPaypalEmail(data?.paypalEmail || "");
        setAvailability({ ...emptyAvailability(), ...(data?.availability || {}) });
      }

      setLoading(false);
    });
    return unsub;
  }, [router]);

  // tz clock
  useEffect(() => {
    function refresh() {
      try {
        const fmt = new Intl.DateTimeFormat([], {
          timeZone: timezone || guessTimezone(),
          hour: "2-digit",
          minute: "2-digit",
        });
        setTzNow(fmt.format(new Date()));
      } catch {
        setTzNow("");
      }
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [timezone]);

  function guessTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  // saves
  async function saveCommon() {
    if (!uid) return;
    setSaving(true); setSaveMsg("");
    try {
      await setDoc(
        doc(db, "users", uid),
        {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          displayName: displayName.trim() || email.split("@")[0],
          birthday: birthday || "",
          country: country || "",
          profileUpdatedAt: serverTimestamp() as any,
        },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false); setTimeout(()=>setSaveMsg(""),1500);
    }
  }

  async function saveStudent() {
    if (!uid) return;
    setSaving(true); setSaveMsg("");
    try {
      await setDoc(
        doc(db, "users", uid),
        { gradeLevel: gradeLevel || "", timezone: timezone || guessTimezone(), profileUpdatedAt: serverTimestamp() as any },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false); setTimeout(()=>setSaveMsg(""),1500);
    }
  }

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
  function isRangeValid(r: TimeRange) { return r.start < r.end; }

  async function saveTutor() {
    if (!uid) return;
    for (const d of DAYS) {
      for (const r of availability[d.key]) {
        if (!isRangeValid(r)) { setSaveMsg(`Invalid time range on ${d.label}`); return; }
      }
    }
    setSaving(true); setSaveMsg("");
    try {
      await setDoc(
        doc(db, "users", uid),
        { timezone: timezone || guessTimezone(), tutorIntro: tutorIntro || "", paypalEmail: paypalEmail.trim() || "", availability, profileUpdatedAt: serverTimestamp() as any },
        { merge: true }
      );
      setSaveMsg("Saved ✓");
    } finally {
      setSaving(false); setTimeout(()=>setSaveMsg(""),1500);
    }
  }

  async function handleChangePassword() {
    setPwMessage("");
    const user = auth.currentUser;
    if (!user) return;

    if (!currentPassword) { setPwMessage("Current password is required."); return; }
    if (!newPassword || newPassword.length < 6) { setPwMessage("New password must be at least 6 characters."); return; }

    try {
      const cred = EmailAuthProvider.credential(email, currentPassword);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPassword);
      setPwMessage("Password updated ✓");
      setNewPassword(""); setCurrentPassword("");
    } catch (e: any) {
      setPwMessage(e?.message || "Could not update password.");
    }
  }

  // payments
  const perHour = (p: {hours:number; price:number}) => (p.price / p.hours);
  const hoursText = `${Math.floor((minutesBalance || 0)/60)}h ${(minutesBalance || 0)%60}m`;

  const handlePaidSuccess = async (_piId: string) => {
    // Optionally show a toast; minutes will be credited by your webhook.
    // You could also poll or call an endpoint to refresh minutes after success.
    alert("Payment completed! Your balance will update shortly.");
  };

  const headerRight = useMemo(
    () => (
      <div style={{ display: "flex", gap: 8 }}>
        <button style={ghostButton} onClick={() => router.push("/")} title="Home">← Home</button>
        <button
          style={ghostButton}
          onClick={() => router.push(role === "tutor" ? "/dashboard/tutor" : role === "admin" ? "/admin" : "/dashboard/student")}
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
      <header style={headerBar}>
        <Brand />
        {headerRight}
      </header>

      <section style={bodyGrid}>
        {/* Left column: Profile */}
        <Card>
          <CardTitle>Profile</CardTitle>
          <Field label="Email"><input disabled value={email} style={input} /></Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="First name"><input value={firstName} onChange={(e)=>setFirstName(e.target.value)} style={input} placeholder="Jane" /></Field>
            <Field label="Last name"><input value={lastName} onChange={(e)=>setLastName(e.target.value)} style={input} placeholder="Doe" /></Field>
          </div>

          <Field label="Display name"><input value={displayName} onChange={(e)=>setDisplayName(e.target.value)} style={input} placeholder="Your name" /></Field>

          {role === "student" && (
            <Field label="Grade level">
              <select value={gradeLevel} onChange={(e)=>setGradeLevel(e.target.value)} style={select}>
                <option value="">Select…</option>
                {["Grade 4","Grade 5","Grade 6","Grade 7","Grade 8","Grade 9","Grade 10","Grade 11","Grade 12","IB / AP"].map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Birthday">
            <div style={{ position: "relative" }}>
              <input type="date" value={birthday} onChange={(e)=>setBirthday(e.target.value)} style={{ ...input, paddingRight: 32 }} />
              <div style={{ position: "absolute", right: 10, top: 10, width: 16, height: 16, border: "2px solid #fff", borderRadius: 3, opacity: 0.9 }} />
            </div>
          </Field>

          <Field label="Country of residence">
            <select value={country} onChange={(e)=>setCountry(e.target.value)} style={select}>
              <option value="">Select a country…</option>
              {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          <Field label={`Timezone (Current time: ${tzNow || "—"})`}>
            <select value={timezone} onChange={(e)=>setTimezone(e.target.value)} style={select}>
              {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>

          {role === "tutor" && (
            <>
              <Field label="PayPal email (for payouts)">
                <input value={paypalEmail} onChange={(e)=>setPaypalEmail(e.target.value)} style={input} placeholder="your-paypal-email@example.com" />
              </Field>

              <div style={{ marginTop: 6, fontWeight: 600, color: "#fff" }}>Tutor Details</div>
              <Field label="Tutor introduction">
                <textarea
                  value={tutorIntro}
                  onChange={(e)=>setTutorIntro(e.target.value)}
                  placeholder="Write a short introduction students will see (teaching style, subjects, achievements, etc.)"
                  style={{ ...input, minHeight: 120, resize: "vertical" }}
                />
              </Field>
            </>
          )}

          <div style={row}>
            <button onClick={saveCommon} style={primaryBtn} disabled={saving}>Save Profile</button>
            {role === "student" && (
              <button onClick={saveStudent} style={{ ...primaryBtn, background: "#2b7", borderColor: "#6ecf9a" }} disabled={saving}>
                Save Student Info
              </button>
            )}
            {saveMsg && <div style={muted}>{saveMsg}</div>}
          </div>
        </Card>

        {/* Middle column: Password */}
        <Card>
          <CardTitle>Change Password</CardTitle>
          <Field label="Current password">
            <input type="password" value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} style={input} placeholder="Enter your current password" />
          </Field>
          <Field label="New password">
            <input type="password" value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} style={input} placeholder="At least 6 characters" />
          </Field>
          <div style={row}>
            <button onClick={handleChangePassword} style={primaryBtn}>Update Password</button>
            {pwMessage && <div style={{ ...muted, maxWidth: 420 }}>{pwMessage}</div>}
          </div>
        </Card>

        {/* Right column */}
        {role === "student" ? (
          <Card>
            <CardTitle>Hours & Payments</CardTitle>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginBottom: 8 }}>
              Current balance: <strong>{hoursText}</strong>
            </div>

            {/* Packs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              {PACKS.map((p) => {
                const selected = selectedPack.hours === p.hours;
                return (
                  <button
                    key={p.hours}
                    onClick={() => setSelectedPack(p)}
                    style={{
                      textAlign: "left",
                      padding: 12,
                      borderRadius: 12,
                      border: selected ? "2px solid #6ecf9a" : "1px solid rgba(255,255,255,0.15)",
                      background: "rgba(0,0,0,0.25)",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{p.hours} {p.hours === 1 ? "hour" : "hours"}</div>
                    <div style={{ opacity: 0.9 }}>${p.price} USD</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>${perHour(p).toFixed(2)}/hr</div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
              Selected: <strong>{selectedPack.hours}h</strong> for <strong>${selectedPack.price} USD</strong> (${perHour(selectedPack).toFixed(2)}/hr)
            </div>

            {/* Method */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginBottom: 6 }}>Payment method</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <label style={pill(payMethod === "paypal")}><input type="radio" checked={payMethod === "paypal"} onChange={() => setPayMethod("paypal")} />&nbsp; PayPal</label>
                <label style={pill(payMethod === "card")}><input type="radio" checked={payMethod === "card"} onChange={() => setPayMethod("card")} />&nbsp; Credit / Debit card</label>
              </div>
            </div>

            {/* Cardholder + Elements (only when card selected) */}
            {payMethod === "card" && (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <Field label="Cardholder name">
                  <input value={cardholderName} onChange={(e)=>setCardholderName(e.target.value)} style={input} placeholder="Name on card" />
                </Field>
                <Elements stripe={stripePromise} options={{ appearance: { theme: "night" }, locale: "en" }}>
                  <CardCheckout
                    uid={uid!}
                    email={email}
                    pack={selectedPack}
                    cardholderName={cardholderName}
                    onPaid={handlePaidSuccess}
                  />
                </Elements>
              </div>
            )}

            {/* PayPal button */}
            {payMethod === "paypal" && (
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={() => {
                    const q = new URLSearchParams({ hours: String(selectedPack.hours), price: String(selectedPack.price) });
                    window.location.href = `/api/payments/paypal/create-order?${q.toString()}`;
                  }}
                  style={{ ...primaryBtn, width: "100%" }}
                >
                  Pay ${selectedPack.price} USD
                </button>
                <div style={{ ...muted, marginTop: 8 }}>
                  After a successful payment, the purchased minutes will be added to your balance automatically.
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card>
            <CardTitle>Tutor Availability</CardTitle>
            <div style={{ fontSize: 12, color: "#bbb", marginBottom: 10 }}>
              Times are saved in your timezone (<strong>{timezone || "UTC"}</strong>). Add one or more ranges per day (24-hour format).
            </div>
            <div style={availGrid}>
              {DAYS.map(({ key, label }) => (
                <div key={key} style={availCol}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 6 }}>{label}</div>
                  {(availability[key] ?? []).map((r, i) => (
                    <div key={i} style={rangeRow}>
                      <input type="time" value={r.start} onChange={(e)=>updateRange(key, i, "start", e.target.value)} style={timeInput} />
                      <span style={{ color: "#888" }}>–</span>
                      <input type="time" value={r.end} onChange={(e)=>updateRange(key, i, "end", e.target.value)} style={timeInput} />
                      <button onClick={()=>removeRange(key, i)} style={smallGhostBtn}>Remove</button>
                    </div>
                  ))}
                  <button onClick={()=>addTimeRange(key)} style={smallAddBtn}>+ Add time</button>
                </div>
              ))}
            </div>
            <div style={row}>
              <button onClick={saveTutor} style={primaryBtn} disabled={saving}>Save Tutor Details & Availability</button>
              {saveMsg && <div style={muted}>{saveMsg}</div>}
            </div>
          </Card>
        )}
      </section>
    </main>
  );
}

/* ─────────── UI helpers ─────────── */

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
  width: "100%",
  boxSizing: "border-box",
};

const select: React.CSSProperties = { ...input, appearance: "none" as const };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };

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
  textAlign: "center" as const,
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

const timeInput: React.CSSProperties = { ...input, padding: "8px 10px" };
const smallAddBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12 };
const smallGhostBtn: React.CSSProperties = { ...ghostButton, padding: "6px 8px", fontSize: 12 };

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: active ? "1px solid #6ecf9a" : "1px solid #444",
    background: active ? "rgba(46, 178, 107, 0.25)" : "#2a2a2a",
    color: "#fff",
    cursor: "pointer",
    userSelect: "none",
  };
}
