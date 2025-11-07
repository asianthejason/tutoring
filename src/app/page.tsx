// src/app/page.tsx
"use client";

import { useEffect, useState } from "react";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useRouter } from "next/navigation";

type Role = "tutor" | "student" | "admin";

export default function HomePage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUserEmail(null);
        setRole(null);
        setCheckingAuth(false);
        return;
      }

      setUserEmail(user.email ?? null);
      const snap = await getDoc(doc(db, "users", user.uid));
      const fixedRole = (snap.data()?.role as Role) || "student";
      setRole(fixedRole);
      setCheckingAuth(false);
    });

    return unsub;
  }, []);

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    setUserEmail(null);
    setRole(null);
  }

  function handleProfile() {
    router.push("/profile");
  }

  /** Primary CTA:
   *  - Logged out → /auth
   *  - Logged in  → correct dashboard for role
   */
  function handlePrimaryCta() {
    if (!userEmail || !role) {
      router.push("/auth");
      return;
    }
    switch (role) {
      case "admin":
        router.push("/admin");
        break;
      case "tutor":
        router.push("/dashboard/tutor");
        break;
      case "student":
      default:
        router.push("/dashboard/student");
        break;
    }
  }

  // --- NAV BAR ---
  const NavBar = (
    <header
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "0 auto",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderRadius: 12,
        background:
          "linear-gradient(to right, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
        border: "1px solid rgba(255,255,255,0.15)",
        boxShadow:
          "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
      }}
    >
      {/* left - brand */}
      <div
        style={{
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          lineHeight: 1.2,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>
          Apex Tutoring
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>Calgary Math Specialists</div>
      </div>

      {/* middle - nav links */}
      <nav
        style={{
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          fontSize: 13,
          lineHeight: 1.2,
          color: "#fff",
        }}
      >
        <button
          style={navButtonStyle}
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          Home
        </button>
        <button
          style={navButtonStyle}
          onClick={() =>
            document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
          }
        >
          How it works
        </button>
        <button
          style={navButtonStyle}
          onClick={() =>
            document.getElementById("why-apex")?.scrollIntoView({ behavior: "smooth" })
          }
        >
          Why Apex
        </button>
        <button
          style={navButtonStyle}
          onClick={() =>
            document.getElementById("programs")?.scrollIntoView({ behavior: "smooth" })
          }
        >
          Programs
        </button>
      </nav>

      {/* right - auth / CTA */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {userEmail && role ? (
          <>
            <button style={primaryCtaStyle} onClick={handlePrimaryCta}>
              {role === "admin" ? "Admin Dashboard" : "Dashboard"}
            </button>
            {/* NEW: Profile button */}
            <button style={ghostButtonStyle} onClick={handleProfile}>
              Profile
            </button>
            <button style={ghostButtonStyle} onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <button style={primaryCtaStyle} onClick={handlePrimaryCta}>
              Get Started
            </button>
            <button style={ghostButtonStyle} onClick={() => router.push("/auth")}>
              Log in
            </button>
          </>
        )}
      </div>
    </header>
  );

  // --- HERO SECTION ---
  const Hero = (
    <section
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "32px auto 0 auto",
        padding: "24px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "24px",
      }}
    >
      {/* left column */}
      <div
        style={{
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minHeight: 320,
        }}
      >
        <div
          style={{
            fontSize: 28,
            lineHeight: 1.15,
            fontWeight: 600,
            letterSpacing: "-0.04em",
            color: "#fff",
            marginBottom: 16,
            maxWidth: 500,
          }}
        >
          Math help that actually fixes gaps — and builds top-tier confidence.
        </div>

        <p
          style={{
            fontSize: 15,
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.8)",
            maxWidth: 500,
            marginBottom: 16,
          }}
        >
          Apex Tutoring gives Calgary students focused, human math support. Real tutors, not AI
          chat. We target exactly what your child is stuck on, and we stay with them until it clicks.
        </p>

        <ul
          style={{
            paddingLeft: 16,
            margin: 0,
            listStyle: "disc",
            fontSize: 14,
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.8)",
            maxWidth: 500,
          }}
        >
          <li>Grades 4–12 math, including Pre-IB / Pure Math / Pre-Calculus</li>
          <li>1-on-1 or semi-private (2 students max)</li>
          <li>Live online sessions with shared whiteboard</li>
          <li>Weekly support plans to prevent falling behind</li>
        </ul>

        <div style={{ height: 20 }} />

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button style={primaryCtaStyleLarge} onClick={handlePrimaryCta}>
            {userEmail && role ? "Go to Dashboard" : "Book a free consult"}
          </button>
          <button
            style={ghostButtonStyle}
            onClick={() =>
              document.getElementById("programs")?.scrollIntoView({ behavior: "smooth" })
            }
          >
            View programs
          </button>
        </div>

        <div style={{ height: 24 }} />

        <div
          style={{
            fontSize: 12,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.6)",
            maxWidth: 420,
          }}
        >
          We’re currently accepting new math students in Calgary and surrounding area. All sessions
          are online — no driving, no pickup/dropoff stress.
        </div>
      </div>

      {/* right column (visual) */}
      <div
        style={{
          minHeight: 320,
          background:
            "radial-gradient(circle at 20% 20%, rgba(77,177,255,0.4) 0%, rgba(0,0,0,0) 70%), radial-gradient(circle at 80% 30%, rgba(80,255,150,0.25) 0%, rgba(0,0,0,0) 60%)",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "0 40px 120px rgba(0,0,0,0.9), 0 2px 4px rgba(255,255,255,0.6) inset",
          borderRadius: 16,
          position: "relative",
          overflow: "hidden",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <div
          style={{
            background: "rgba(15,15,15,0.9)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            padding: "12px 14px",
            color: "#fff",
            fontSize: 12,
            lineHeight: 1.4,
            maxWidth: 260,
            boxShadow:
              "0 24px 60px rgba(0,0,0,0.8), 0 1px 2px rgba(255,255,255,0.1) inset",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Whiteboard • Live</div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            Tutor: “Let's solve this step together.”
          </div>
          <div style={{ opacity: 0.8 }}>
            (x + 5)(x − 2) = 0 <br />
            What values of x make this true?
          </div>
        </div>

        <div
          style={{
            background: "rgba(15,15,15,0.9)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            padding: "12px 14px",
            color: "#fff",
            fontSize: 12,
            lineHeight: 1.4,
            maxWidth: 220,
            boxShadow:
              "0 24px 60px rgba(0,0,0,0.8), 0 1px 2px rgba(255,255,255,0.1) inset",
          }}
        >
          <div
            style={{
              fontSize: 11,
              opacity: 0.6,
              marginBottom: 4,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Student</span>
            <span style={{ color: "#6ecf9a" }}>“Oh I get it now!”</span>
          </div>
          <div style={{ opacity: 0.8 }}>
            If (x + 5)=0 then x = −5.
            <br />
            If (x − 2)=0 then x = 2.
            <br />
            So, solutions: x = −5 or x = 2.
          </div>
        </div>
      </div>
    </section>
  );

  // --- PROGRAMS ---
  const Programs = (
    <section
      id="programs"
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "48px auto 0 auto",
        padding: "24px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(300px,100%),1fr))",
        gap: "24px",
      }}
    >
      <div
        style={{
          gridColumn: "1 / -1",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
          Math support built around how your child learns
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.7)",
            maxWidth: 700,
          }}
        >
          All sessions are online with live audio, video, and a shared math whiteboard. Select what
          fits: personal attention, small-group efficiency, or a standing weekly block.
        </div>
      </div>

      {/* 1-on-1 */}
      <div style={programCardStyle}>
        <div style={programCardHeaderStyle}>1-on-1 Private Math Tutoring</div>
        <p style={programCardBodyStyle}>
          Pure focus. The tutor works with just your child. We identify weaknesses (fractions,
          factoring, word problems, algebra steps, exam anxiety) and rebuild from there.
        </p>
        <ul style={programListStyle}>
          <li>Fastest way to close gaps</li>
          <li>Great for kids who won't ask questions in class</li>
          <li>Custom pacing, custom review sheets</li>
        </ul>
        <div style={programCtaStyle}>Best for: catching up fast</div>
      </div>

      {/* 2-student */}
      <div style={programCardStyle}>
        <div style={programCardHeaderStyle}>Semi-Private (2 Students + 1 Tutor)</div>
        <p style={programCardBodyStyle}>
          Two students share a tutor. Students can still ask questions individually — we can mute /
          unmute so they’re not talking over each other.
        </p>
        <ul style={programListStyle}>
          <li>Lower cost than full private</li>
          <li>Still highly interactive</li>
          <li>Perfect for study buddies in the same course</li>
        </ul>
        <div style={programCtaStyle}>Best for: steady weekly help</div>
      </div>

      {/* Weekly plan */}
      <div style={programCardStyle}>
        <div style={programCardHeaderStyle}>Weekly Math Support Plan</div>
        <p style={programCardBodyStyle}>
          A recurring spot every week with the same tutor. We review current class topics, prep for
          quizzes, and keep assignments from piling up.
        </p>
        <ul style={programListStyle}>
          <li>Prevents “snowball panic” before exams</li>
          <li>Parents get consistency and accountability</li>
          <li>Great for IB, Pre-AP, and high school math</li>
        </ul>
        <div style={programCtaStyle}>Best for: staying ahead</div>
      </div>
    </section>
  );

  // --- HOW IT WORKS ---
  const HowItWorks = (
    <section
      id="how-it-works"
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "64px auto 0 auto",
        padding: "24px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(260px,100%),1fr))",
        gap: "24px",
      }}
    >
      <div
        style={{
          gridColumn: "1 / -1",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
          How Apex works
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.7)",
            maxWidth: 700,
          }}
        >
          It’s simple to get started. No contracts, no long intake forms.
        </div>
      </div>

      <div style={stepCardStyle}>
        <div style={stepNumberStyle}>1</div>
        <div style={stepTitleStyle}>Tell us what’s going on</div>
        <div style={stepBodyStyle}>
          Struggling with factoring? Word problems? Failing quizzes even after doing homework? Tell
          us. We listen first.
        </div>
      </div>

      <div style={stepCardStyle}>
        <div style={stepNumberStyle}>2</div>
        <div style={stepTitleStyle}>We match a math tutor</div>
        <div style={stepBodyStyle}>
          You’ll work with a real human math tutor — not a script, not a bot. We pick someone who
          actually teaches that grade level.
        </div>
      </div>

      <div style={stepCardStyle}>
        <div style={stepNumberStyle}>3</div>
        <div style={stepTitleStyle}>Live session, shared whiteboard</div>
        <div style={stepBodyStyle}>
          Your child talks through the problem out loud while solving it on a shared digital
          whiteboard. We correct in real time.
        </div>
      </div>

      <div style={stepCardStyle}>
        <div style={stepNumberStyle}>4</div>
        <div style={stepTitleStyle}>Weekly momentum</div>
        <div style={stepBodyStyle}>
          We stick with them every week, so math stops being an emergency and starts being under
          control.
        </div>
      </div>
    </section>
  );

  // --- WHY APEX ---
  const WhyApex = (
    <section
      id="why-apex"
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "64px auto 0 auto",
        padding: "24px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "24px",
      }}
    >
      <div
        style={{
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minWidth: 0,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em", color: "#fff" }}>
          Why parents choose Apex
        </div>

        <div
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.8)",
            maxWidth: 520,
          }}
        >
          We’re not just homework help. We teach math in plain English, build habits that actually
          work for your kid, and give them the confidence to raise their hand in class again.
        </div>

        <ul
          style={{
            paddingLeft: 16,
            margin: 0,
            listStyle: "disc",
            fontSize: 14,
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.8)",
            maxWidth: 520,
          }}
        >
          <li>We focus on understanding, not memorizing steps</li>
          <li>We catch tiny mistakes before they become big Fs</li>
          <li>We know Alberta curriculum — this is not generic “YouTube math”</li>
          <li>We speak to teens like humans, not robots</li>
        </ul>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <button style={primaryCtaStyle} onClick={handlePrimaryCta}>
            {userEmail && role ? "Dashboard" : "Talk to a tutor"}
          </button>

          <button style={ghostButtonStyle} onClick={() => router.push("/auth")}>
            {userEmail && role ? "Switch account" : "Create account"}
          </button>
        </div>
      </div>

      <div
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(77,177,255,0.18) 0%, rgba(0,0,0,0) 70%), rgba(20,20,20,0.8)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 16,
          padding: "20px 20px",
          boxShadow:
            "0 40px 120px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
          color: "#fff",
          fontSize: 13,
          lineHeight: 1.4,
          maxWidth: 480,
          minHeight: 220,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>Meet a tutor</div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 10,
                background: "linear-gradient(135deg,#4db1ff 0%,#1e1e1e 60%)",
                border: "1px solid rgba(255,255,255,0.4)",
                boxShadow:
                  "0 20px 40px rgba(0,0,0,0.8), 0 1px 2px rgba(255,255,255,0.4) inset",
              }}
            />
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  fontSize: 14,
                  color: "#fff",
                  marginBottom: 4,
                  lineHeight: 1.3,
                }}
              >
                Jason · Lead Math Tutor
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.4, color: "rgba(255,255,255,0.8)" }}>
                Specializes in Jr. High math foundations, Algebra I/II, factoring & radicals,
                Grade 10–12 exam prep, and building “I can actually do this” confidence.
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.7)" }}>
          “Our goal is simple: if a student is scared of math, we make math feel non-scary.
          If they’re already strong, we make them dangerous.”
        </div>
      </div>
    </section>
  );

  // --- FINAL CTA / FOOTER STRIP ---
  const FooterCta = (
    <section
      style={{
        width: "100%",
        maxWidth: "1280px",
        margin: "64px auto 40px auto",
        padding: "24px",
        borderRadius: 16,
        background:
          "linear-gradient(135deg,rgba(80,255,150,0.12) 0%,rgba(0,0,0,0) 60%),rgba(20,20,20,0.8)",
        border: "1px solid rgba(255,255,255,0.15)",
        boxShadow:
          "0 60px 160px rgba(0,0,0,0.9), 0 2px 4px rgba(255,255,255,0.08) inset",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.3, color: "#fff" }}>
        Ready to take math from “I hate this” to “I’ve got this”?
      </div>

      <div style={{ fontSize: 14, lineHeight: 1.5, color: "rgba(255,255,255,0.8)", maxWidth: 600 }}>
        Book a free consultation call. We’ll map out where your child is right now, where they need
        to be, and what it’ll take to get there. Zero pressure.
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button style={primaryCtaStyleLarge} onClick={handlePrimaryCta}>
          {userEmail && role ? "Open Dashboard" : "Book a free consult"}
        </button>
        <button style={ghostButtonStyle} onClick={() => router.push("/auth")}>
          {userEmail && role ? "Switch account" : "Create account"}
        </button>
      </div>

      <div style={{ fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.5)", marginTop: 8 }}>
        Apex Tutoring · Calgary, AB · Online math tutoring for Grades 4–12
      </div>
    </section>
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#0f0f0f",
        backgroundImage:
          "radial-gradient(circle at 20% 20%, rgba(77,177,255,0.12) 0%, rgba(0,0,0,0) 70%), radial-gradient(circle at 80% 30%, rgba(80,255,150,0.08) 0%, rgba(0,0,0,0) 60%)",
        backgroundRepeat: "no-repeat",
        color: "#fff",
        paddingBottom: 80,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ flex: "0 0 auto", paddingTop: 24 }}>{NavBar}</div>
      <div style={{ flex: "0 0 auto" }}>{Hero}</div>
      <div style={{ flex: "0 0 auto" }}>{Programs}</div>
      <div style={{ flex: "0 0 auto" }}>{HowItWorks}</div>
      <div style={{ flex: "0 0 auto" }}>{WhyApex}</div>
      <div style={{ flex: "0 0 auto" }}>{FooterCta}</div>
    </main>
  );
}

/* --- tiny style helpers --- */
const navButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "0",
  padding: 0,
  color: "#fff",
  opacity: 0.8,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1.2,
};

const primaryCtaStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "#3a6",
  border: "1px solid #6ecf9a",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.2,
  fontWeight: 500,
  cursor: "pointer",
  minWidth: 110,
  textAlign: "center",
};

const primaryCtaStyleLarge: React.CSSProperties = {
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
};

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

const programCardStyle: React.CSSProperties = {
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(15,15,15,0.0) 100%)",
  border: "1px solid rgba(255,255,255,0.15)",
  boxShadow:
    "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
  borderRadius: 16,
  padding: "20px 20px 16px 20px",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  minHeight: 260,
};

const programCardHeaderStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.3,
  color: "#fff",
  marginBottom: 8,
  letterSpacing: "-0.03em",
};

const programCardBodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "rgba(255,255,255,0.8)",
  marginBottom: 12,
};

const programListStyle: React.CSSProperties = {
  paddingLeft: 16,
  margin: 0,
  listStyle: "disc",
  fontSize: 13,
  lineHeight: 1.5,
  color: "rgba(255,255,255,0.8)",
  marginBottom: 12,
} as React.CSSProperties;

const programCtaStyle: React.CSSProperties = {
  marginTop: "auto",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 500,
  color: "#fff",
  padding: "8px 10px",
  textAlign: "center",
  boxShadow:
    "0 20px 60px rgba(0,0,0,0.9), 0 1px 2px rgba(255,255,255,0.08) inset",
};

const stepCardStyle: React.CSSProperties = {
  backgroundColor: "rgba(20,20,20,0.7)",
  border: "1px solid rgba(255,255,255,0.12)",
  boxShadow:
    "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
  borderRadius: 16,
  padding: "20px",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minHeight: 200,
};

const stepNumberStyle: React.CSSProperties = {
  background: "#3a6",
  border: "1px solid #6ecf9a",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
  borderRadius: 6,
  padding: "4px 8px",
  alignSelf: "flex-start",
  boxShadow:
    "0 20px 60px rgba(0,0,0,0.9), 0 1px 2px rgba(255,255,255,0.15) inset",
};

const stepTitleStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.3,
  fontWeight: 600,
  color: "#fff",
  letterSpacing: "-0.03em",
};

const stepBodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "rgba(255,255,255,0.8)",
};
