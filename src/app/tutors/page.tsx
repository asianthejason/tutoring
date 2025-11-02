"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  DocumentData,
} from "firebase/firestore";

type TutorInfo = {
  uid: string;
  displayName: string;
  email: string;
  roomId: string;
  status: "offline" | "available" | "busy" | string;
  subjects: string[];
};

export default function TutorsLobbyPage() {
  const router = useRouter();

  const [tutors, setTutors] = useState<TutorInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // listen to all users where role == "tutor"
    const q = query(collection(db, "users"), where("role", "==", "tutor"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: TutorInfo[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data() as DocumentData;
          list.push({
            uid: docSnap.id,
            displayName: data.displayName || "Tutor",
            email: data.email || "",
            roomId: data.roomId || "",
            status: data.status || "offline",
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
          });
        });

        // Sort tutors so "available" shows first, then "busy", then "offline"
        const rank: Record<string, number> = {
          available: 0,
          busy: 1,
          offline: 2,
        };

        list.sort((a, b) => {
          const ra = rank[a.status] ?? 99;
          const rb = rank[b.status] ?? 99;
          if (ra !== rb) return ra - rb;
          return a.displayName.localeCompare(b.displayName);
        });

        setTutors(list);
        setLoading(false);
      },
      (err) => {
        console.error("[/tutors] onSnapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, []);

  function statusChipColor(s: string) {
    switch (s) {
      case "available":
        return {
          bg: "#163b24",
          border: "#3a6",
          text: "#6ecf9a",
          label: "Available",
        };
      case "busy":
        return {
          bg: "#3b2f16",
          border: "#d4a23c",
          text: "#ffd277",
          label: "Busy",
        };
      default:
        // offline
        return {
          bg: "#442424",
          border: "#a66",
          text: "#ff8b8b",
          label: "Offline",
        };
    }
  }

  function handleJoin(tutor: TutorInfo) {
    // We'll wire this in next step so that /room uses tutor.roomId
    // For now we just route with ?roomId=...
    if (!tutor.roomId) return;
    router.push(`/room?roomId=${encodeURIComponent(tutor.roomId)}`);
  }

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
      {/* HEADER / NAV */}
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
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
            }}
          >
            Calgary Math Specialists
          </div>
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

      {/* BODY */}
      <section
        style={{
          flex: "1 1 auto",
          width: "100%",
          maxWidth: "1280px",
          margin: "24px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Title / intro */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            color: "#fff",
            maxWidth: 800,
            lineHeight: 1.3,
          }}
        >
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.03em",
              color: "#fff",
            }}
          >
            Get live math help
          </div>
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.4,
              opacity: 0.8,
              color: "#fff",
              marginTop: 8,
            }}
          >
            Pick a tutor below. If they’re available, you’ll join their
            1-on-1 room instantly. If they’re helping someone, you’ll be
            placed in queue and they’ll pull you in next.
          </div>
        </div>

        {/* List container */}
        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px,100%),1fr))",
            gap: 16,
          }}
        >
          {loading && (
            <div
              style={{
                gridColumn: "1 / -1",
                fontSize: 14,
                color: "#fff",
                opacity: 0.7,
              }}
            >
              Loading tutors…
            </div>
          )}

          {!loading && tutors.length === 0 && (
            <div
              style={{
                gridColumn: "1 / -1",
                fontSize: 14,
                color: "#fff",
                opacity: 0.7,
              }}
            >
              No tutors yet. Check back soon.
            </div>
          )}

          {!loading &&
            tutors.map((tutor) => {
              const chip = statusChipColor(tutor.status);
              const canJoin = tutor.status !== "offline" && tutor.roomId;

              return (
                <div
                  key={tutor.uid}
                  style={{
                    borderRadius: 12,
                    background:
                      "radial-gradient(circle at 0% 0%, rgba(255,255,255,0.08) 0%, rgba(20,20,20,0.6) 60%)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    boxShadow:
                      "0 30px 80px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.6)",
                    padding: "16px 16px 14px",
                    color: "#fff",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    minHeight: 150,
                  }}
                >
                  {/* Top row: name + status */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      rowGap: 8,
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        lineHeight: 1.3,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: "#fff",
                          letterSpacing: "-0.03em",
                        }}
                      >
                        {tutor.displayName || "Tutor"}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(255,255,255,0.6)",
                          wordBreak: "break-word",
                          lineHeight: 1.4,
                          maxWidth: "260px",
                        }}
                      >
                        {tutor.email}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
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
                      >
                        {chip.label}
                      </div>
                    </div>
                  </div>

                  {/* Subjects */}
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: 1.4,
                      color: "rgba(255,255,255,0.75)",
                      minHeight: 32,
                    }}
                  >
                    {tutor.subjects && tutor.subjects.length > 0 ? (
                      <>
                        <div
                          style={{
                            fontSize: 12,
                            opacity: 0.7,
                            marginBottom: 4,
                          }}
                        >
                          Can help with:
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 6,
                          }}
                        >
                          {tutor.subjects.map((subj, i) => (
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
                              {subj}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.6,
                        }}
                      >
                        Subjects not listed yet.
                      </div>
                    )}
                  </div>

                  {/* Join button */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "row",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <button
                      disabled={!canJoin}
                      onClick={() => handleJoin(tutor)}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        background: canJoin ? "#3a6" : "#2a2a2a",
                        border: canJoin
                          ? "1px solid #6ecf9a"
                          : "1px solid #444",
                        color: "#fff",
                        fontSize: 14,
                        lineHeight: 1.2,
                        fontWeight: 500,
                        cursor: canJoin ? "pointer" : "not-allowed",
                        minWidth: 120,
                        textAlign: "center",
                      }}
                      title={
                        canJoin
                          ? "Enter this tutor’s room"
                          : "Tutor is offline right now"
                      }
                    >
                      Join Room
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      {/* FOOTER */}
      <footer
        style={{
          flex: "0 0 auto",
          width: "100%",
          maxWidth: "1280px",
          margin: "32px auto 0",
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
          Need math help tonight?
        </div>

        <div style={{ marginBottom: 12 }}>
          Hop into an available room and get 1-on-1 support.
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
