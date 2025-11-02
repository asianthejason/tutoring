// src/app/auth/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

type Role = "student" | "tutor" | "admin";

export default function AuthPage() {
  const router = useRouter();
  const qp = useSearchParams();
  const from = qp.get("from") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // role is ONLY chosen at signup time
  const [signupRole, setSignupRole] = useState<Role>("student");

  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState("");

  // Already logged in? Bounce them to home (not /room or /admin here).
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return;
      router.replace("/");
    });
    return unsub;
  }, [router]);

  async function finishAuthAndRouteHome(uid: string) {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) {
      console.warn("User doc missing in Firestore for uid", uid);
    }
    router.replace("/");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      if (isLogin) {
        // login
        const res = await signInWithEmailAndPassword(auth, email, password);
        await finishAuthAndRouteHome(res.user.uid);
      } else {
        // signup
        const res = await createUserWithEmailAndPassword(auth, email, password);

        // store fixed role in Firestore (cannot be changed later without manual intervention)
        await setDoc(doc(db, "users", res.user.uid), {
          email,
          role: signupRole,
          createdAt: Date.now(),
        });

        await finishAuthAndRouteHome(res.user.uid);
      }
    } catch (err: any) {
      setError(err.message || "Auth failed");
    }
  }

  // shared button styles (kept consistent with homepage visual language)
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
      {/* NAV BAR / HEADER */}
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
        {/* Brand / tagline */}
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
            Calgary Math Specialists
          </div>
        </div>

        {/* Back home */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            style={ghostButtonStyle}
            onClick={() => router.push("/")}
          >
            ← Back Home
          </button>
        </div>
      </header>

      {/* AUTH BODY */}
      <section
        style={{
          flex: "1 1 auto",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: 24,
        }}
      >
        {/* AUTH CARD */}
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
          {/* Heading / subheading */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                lineHeight: 1.3,
                color: "#fff",
                letterSpacing: "-0.03em",
              }}
            >
              {isLogin ? "Welcome back" : "Create your account"}
            </div>

            <div
              style={{
                fontSize: 14,
                lineHeight: 1.4,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              {isLogin
                ? "Sign in to access live math tutoring."
                : "Sign up, choose Student / Tutor / Admin, and you're in."}
            </div>
          </div>

          {/* FORM */}
          <form
            onSubmit={handleSubmit}
            style={{
              display: "grid",
              gap: 12,
              marginBottom: 4,
            }}
          >
            {/* Email */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.8)",
                  lineHeight: 1.4,
                }}
              >
                Email
              </label>
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
            </div>

            {/* Password */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.8)",
                  lineHeight: 1.4,
                }}
              >
                Password
              </label>
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
            </div>

            {/* Role selector (signup only) */}
            {!isLogin && (
              <div style={{ display: "grid", gap: 6 }}>
                <label
                  style={{
                    fontSize: 13,
                    color: "rgba(255,255,255,0.8)",
                    lineHeight: 1.4,
                  }}
                >
                  Account type (cannot be changed later)
                </label>

                <select
                  value={signupRole}
                  onChange={(e) =>
                    setSignupRole(
                      e.target.value as "student" | "tutor" | "admin"
                    )
                  }
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
                  <option
                    value="student"
                    style={{ backgroundColor: "#000", color: "#fff" }}
                  >
                    Student
                  </option>
                  <option
                    value="tutor"
                    style={{ backgroundColor: "#000", color: "#fff" }}
                  >
                    Tutor
                  </option>
                  <option
                    value="admin"
                    style={{ backgroundColor: "#000", color: "#fff" }}
                  >
                    Admin
                  </option>
                </select>

                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.4,
                    color: "rgba(255,255,255,0.5)",
                  }}
                >
                  • Students join tutoring sessions. <br />
                  • Tutors run live math help for 1–2 students. <br />
                  • Admin accounts manage billing, sessions, and user access.
                </div>
              </div>
            )}

            {/* Submit */}
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

          {/* Error */}
          {error && (
            <div
              style={{
                color: "tomato",
                fontSize: 13,
                lineHeight: 1.4,
                marginTop: 4,
              }}
            >
              {error}
            </div>
          )}

          {/* Switch login/signup */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: "rgba(255,255,255,0.8)",
              textAlign: "center",
            }}
          >
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

      {/* FOOTER / TRUST STRIP */}
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
        <div
          style={{
            color: "rgba(255,255,255,0.8)",
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          Need math help this week?
        </div>

        <div style={{ marginBottom: 12 }}>
          You can create a Student account and be in a live tutoring room in
          minutes.
        </div>

        <div
          style={{
            marginBottom: 24,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <button
            onClick={() => setIsLogin(false)}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "#3a6",
              border: "1px solid #6ecf9a",
              color: "#fff",
              fontSize: 14,
              lineHeight: 1.2,
              fontWeight: 500,
              cursor: "pointer",
              minWidth: 150,
              textAlign: "center",
            }}
          >
            Get Started
          </button>
        </div>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.4)",
            marginBottom: 4,
          }}
        >
          © {new Date().getFullYear()} Apex Tutoring · Calgary, AB
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.4)",
            paddingBottom: 16,
          }}
        >
          Online math tutoring for grades 4–12
        </div>
      </footer>
    </main>
  );
}
