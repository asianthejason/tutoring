// src/app/auth/page.tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

type Role = "student" | "tutor" | "admin";

export const dynamic = "force-dynamic";

function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function ensureTutorDefaults(uid: string) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const data = snap.data() || {};
  if (data.role !== "tutor") return;

  const patch: any = {};
  if (!data.timezone) patch.timezone = guessTimezone();
  if (!data.availability) {
    patch.availability = {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };
  }

  if (Object.keys(patch).length > 0) {
    await setDoc(ref, patch, { merge: true });
  }
}

function AuthInner() {
  const router = useRouter();
  const qp = useSearchParams();
  const from = qp.get("from") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupRole, setSignupRole] = useState<Role>("student");
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState("");

  // If already logged in, bounce to dashboard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return;
      // ensure tutor defaults in background (no await needed)
      ensureTutorDefaults(user.uid).catch(() => {});
      // send to dashboard
      router.replace("/dashboard/" + (await roleToPath(user.uid)));
    });
    return unsub;
  }, [router]);

  async function roleToPath(uid: string): Promise<string> {
    const snap = await getDoc(doc(db, "users", uid));
    const role = (snap.data()?.role as Role) || "student";
    if (role === "tutor") return "tutor";
    if (role === "admin") return "admin"; // you can have /admin route
    return "student";
  }

  async function finishAuthAndRoute(uid: string) {
    // Best-effort ensure defaults for legacy tutors
    await ensureTutorDefaults(uid).catch(() => {});
    const seg = await roleToPath(uid);
    router.replace("/dashboard/" + seg);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      if (isLogin) {
        const res = await signInWithEmailAndPassword(auth, email, password);
        await finishAuthAndRoute(res.user.uid);
      } else {
        const res = await createUserWithEmailAndPassword(auth, email, password);
        const uid = res.user.uid;
        const now = Date.now();
        const displayName =
          email.split("@")[0] ||
          (signupRole === "tutor" ? "Tutor" : "Student");

        if (signupRole === "tutor") {
          const roomId = `tutor_${uid}`;
          await setDoc(doc(db, "users", uid), {
            email,
            role: signupRole,
            createdAt: now,
            displayName,
            roomId,
            status: "offline",
            subjects: [],
            // NEW: initialize defaults on fresh tutor
            timezone: guessTimezone(),
            availability: {
              mon: [],
              tue: [],
              wed: [],
              thu: [],
              fri: [],
              sat: [],
              sun: [],
            },
          });
        } else if (signupRole === "admin") {
          await setDoc(doc(db, "users", uid), {
            email,
            role: signupRole,
            createdAt: now,
            displayName,
          });
        } else {
          await setDoc(doc(db, "users", uid), {
            email,
            role: signupRole,
            createdAt: now,
            displayName,
          });
        }

        await finishAuthAndRoute(uid);
      }
    } catch (err: any) {
      setError(err.message || "Auth failed");
    }
  }

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
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Calgary Math Specialists</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ghostButtonStyle} onClick={() => router.push("/")}>
            ← Back Home
          </button>
        </div>
      </header>

      <section
        style={{
          flex: "1 1 auto",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: 24,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            borderRadius: 16,
            background:
              "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
            padding: "24px 24px 20px",
            color: "#fff",
            fontFamily: "system-ui, sans-serif",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, color: "#fff", letterSpacing: "-0.03em" }}>
              {isLogin ? "Welcome back" : "Create your account"}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.4, color: "rgba(255,255,255,0.7)" }}>
              {isLogin
                ? "Sign in to access live math tutoring."
                : "Sign up, choose Student / Tutor / Admin, and you're in."}
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, marginBottom: 4 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.4 }}>Email</div>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "#111",
                  border: "1px solid #444",
                  color: "#fff",
                  fontSize: 14,
                  lineHeight: 1.4,
                  outline: "none",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.4 }}>Password</div>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                autoComplete={isLogin ? "current-password" : "new-password"}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "#111",
                  border: "1px solid #444",
                  color: "#fff",
                  fontSize: 14,
                  lineHeight: 1.4,
                  outline: "none",
                }}
              />
            </label>

            {!isLogin && (
              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.4 }}>
                  Account type (cannot be changed later)
                </div>
                <select
                  value={signupRole}
                  onChange={(e) => setSignupRole(e.target.value as Role)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "#111",
                    border: "1px solid #444",
                    color: "#fff",
                    fontSize: 14,
                    lineHeight: 1.4,
                    outline: "none",
                    appearance: "none",
                  }}
                >
                  <option value="student" style={{ backgroundColor: "#000", color: "#fff" }}>
                    Student
                  </option>
                  <option value="tutor" style={{ backgroundColor: "#000", color: "#fff" }}>
                    Tutor
                  </option>
                  <option value="admin" style={{ backgroundColor: "#000", color: "#fff" }}>
                    Admin
                  </option>
                </select>
                <div style={{ fontSize: 12, lineHeight: 1.4, color: "rgba(255,255,255,0.5)" }}>
                  • Students join tutoring sessions. <br />
                  • Tutors run live math help rooms (1 student at a time, plus a queue). <br />
                  • Admin accounts observe sessions.
                </div>
              </label>
            )}

            <button
              type="submit"
              style={{
                marginTop: 8,
                padding: "12px 14px",
                borderRadius: 10,
                background: "#3a6",
                border: "1px solid #6ecf9a",
                color: "#fff",
                fontSize: 15,
                lineHeight: 1.2,
                fontWeight: 600,
                textAlign: "center",
                cursor: "pointer",
              }}
            >
              {isLogin ? "Log in" : "Sign up"}
            </button>
          </form>

          {error && (
            <div style={{ color: "tomato", fontSize: 13, lineHeight: 1.4, marginTop: 4 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.8)", textAlign: "center" }}>
            {isLogin ? (
              <>
                Need an account?{" "}
                <button
                  onClick={() => setIsLogin(false)}
                  style={{
                    textDecoration: "underline",
                    background: "none",
                    border: "none",
                    color: "#fff",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: "inherit",
                    lineHeight: "inherit",
                  }}
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => setIsLogin(true)}
                  style={{
                    textDecoration: "underline",
                    background: "none",
                    border: "none",
                    color: "#fff",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: "inherit",
                    lineHeight: "inherit",
                  }}
                >
                  Log in
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <footer
        style={{
          flex: "0 0 auto",
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          padding: "16px 24px 0",
          color: "rgba(255,255,255,0.5)",
          fontSize: 12,
          lineHeight: 1.4,
          textAlign: "center",
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginBottom: 6 }}>
          Need math help this week?
        </div>
        <div style={{ marginBottom: 12 }}>
          You can create a Student account and be in a live tutoring room in minutes.
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
          © {new Date().getFullYear()} Apex Tutoring · Calgary, AB
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.4)", paddingBottom: 16 }}>
          Online math tutoring for grades 4–12
        </div>
      </footer>
    </main>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div style={{ color: "#fff" }}>Loading…</div>}>
      <AuthInner />
    </Suspense>
  );
}
