// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

type Role = "tutor" | "student" | "admin";

export default function DashboardRouterPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/auth");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const role = (snap.data()?.role as Role) || "student";

        if (role === "tutor") {
          router.replace("/dashboard/tutor");
        } else if (role === "student") {
          router.replace("/dashboard/student");
        } else if (role === "admin") {
          router.replace("/admin");
        } else {
          setError("Unknown role");
          setChecking(false);
        }
      } catch (err) {
        console.error(err);
        setError("Failed to load profile");
        setChecking(false);
      }
    });

    return () => unsub();
  }, [router]);

  if (checking) {
    return (
      <main
        style={{
          minHeight: "100vh",
          backgroundColor: "#0f0f0f",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        Loading dashboard…
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#0f0f0f",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
      }}
    >
      {error || "Unable to route."}
    </main>
  );
}
