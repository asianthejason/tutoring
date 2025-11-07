// src/app/tutors/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
  DocumentData,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

type TutorInfo = {
  uid: string;
  displayName: string;
  email: string;
  roomId: string;
  statusRaw: "offline" | "available" | "busy" | string;
  subjects: string[];
  lastActiveAt?: number; // ms epoch (derived)
  presenceUpdatedAt?: number; // ms epoch (derived)
};

// consider presence stale after 90s
const STALE_MS = 90_000;

/** Normalize Firestore timestamp-ish values into a ms epoch number */
function tsToMs(v: unknown): number | undefined {
  if (!v) return undefined;
  // Firestore Timestamp
  if (v instanceof Timestamp) return v.toMillis();
  // { seconds, nanoseconds }
  if (
    typeof v === "object" &&
    v !== null &&
    "seconds" in (v as any) &&
    typeof (v as any).seconds === "number"
  ) {
    return (v as any).seconds * 1000;
  }
  // number (ms epoch)
  if (typeof v === "number") return v;
  // string (iso or ms)
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 10_000_000_000) return n;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return undefined;
}

function deriveStatusLabel(t: TutorInfo): {
  label: "Available" | "Busy" | "Offline";
  online: boolean;
  busy: boolean;
} {
  const now = Date.now();
  const freshest = Math.max(
    t.presenceUpdatedAt ?? 0,
    t.lastActiveAt ?? 0
  );

  const fresh = freshest > 0 && now - freshest < STALE_MS;

  if (!fresh) {
    return { label: "Offline", online: false, busy: false };
  }

  // Fresh heartbeat: only "Busy" if tutor explicitly set it
  if (t.statusRaw === "busy") {
    return { label: "Busy", online: true, busy: true };
  }

  // Any other fresh case => Available
  return { label: "Available", online: true, busy: false };
}

export default function TutorsLobbyPage() {
  const router = useRouter();
  const [tutors, setTutors] = useState<TutorInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1) subscribe to all tutors
    const q = query(collection(db, "users"), where("role", "==", "tutor"));

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const base: TutorInfo[] = [];
        const presenceReads: Promise<void>[] = [];

        snap.forEach((d) => {
          const data = d.data() as DocumentData;

          const item: TutorInfo = {
            uid: d.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            statusRaw: (data.status as any) || "offline",
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
            lastActiveAt: tsToMs(data.lastActiveAt),
          };

          // 2) try to read a presence heartbeat doc per tutor (optional)
          // If you don't maintain presence/{uid}, this read will 404 quickly and we'll just rely on lastActiveAt
          presenceReads.push(
            (async () => {
              try {
                const pDoc = await getDoc(doc(db, "presence", item.uid));
                if (pDoc.exists()) {
                  const p = pDoc.data();
                  item.presenceUpdatedAt = tsToMs(
                    p.updatedAt ?? p.lastSeen ?? p.ts
                  );
                }
              } catch {
                /* ignore */
              }
            })()
          );

          base.push(item);
        });

        // wait for presence lookups (they're very fast; still keep UI smooth)
        await Promise.allSettled(presenceReads);

        // 3) sort by derived status
        const ranked = base
          .slice()
          .sort((a, b) => {
            const sa = deriveStatusLabel(a);
            const sb = deriveStatusLabel(b);
            const rank = (s: ReturnType<typeof deriveStatusLabel>) =>
              s.label === "Available" ? 0 : s.label === "Busy" ? 1 : 2;
            const ra = rank(sa);
            const rb = rank(sb);
            if (ra !== rb) return ra - rb;
            return (a.displayName || "").localeCompare(b.displayName || "");
          });

        setTutors(ranked);
        setLoading(false);
      },
      (err) => {
        console.error("[/tutors] onSnapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, []);

  const cards = useMemo(() => {
    return tutors.map((t) => {
      const d = deriveStatusLabel(t);
      const canJoin =
        d.online && !d.busy && Boolean(t.roomId); // only allow instant join if Available

      const chip =
        d.label === "Available"
          ? { bg: "#163b24", border: "#3a6", text: "#6ecf9a", label: "Available" }
          : d.label === "Busy"
          ? { bg: "#3b2f16", border: "#d4a23c", text: "#ffd277", label: "Busy" }
          : { bg: "#442424", border: "#a66", text: "#ff8b8b", label: "Offline" };

      return (
        <div
          key={t.uid}
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
            minHeight: 150,
          }}
        >
          {/* header row */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              rowGap: 8,
              alignItems: "flex-start",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#fff",
                  letterSpacing: "-0.03em",
                }}
              >
                {t.displayName || "Tutor"}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.6)",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                  maxWidth: 260,
                }}
              >
                {t.email}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div
                style={{
                  backgroundColor: chip.bg,
                  border: `1px solid ${chip.border}`,
                  color: chip.text,
                  fontSize: 12,
                  lineHeight: 1.2,
                  padding: "6px 10px",
                  borderRadius: 8,
                  minWidth: 70,
                  textAlign: "center",
                  fontWeight: 500,
                }}
                title={
                  d.label !== "Offline"
                    ? `Last seen ${new Date(
                        Math.max(t.presenceUpdatedAt ?? 0, t.lastActiveAt ?? 0)
                      ).toLocaleTimeString()}`
                    : "No recent heartbeat"
                }
              >
                {chip.label}
              </div>
            </div>
          </div>

          {/* subjects */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.75)",
              minHeight: 32,
            }}
          >
            {t.subjects?.length ? (
              <>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>Can help with:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {t.subjects.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        backgroundColor: "#2a2a2a",
                        border: "1px solid #444",
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: 1.2,
                        padding: "4px 8px",
                        color: "#fff",
                      }}
                    >
                      {s}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.6 }}>Subjects not listed yet.</div>
            )}
          </div>

          {/* action button */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              disabled={!t.roomId}
              onClick={() => {
                if (!t.roomId) return;
                router.push(`/room?roomId=${encodeURIComponent(t.roomId)}`);
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: canJoin ? "#3a6" : "#2a2a2a",
                border: canJoin ? "1px solid #6ecf9a" : "1px solid #444",
                color: "#fff",
                fontSize: 14,
                lineHeight: 1.2,
                fontWeight: 500,
                cursor: canJoin ? "pointer" : "not-allowed",
                minWidth: 120,
                textAlign: "center",
              }}
              title={
                !t.roomId
                  ? "Tutor does not have a room configured"
                  : canJoin
                  ? "Enter this tutor’s room"
                  : d.label === "Busy"
                  ? "They’re helping someone—use queue on the dashboard"
                  : "Tutor is offline right now"
              }
            >
              {canJoin ? "Join Room" : d.label === "Busy" ? "Join Queue" : "Join (offline)"}
            </button>
          </div>
        </div>
      );
    });
  }, [tutors, router]);

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
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* header */}
      <header
        style={{
          width: "100%",
          maxWidth: 1280,
          margin: "0 auto",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          borderRadius: 12,
          background: "linear-gradient(to right, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 2px 4px rgba(255,255,255,0.08) inset",
        }}
      >
        <div style={{ color: "#fff", display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>Apex Tutoring</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Calgary Math Specialists</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            style={{
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
            }}
            onClick={() => router.push("/")}
          >
            ← Home
          </button>
        </div>
      </header>

      {/* body */}
      <section
        style={{
          flex: "1 1 auto",
          width: "100%",
          maxWidth: 1280,
          margin: "24px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", color: "#fff", maxWidth: 800, lineHeight: 1.3 }}>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em", color: "#fff" }}>
            Get live math help
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.8, color: "#fff", marginTop: 8 }}>
            Pick a tutor below. If they’re available, you’ll join their 1-on-1 room instantly. If they’re helping
            someone, you’ll be placed in queue and they’ll pull you in next.
          </div>
        </div>

        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px,100%),1fr))",
            gap: 16,
          }}
        >
          {loading ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, color: "#fff", opacity: 0.7 }}>
              Loading tutors…
            </div>
          ) : tutors.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 14, color: "#fff", opacity: 0.7 }}>
              No tutors yet. Check back soon.
            </div>
          ) : (
            cards
          )}
        </div>
      </section>

      {/* footer */}
      <footer
        style={{
          flex: "0 0 auto",
          width: "100%",
          maxWidth: 1280,
          margin: "32px auto 0",
          padding: "16px 24px 0",
          color: "rgba(255,255,255,0.5)",
          fontSize: 12,
          lineHeight: 1.4,
          textAlign: "center",
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginBottom: 6 }}>
          Need math help tonight?
        </div>
        <div style={{ marginBottom: 12 }}>Hop into an available room and get 1-on-1 support.</div>
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
