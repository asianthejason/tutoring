"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  RemoteTrackPublication,
  LocalTrackPublication,
  Track,
  Participant,
  LocalParticipant,
} from "livekit-client";
import { useRouter } from "next/navigation";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, updateDoc } from "firebase/firestore";

type Role = "tutor" | "student" | "admin";

type TokenResp = {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  role: Role;
  name: string;
};

type StrokePoint = { x: number; y: number };
type Stroke = { color: string; size: number; points: StrokePoint[] };

function qp(name: string, fallback?: string) {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function isStudentId(id: string | undefined | null) {
  if (!id) return false;
  return id.toLowerCase().startsWith("student");
}
function isTutorId(id: string | undefined | null) {
  if (!id) return false;
  return id.toLowerCase().startsWith("tutor");
}
function isObserverId(id: string | undefined | null) {
  if (!id) return false;
  return id.toLowerCase().startsWith("admin");
}

export default function RoomPage() {
  const router = useRouter();

  const [authed, setAuthed] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [lockedRole, setLockedRole] = useState<Role | null>(null);

  const initialRoomFromQP = qp("roomId", "") || "";
  const [sessionRoomId, setSessionRoomId] = useState<string>(initialRoomFromQP);

  const desiredName = qp("name", "Student");

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [status, setStatus] = useState("Joining…");
  const [error, setError] = useState<string | null>(null);

  const [myIdentity, setMyIdentity] = useState<string>("");
  const myIdRef = useRef<string>("");

  const [students, setStudents] = useState<{ id: string; name: string }[]>([]);

  const [tiles, setTiles] = useState<
    {
      id: string;
      name: string;
      isLocal: boolean;
      pub: RemoteTrackPublication | LocalTrackPublication | null;
      pid: string;
      placeholder?: boolean;
    }[]
  >([]);

  const [orderedTiles, setOrderedTiles] = useState<typeof tiles>([]);

  const [tileSize, setTileSize] = useState<{ w: number; h: number }>({
    w: 360,
    h: 270,
  });

  const [activeSpeakers, setActiveSpeakers] = useState<Set<string>>(
    new Set()
  );

  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);

  const [iCanHearTutor, setICanHearTutor] = useState<boolean | null>(null);

  const [canHearTutor, setCanHearTutor] = useState<Record<string, boolean>>({});
  const [canSpeakToTutor, setCanSpeakToTutor] = useState<
    Record<string, boolean>
  >({});

  const hearMapRef = useRef<Record<string, boolean>>({});
  const speakMapRef = useRef<Record<string, boolean>>({});

  const [permVersion, setPermVersion] = useState(0);

  const pendingTutorSubsRef = useRef<Record<string, boolean>>({});

  const mainRef = useRef<HTMLElement>(null);
  const videoColumnRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);

  const tutorAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const studentAudioElsRef = useRef<Map<string, HTMLAudioElement>>(
    new Map()
  );

  const [boards, setBoards] = useState<Record<string, Stroke[]>>({});
  const boardsRef = useRef<Record<string, Stroke[]>>({});

  const [viewBoardFor, setViewBoardFor] = useState<string>("");
  const viewBoardForRef = useRef<string>("");

  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [strokeColor, setStrokeColor] = useState<string>("#ffffff");
  const [strokeSize, setStrokeSize] = useState<number>(3);

  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wbContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    viewBoardForRef.current = viewBoardFor;
  }, [viewBoardFor]);

  // 🔥 FIXED: preserve full URL (including ?roomId=...) when forcing login
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        // user not signed in -> send them to /auth
        // include the ENTIRE /room?... in the "from" param
        const fullDest =
          typeof window !== "undefined"
            ? window.location.pathname + window.location.search
            : "/room";

        router.replace(
          `/auth?from=${encodeURIComponent(fullDest)}`
        );
        return;
      }

      setAuthed(true);
      setUserEmail(user.email ?? null);

      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.exists() ? snap.data() : null;

      const r = ((data?.role as Role) || "student") as Role;
      setLockedRole(r);

      const tutorRoomIdFromDoc =
        typeof data?.roomId === "string" ? data.roomId : "";

      if (r === "tutor") {
        if (tutorRoomIdFromDoc) {
          setSessionRoomId(tutorRoomIdFromDoc);

          try {
            await updateDoc(doc(db, "users", user.uid), {
              lastActiveAt: Date.now(),
            });
          } catch {
            /* ignore */
          }

          if (!initialRoomFromQP && typeof window !== "undefined") {
            router.replace(
              `/room?roomId=${encodeURIComponent(tutorRoomIdFromDoc)}`
            );
          }
        } else {
          router.replace("/dashboard/tutor");
          return;
        }
      } else {
        // student or admin
        if (!initialRoomFromQP) {
          // you made it here without a tutor room -> bye
          router.replace("/dashboard/student");
          return;
        }
        setSessionRoomId(initialRoomFromQP);
      }
    });

    return unsub;
  }, [router, initialRoomFromQP]);

  function canCurrentUserEditBoard(): boolean {
    const me = myIdRef.current;
    const target = viewBoardForRef.current;
    if (!me || !target || !lockedRole) return false;

    if (lockedRole === "admin") return false;
    if (lockedRole === "tutor") return true;
    if (lockedRole === "student") return me === target;
    return false;
  }

  function computeStudentHearing(meId: string) {
    return !!hearMapRef.current[meId];
  }
  function computeTutorHearingStudent(studId: string) {
    return !!speakMapRef.current[studId];
  }

  function killStudentAudioLocally() {
    if (lockedRole !== "student") return;
    [tutorAudioElsRef.current, studentAudioElsRef.current].forEach((map) => {
      for (const [, el] of map.entries()) {
        if (el) {
          el.pause();
          el.remove();
        }
      }
      map.clear();
    });
  }

  function syncLocalAVFlags(lp: LocalParticipant | undefined) {
    if (!lp) return;
    const micEnabled = Array.from(lp.audioTrackPublications.values()).some(
      (pub) => pub.isEnabled && pub.track
    );
    const camEnabled = Array.from(lp.videoTrackPublications.values()).some(
      (pub) => pub.isEnabled && pub.track
    );
    setMicOn(micEnabled);
    setCamOn(camEnabled);
  }

  async function ensureLocalMediaPermission(
    kind: "camera" | "mic" | "both"
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("No getUserMedia.");
      return;
    }

    const constraints: MediaStreamConstraints =
      kind === "camera"
        ? { video: true }
        : kind === "mic"
        ? { audio: true }
        : { audio: true, video: true };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      console.warn("[ensureLocalMediaPermission] failed:", err);
    }
  }

  function redrawCanvas(strokes: Stroke[] | undefined) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    (strokes || []).forEach((stroke) => {
      if (!stroke.points.length) return;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      const first = stroke.points[0];
      ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      }
      ctx.stroke();
    });
  }

  function ensureBoard(pid: string) {
    if (!boardsRef.current[pid]) {
      boardsRef.current[pid] = [];
      setBoards((prev) => ({
        ...prev,
        [pid]: boardsRef.current[pid],
      }));
    }
  }

  function appendStroke(authorId: string, stroke: Stroke) {
    ensureBoard(authorId);
    const existing = boardsRef.current[authorId] || [];
    const updated = [...existing, stroke];
    boardsRef.current[authorId] = updated;

    setBoards((prev) => ({
      ...prev,
      [authorId]: updated,
    }));

    if (authorId === viewBoardForRef.current) {
      redrawCanvas(updated);
    }
  }

  function replaceBoard(authorId: string, strokes: Stroke[]) {
    boardsRef.current[authorId] = strokes.slice();
    setBoards((prev) => ({
      ...prev,
      [authorId]: strokes.slice(),
    }));

    if (authorId === viewBoardForRef.current) {
      redrawCanvas(strokes);
    }
  }

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const holder = wbContainerRef.current;
    if (!canvas || !holder) return;

    const rect = holder.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const curId = viewBoardForRef.current;
    redrawCanvas(boardsRef.current[curId] || []);
  }, []);

  useEffect(() => {
    resizeCanvas();
  }, [viewBoardFor, resizeCanvas]);

  useEffect(() => {
    function onWinResize() {
      resizeCanvas();
    }
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [resizeCanvas]);

  function getActiveColor() {
    return tool === "eraser" ? "#111" : strokeColor;
  }

  function getActiveSize() {
    return strokeSize;
  }

  function startDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!canCurrentUserEditBoard()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawingRef.current = true;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    currentStrokeRef.current = {
      color: getActiveColor(),
      size: getActiveSize(),
      points: [{ x, y }],
    };
  }

  function moveDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    currentStrokeRef.current.points.push({ x, y });

    const curViewedId = viewBoardForRef.current;
    const tempStrokes = [
      ...(boardsRef.current[curViewedId] || []),
      currentStrokeRef.current,
    ];
    redrawCanvas(tempStrokes);
  }

  async function endDraw() {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    drawingRef.current = false;

    const room = roomRef.current;
    if (!room) {
      currentStrokeRef.current = null;
      return;
    }

    const targetBoardId = viewBoardForRef.current;
    if (!targetBoardId) {
      currentStrokeRef.current = null;
      return;
    }

    const finalStroke = currentStrokeRef.current;
    currentStrokeRef.current = null;

    appendStroke(targetBoardId, finalStroke);

    const msg = {
      type: "wbstroke",
      author: targetBoardId,
      stroke: finalStroke,
    };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }

  async function clearViewedBoard() {
    if (!canCurrentUserEditBoard()) return;
    const targetId = viewBoardForRef.current;
    if (!targetId) return;

    replaceBoard(targetId, []);

    const room = roomRef.current;
    if (room) {
      const msg = {
        type: "wb_clear",
        author: targetId,
      };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      try {
        await room.localParticipant.publishData(data, { reliable: true });
      } catch {}
    }
  }

  async function broadcastFullBoard(authorId: string) {
    const room = roomRef.current;
    if (!room) return;
    ensureBoard(authorId);

    const fullBoard = boardsRef.current[authorId] || [];
    const msg = {
      type: "wb_sync",
      author: authorId,
      strokes: fullBoard,
    };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }

  async function requestBoardSync(authorId: string) {
    const room = roomRef.current;
    if (!room) return;

    const have = boardsRef.current[authorId] || [];
    if (have.length > 0) return;

    const msg = {
      type: "wb_request",
      author: authorId,
    };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await room.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }

  function getTutorMicPub(room: Room) {
    const tutor = Array.from(room.remoteParticipants.values()).find((p) =>
      isTutorId(p.identity)
    );
    if (!tutor) return undefined;
    return Array.from(tutor.audioTrackPublications.values()).find(
      (pub) => pub.source === Track.Source.Microphone
    );
  }

  function playTutorAudio(pub: RemoteTrackPublication, shouldHear: boolean) {
    const map = tutorAudioElsRef.current;
    const sid = pub.trackSid || pub.track?.sid || "tutor-audio";
    const existing = map.get(sid);

    if (!shouldHear) {
      if (existing) {
        existing.pause();
        pub.track?.detach(existing);
        existing.remove();
        map.delete(sid);
      }
      return;
    }

    const track = pub.track;
    if (!track) return;

    if (existing) {
      existing.muted = false;
      existing.autoplay = true;
      existing.play().catch(() => {});
      return;
    }

    const el = track.attach() as HTMLAudioElement;
    el.style.display = "none";
    el.autoplay = true;
    el.muted = false;
    document.body.appendChild(el);
    el.play().catch(() => {});
    map.set(sid, el);
  }

  function applyStudentHearing(room: Room) {
    if (lockedRole !== "student") return;
    const me = myIdRef.current || room.localParticipant.identity;
    const shouldHear = computeStudentHearing(me);

    killStudentAudioLocally();

    const micPub = getTutorMicPub(room);
    if (!micPub) {
      setICanHearTutor(shouldHear);
      return;
    }

    try {
      micPub.setSubscribed(shouldHear);
    } catch {}
    playTutorAudio(micPub, shouldHear);
    setICanHearTutor(shouldHear);

    setPermVersion((v) => v + 1);
  }

  function handleTutorListenToStudent(
    pub: RemoteTrackPublication,
    studentId: string
  ) {
    if (lockedRole !== "tutor") return;

    const allow = !!speakMapRef.current[studentId];
    const map = studentAudioElsRef.current;
    const sid = pub.trackSid || pub.track?.sid || `student-${studentId}`;
    const existing = map.get(sid);

    try {
      pub.setSubscribed(allow);
    } catch {}

    if (!allow) {
      if (existing) {
        existing.pause();
        pub.track?.detach(existing);
        existing.remove();
        map.delete(sid);
      }
      delete pendingTutorSubsRef.current[studentId];
      return;
    }

    if (pub.track) {
      if (existing) {
        existing.muted = false;
        existing.autoplay = true;
        existing.play().catch(() => {});
        delete pendingTutorSubsRef.current[studentId];
        return;
      }

      const el = pub.track.attach() as HTMLAudioElement;
      el.style.display = "none";
      el.autoplay = true;
      el.muted = false;
      document.body.appendChild(el);
      el.play().catch(() => {});
      map.set(sid, el);
      delete pendingTutorSubsRef.current[studentId];
      return;
    }

    pendingTutorSubsRef.current[studentId] = true;
  }

  function reapplyTutorForStudent(room: Room, studentId: string) {
    if (lockedRole !== "tutor") return;
    const p = Array.from(room.remoteParticipants.values()).find(
      (rp) => rp.identity === studentId
    );
    if (!p) return;

    for (const pub of p.audioTrackPublications.values()) {
      if (pub.source === Track.Source.Microphone) {
        handleTutorListenToStudent(pub as RemoteTrackPublication, studentId);
      }
    }
  }

  async function handleDataMessage(msg: any) {
    const room = roomRef.current;
    if (!room || !msg) return;

    if (msg.type === "perm") {
      const { studentId, hear, speak } = msg;

      hearMapRef.current[studentId] = !!hear;
      speakMapRef.current[studentId] = !!speak;

      if (lockedRole === "tutor") {
        setCanHearTutor((prev) => ({ ...prev, [studentId]: !!hear }));
        setCanSpeakToTutor((prev) => ({ ...prev, [studentId]: !!speak }));
        reapplyTutorForStudent(room, studentId);
        setPermVersion((v) => v + 1);
      }

      if (
        lockedRole === "student" &&
        (myIdRef.current || room.localParticipant.identity) === studentId
      ) {
        applyStudentHearing(room);
      } else if (lockedRole === "student") {
        setPermVersion((v) => v + 1);
      }
    }

    if (msg.type === "wbstroke") {
      const { author, stroke } = msg;
      ensureBoard(author);
      appendStroke(author, stroke);
    }

    if (msg.type === "wb_sync") {
      const { author, strokes } = msg as {
        author: string;
        strokes: Stroke[];
      };
      ensureBoard(author);
      replaceBoard(author, strokes);
    }

    if (msg.type === "wb_request") {
      const { author } = msg as { author: string };
      if (author === myIdRef.current) {
        await broadcastFullBoard(author);
      }
    }

    if (msg.type === "wb_clear") {
      const { author } = msg as { author: string };
      replaceBoard(author, []);
    }
  }

  async function broadcastPermUpdate(
    studentId: string,
    hear: boolean,
    speak: boolean
  ) {
    const room = roomRef.current;
    if (!room) return;

    hearMapRef.current[studentId] = hear;
    speakMapRef.current[studentId] = speak;

    setCanHearTutor((prev) => ({ ...prev, [studentId]: hear }));
    setCanSpeakToTutor((prev) => ({ ...prev, [studentId]: speak }));
    setPermVersion((v) => v + 1);

    const msg = { type: "perm", studentId, hear, speak };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    await room.localParticipant.publishData(data, { reliable: true });

    if (lockedRole === "tutor") {
      reapplyTutorForStudent(room, studentId);
    }
  }

  function wireEvents(room: Room) {
    room
      .on(RoomEvent.ParticipantConnected, (p: Participant) => {
        refreshTilesAndRoster(room);

        ensureBoard(p.identity || "");
        broadcastFullBoard(myIdRef.current);

        if (lockedRole === "student") {
          applyStudentHearing(room);
        }
        if (lockedRole === "tutor") {
          students.forEach((s) => {
            reapplyTutorForStudent(room, s.id);
          });
        }

        setTimeout(() => {
          resizeCanvas();
        }, 0);
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        refreshTilesAndRoster(room);
        setTimeout(() => {
          resizeCanvas();
        }, 0);
      })
      .on(RoomEvent.TrackSubscribed, (_track, pub, participant) => {
        refreshTilesAndRoster(room);

        const pid = participant.identity || "";
        const studentPid = isStudentId(pid);
        const tutorPid = isTutorId(pid);

        if (lockedRole === "student") {
          if (pub.kind === "audio" && tutorPid) {
            applyStudentHearing(room);
          }
          if (pub.kind === "audio" && studentPid) {
            const rpub = pub as RemoteTrackPublication;
            try {
              rpub.setSubscribed(false);
            } catch {}
            killStudentAudioLocally();
          }
        }

        if (lockedRole === "tutor") {
          if (pub.kind === "audio" && studentPid) {
            if (
              pendingTutorSubsRef.current[pid] ||
              speakMapRef.current[pid]
            ) {
              handleTutorListenToStudent(
                pub as RemoteTrackPublication,
                pid
              );
            }
          }
        }

        if (lockedRole === "admin") {
          if (pub.kind === "audio") {
            const rpub = pub as RemoteTrackPublication;
            try {
              rpub.setSubscribed(false);
            } catch {}
          }
        }
      })
      .on(RoomEvent.TrackUnsubscribed, () => {
        refreshTilesAndRoster(room);
      })
      .on(RoomEvent.TrackPublished, () => {
        refreshTilesAndRoster(room);
        syncLocalAVFlags(room.localParticipant);
      })
      .on(RoomEvent.TrackUnpublished, () => {
        refreshTilesAndRoster(room);
        syncLocalAVFlags(room.localParticipant);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setActiveSpeakers(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.DataReceived, (payload) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          handleDataMessage(msg);
        } catch {}
      })
      .on(RoomEvent.Disconnected, () => {
        setStatus("Disconnected");
      });
  }

  useEffect(() => {
    if (!authed || !lockedRole) return;

    if (!sessionRoomId) {
      setStatus("Missing room link");
      setError(
        "Ask your tutor for their session link (it includes ?roomId=...)"
      );
      return;
    }

    let room: Room | null = null;

    (async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();

        const bodyPayload: any = {
          role: lockedRole,
          name: desiredName,
          roomId: sessionRoomId,
        };

        const res = await fetch("/api/rooms/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify(bodyPayload),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `Token endpoint failed: ${res.status}`);
        }

        const { token, url, roomName, identity } =
          (await res.json()) as TokenResp;

        setMyIdentity(identity);
        myIdRef.current = identity;

        ensureBoard(identity);
        setViewBoardFor(identity);
        viewBoardForRef.current = identity;

        const signalingUrl = `${url}/${roomName}`;
        room = new Room();
        roomRef.current = room;

        await room.connect(signalingUrl, token);

        if (lockedRole === "tutor") {
          const otherTutor = Array.from(
            room.remoteParticipants.values()
          ).find((p) => isTutorId(p.identity));
          if (otherTutor) {
            setStatus(
              "Another tutor is already in the room. This tab will leave."
            );
            room.disconnect();
            return;
          }

          try {
            const currentUser = auth.currentUser;
            if (currentUser) {
              await updateDoc(doc(db, "users", currentUser.uid), {
                lastActiveAt: Date.now(),
              });
            }
          } catch {
            /* ignore */
          }
        }

        if (lockedRole === "admin") {
          try {
            await room.localParticipant.setMicrophoneEnabled(false);
          } catch {}
          try {
            await room.localParticipant.setCameraEnabled(false);
          } catch {}
        } else {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
          } catch (err) {
            console.warn("[auto mic] failed:", err);
          }
          try {
            await room.localParticipant.setCameraEnabled(true);
          } catch (err) {
            console.warn("[auto cam] failed:", err);
          }
        }

        syncLocalAVFlags(room.localParticipant);

        if (lockedRole === "admin") {
          setStatus(`Observer mode in ${sessionRoomId} (mic/cam off)`);
        } else if (lockedRole === "tutor") {
          setStatus(
            "Tutor connected. Use Hear/Speak. Click a feed to view its whiteboard."
          );
        } else {
          setStatus("Connected as Student. Click feeds to view boards.");
        }

        if (lockedRole === "student") {
          hearMapRef.current[identity] = false;
          speakMapRef.current[identity] = false;
          setICanHearTutor(false);
        }
        if (lockedRole === "tutor") {
          hearMapRef.current = {};
          speakMapRef.current = {};
          setCanHearTutor({});
          setCanSpeakToTutor({});
        }

        wireEvents(room);
        refreshTilesAndRoster(room);

        broadcastFullBoard(identity);

        setTimeout(() => {
          resizeCanvas();
        }, 0);
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
        setStatus("Failed to join");
      }
    })();

    return () => {
      room?.disconnect();
    };
  }, [authed, lockedRole, sessionRoomId, desiredName, resizeCanvas]);

  function refreshTilesAndRoster(room: Room) {
    const nextTiles: typeof tiles = [];

    const lp = room.localParticipant;

    if (lockedRole !== "admin") {
      const localVideoPubs: LocalTrackPublication[] = [];
      for (const pub of lp.trackPublications.values()) {
        if (pub.source === Track.Source.Camera) {
          localVideoPubs.push(pub as LocalTrackPublication);
        }
      }
      if (localVideoPubs.length > 0) {
        for (const pub of localVideoPubs) {
          if (pub.track) {
            nextTiles.push({
              id: `local-${pub.trackSid}`,
              name: lp.name ?? lp.identity,
              isLocal: true,
              pub,
              pid: lp.identity,
            });
          }
        }
      } else {
        nextTiles.push({
          id: `local-placeholder-${lp.identity}`,
          name: lp.name ?? lp.identity,
          isLocal: true,
          pub: null,
          pid: lp.identity,
          placeholder: true,
        });
      }
    }

    const roster: { id: string; name: string }[] = [];
    for (const p of room.remoteParticipants.values()) {
      roster.push({ id: p.identity, name: p.name ?? p.identity });

      ensureBoard(p.identity);

      let addedCam = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.Camera && pub.track) {
          nextTiles.push({
            id: `remote-${p.sid}-${pub.trackSid}`,
            name: p.name ?? p.identity,
            isLocal: false,
            pub,
            pid: p.identity,
          });
          addedCam = true;
        }
      }
      if (!addedCam) {
        nextTiles.push({
          id: `remote-placeholder-${p.sid}`,
          name: p.name ?? p.identity,
          isLocal: false,
          pub: null,
          pid: p.identity,
          placeholder: true,
        });
      }
    }

    setTiles(nextTiles);

    const onlyStudents = roster
      .filter((r) => isStudentId(r.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    setStudents(onlyStudents);
  }

  useEffect(() => {
    if (!lockedRole) return;

    const meId = myIdentity;

    const tutorTiles: typeof tiles = [];
    const myTiles: typeof tiles = [];
    const studentTiles: typeof tiles = [];
    const misc: typeof tiles = [];

    for (const t of tiles) {
      const pid = t.pid;
      if (isTutorId(pid)) {
        tutorTiles.push(t);
      } else if (pid === meId) {
        myTiles.push(t);
      } else if (isStudentId(pid)) {
        studentTiles.push(t);
      } else {
        misc.push(t);
      }
    }

    let tutorTile: typeof tiles[number] | undefined;
    if (lockedRole === "tutor") {
      tutorTile =
        tutorTiles.find((tt) => tt.isLocal) || tutorTiles[0] || undefined;
    } else {
      tutorTile = tutorTiles[0];
    }

    const myTile = myTiles[0];
    studentTiles.sort((a, b) => a.name.localeCompare(b.name));

    if (lockedRole === "tutor") {
      const ordered: typeof tiles = [];
      if (myTile) {
        ordered.push(myTile);
      } else if (tutorTile && tutorTile !== myTile) {
        ordered.push(tutorTile);
      }
      ordered.push(...studentTiles);
      ordered.push(...misc);
      setOrderedTiles(ordered);
    } else if (lockedRole === "admin") {
      const orderedTutorView: typeof tiles = [];
      if (tutorTile) orderedTutorView.push(tutorTile);
      orderedTutorView.push(...studentTiles);
      orderedTutorView.push(...misc);

      const filtered = orderedTutorView.filter((t) => {
        if (t.pid === meId && isObserverId(t.pid)) return false;
        return true;
      });

      setOrderedTiles(filtered);
    } else {
      const ordered: typeof tiles = [];
      if (tutorTile) ordered.push(tutorTile);
      if (myTile && myTile !== tutorTile) ordered.push(myTile);
      setOrderedTiles(ordered);
    }
  }, [tiles, lockedRole, myIdentity]);

  const resizeCanvasAndTiles = useCallback(() => {
    if (!mainRef.current || !videoColumnRef.current) return;

    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const tileCount = orderedTiles.length || 1;
    const gap = 12;

    const rectMain = mainRef.current.getBoundingClientRect();
    const rectColumn = videoColumnRef.current.getBoundingClientRect();
    const topSpace = rectColumn.top - rectMain.top;

    const bottomReserve = 80;
    const availableH = vh - topSpace - bottomReserve;
    if (availableH <= 0) return;

    const perTileExtra = 50;
    const totalExtra = perTileExtra * tileCount;
    const totalGap = gap * (tileCount - 1);

    const videoBudget = availableH - totalExtra - totalGap;
    const rawVideoH = videoBudget > 0 ? videoBudget / tileCount : 100;

    const maxColW = Math.min(380, vw * 0.4);

    let h_fromHeight = rawVideoH;
    if (h_fromHeight < 100) h_fromHeight = 100;
    let w_fromHeight = h_fromHeight * (4 / 3);
    if (w_fromHeight > maxColW) {
      w_fromHeight = maxColW;
      h_fromHeight = w_fromHeight * (3 / 4);
    }

    let w_fromWidth = maxColW;
    let h_fromWidth = w_fromWidth * (3 / 4);

    if (h_fromWidth > rawVideoH) {
      setTileSize({
        w: w_fromHeight,
        h: h_fromHeight,
      });
    } else {
      setTileSize({
        w: w_fromWidth,
        h: h_fromWidth,
      });
    }

    setTimeout(() => {
      resizeCanvas();
    }, 0);
  }, [orderedTiles, resizeCanvas]);

  useEffect(() => {
    resizeCanvasAndTiles();
  }, [orderedTiles, resizeCanvasAndTiles]);

  useEffect(() => {
    function onResize() {
      resizeCanvasAndTiles();
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [resizeCanvasAndTiles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.width = "100%";
    container.style.flex = "1 1 auto";
    container.style.minHeight = "0";
    container.style.overflow = "hidden";
    container.style.alignItems = "flex-start";

    container
      .querySelectorAll("div[data-ordered-tilewrap]")
      .forEach((n) => n.remove());

    const meId = myIdRef.current;

    orderedTiles.forEach((t) => {
      const wrap = document.createElement("div");
      wrap.setAttribute("data-ordered-tilewrap", t.id);
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.alignItems = "flex-start";
      wrap.style.gap = "4px";
      wrap.style.maxWidth = `${tileSize.w}px`;

      const frame = document.createElement("div");
      frame.style.display = "flex";
      frame.style.flexDirection = "column";
      frame.style.alignItems = "flex-start";
      frame.style.gap = "4px";
      frame.style.cursor = "pointer";

      frame.onclick = () => {
        setViewBoardFor(t.pid);
        viewBoardForRef.current = t.pid;

        const have = boardsRef.current[t.pid] || [];
        if (have.length === 0) {
          requestBoardSync(t.pid);
        }

        redrawCanvas(boardsRef.current[t.pid] || []);

        setTimeout(() => {
          resizeCanvas();
        }, 0);
      };

      if (t.pub && t.pub.track) {
        const el = t.pub.track.attach();
        const vid = el as HTMLVideoElement;
        vid.muted = t.isLocal;
        vid.playsInline = true;

        vid.style.width = `${tileSize.w}px`;
        vid.style.height = `${tileSize.h}px`;
        vid.style.objectFit = "cover";
        vid.style.borderRadius = "12px";
        vid.style.border = "2px solid #4db1ff";
        vid.style.boxShadow = "0 0 0 0 transparent";

        frame.appendChild(vid);
      } else {
        const ph = document.createElement("div");
        ph.style.width = `${tileSize.w}px`;
        ph.style.height = `${tileSize.h}px`;
        ph.style.borderRadius = "12px";
        ph.style.border = "2px solid #4db1ff";
        ph.style.background = "rgba(255,255,255,0.05)";
        ph.style.display = "flex";
        ph.style.alignItems = "center";
        ph.style.justifyContent = "center";
        ph.style.color = "#fff";
        ph.style.fontSize = "14px";
        ph.style.fontFamily = "system-ui, sans-serif";
        ph.textContent = t.isLocal ? "Camera off (you)" : "Camera off";
        frame.appendChild(ph);
      }

      const label = document.createElement("div");
      label.textContent = t.name || (t.isLocal ? "You" : "Participant");
      label.style.fontSize = "14px";
      label.style.opacity = "0.9";
      label.style.color = "#fff";
      frame.appendChild(label);

      wrap.appendChild(frame);

      const amTutor = lockedRole === "tutor";
      const amAdmin = lockedRole === "admin";
      const amStudent = lockedRole === "student";

      const isRemoteStudentTile =
        amTutor && !t.isLocal && isStudentId(t.pid);

      const isMeStudentTile =
        amStudent && t.pid === meId && isStudentId(t.pid);

      if (isRemoteStudentTile && !amAdmin) {
        const ctlRow = document.createElement("div");
        ctlRow.style.display = "flex";
        ctlRow.style.gap = "8px";
        ctlRow.style.flexWrap = "wrap";
        ctlRow.style.alignItems = "center";

        const hearOn = !!canHearTutor[t.pid];
        const speakOn = !!canSpeakToTutor[t.pid];

        const hearBtn = document.createElement("button");
        hearBtn.textContent = "Hear";
        hearBtn.style.padding = "6px 10px";
        hearBtn.style.borderRadius = "8px";
        hearBtn.style.minWidth = "70px";
        hearBtn.style.fontSize = "13px";
        hearBtn.style.lineHeight = "1.2";
        hearBtn.style.background = hearOn ? "#3a6" : "#2a2a2a";
        hearBtn.style.border = hearOn
          ? "1px solid #6ecf9a"
          : "1px solid #444";
        hearBtn.style.color = "#fff";
        hearBtn.style.cursor = "pointer";

        hearBtn.onclick = async () => {
          const newHear = !hearMapRef.current[t.pid];
          const currentSpeak = speakMapRef.current[t.pid] || false;
          await broadcastPermUpdate(t.pid, newHear, currentSpeak);
        };

        const speakBtn = document.createElement("button");
        speakBtn.textContent = "Speak";
        speakBtn.style.padding = "6px 10px";
        speakBtn.style.borderRadius = "8px";
        speakBtn.style.minWidth = "70px";
        speakBtn.style.fontSize = "13px";
        speakBtn.style.lineHeight = "1.2";
        speakBtn.style.background = speakOn ? "#3a6" : "#2a2a2a";
        speakBtn.style.border = speakOn
          ? "1px solid #6ecf9a"
          : "1px solid #444";
        speakBtn.style.color = "#fff";
        speakBtn.style.cursor = "pointer";

        speakBtn.onclick = async () => {
          const newSpeak = !speakMapRef.current[t.pid];
          const currentHear = hearMapRef.current[t.pid] || false;
          await broadcastPermUpdate(t.pid, currentHear, newSpeak);
        };

        ctlRow.appendChild(hearBtn);
        ctlRow.appendChild(speakBtn);
        wrap.appendChild(ctlRow);
      }

      if (isMeStudentTile && !amAdmin) {
        const indicatorRow = document.createElement("div");
        indicatorRow.style.display = "flex";
        indicatorRow.style.gap = "8px";
        indicatorRow.style.flexWrap = "wrap";
        indicatorRow.style.alignItems = "center";

        const hearAllowed = !!hearMapRef.current[meId];
        const speakAllowed = !!speakMapRef.current[meId];

        function mkPill(labelText: string, allowed: boolean) {
          const pill = document.createElement("div");
          pill.textContent = labelText;
          pill.style.padding = "6px 10px";
          pill.style.borderRadius = "8px";
          pill.style.minWidth = "70px";
          pill.style.fontSize = "13px";
          pill.style.lineHeight = "1.2";
          pill.style.color = "#fff";
          pill.style.textAlign = "center";
          pill.style.userSelect = "none";

          if (allowed) {
            pill.style.background = "#3a6";
            pill.style.border = "1px solid #6ecf9a";
          } else {
            pill.style.background = "#622";
            pill.style.border = "1px solid #a66";
          }
          return pill;
        }

        const hearPill = mkPill("Hear", hearAllowed);
        const speakPill = mkPill("Speak", speakAllowed);

        indicatorRow.appendChild(hearPill);
        indicatorRow.appendChild(speakPill);

        wrap.appendChild(indicatorRow);
      }

      container.appendChild(wrap);
    });

    return () => {
      orderedTiles.forEach((t) => {
        if (t.pub?.track) {
          t.pub.track.detach().forEach((el) => el.remove());
        }
      });
    };
  }, [
    orderedTiles,
    lockedRole,
    canHearTutor,
    canSpeakToTutor,
    tileSize,
    permVersion,
    resizeCanvas,
  ]);

  async function turnCameraOn() {
    const room = roomRef.current;
    if (!room) return;
    if (lockedRole === "admin") return;

    await ensureLocalMediaPermission("camera");
    try {
      await room.localParticipant.setCameraEnabled(true);
      syncLocalAVFlags(room.localParticipant);
      refreshTilesAndRoster(room);
    } catch (err) {
      console.warn("[turnCameraOn] failed:", err);
    }
  }

  async function turnMicOn() {
    const room = roomRef.current;
    if (!room) return;
    if (lockedRole === "admin") return;

    await ensureLocalMediaPermission("mic");
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      syncLocalAVFlags(room.localParticipant);
      refreshTilesAndRoster(room);
    } catch (err) {
      console.warn("[turnMicOn] failed:", err);
    }
  }

  function copyInviteLink() {
    if (!sessionRoomId) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/room?roomId=${encodeURIComponent(
      sessionRoomId
    )}`;
    navigator.clipboard.writeText(link).catch(() => {});
  }

  async function handleSignOut() {
    await signOut(auth).catch(() => {});
    router.replace("/auth");
  }

  const roleLabel = mounted
    ? lockedRole === "tutor"
      ? "Tutor"
      : lockedRole === "student"
      ? "Student"
      : lockedRole === "admin"
      ? "Observer"
      : "…"
    : "…";

  const editable = canCurrentUserEditBoard();

  const inviteLinkUI =
    lockedRole === "tutor" && sessionRoomId ? (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 8,
          padding: "8px 12px",
          marginTop: 8,
          maxWidth: "100%",
          color: "#fff",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            Invite your student:
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              lineHeight: 1.4,
              wordBreak: "break-all",
              color: "#9cf",
            }}
          >
            {typeof window !== "undefined"
              ? `${window.location.origin}/room?roomId=${sessionRoomId}`
              : `/room?roomId=${sessionRoomId}`}
          </div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>
            Give them this link. They’ll log in and automatically join you.
          </div>
        </div>

        <button
          onClick={copyInviteLink}
          style={{
            flex: "0 0 auto",
            padding: "6px 10px",
            borderRadius: 8,
            background: "#2a2a2a",
            border: "1px solid #444",
            color: "#fff",
            fontSize: 12,
            lineHeight: 1.2,
            cursor: "pointer",
            minWidth: 80,
          }}
        >
          Copy link
        </button>
      </div>
    ) : null;

  const showMissingRoomWarning =
    authed && lockedRole && lockedRole !== "tutor" && !sessionRoomId;

  return (
    <main
      ref={mainRef}
      style={{
        position: "relative",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#0f0f0f",
        color: "#fff",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 10,
          padding: "8px 12px",
          marginBottom: 12,
          flex: "0 0 auto",
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.4 }}>
          <div style={{ fontWeight: 500, color: "#fff" }}>
            {userEmail ? userEmail : "…"}
          </div>
          <div style={{ opacity: 0.8, color: "#fff" }}>
            Signed in as {roleLabel}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              if (lockedRole === "tutor") {
                router.push("/dashboard/tutor");
              } else {
                router.push("/dashboard/student");
              }
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 14,
              lineHeight: 1.2,
            }}
          >
            Home
          </button>
          <button
            onClick={handleSignOut}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 14,
              lineHeight: 1.2,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          flex: "0 0 auto",
          color: "#fff",
        }}
      >
        <h1
          style={{
            margin: "0 0 4px",
            color: "#fff",
            fontSize: 16,
            lineHeight: 1.3,
          }}
        >
          Tutoring Room ({roleLabel})
        </h1>
        <p
          style={{
            margin: "0 0 8px",
            color: "#fff",
            opacity: 0.9,
            fontSize: 14,
            lineHeight: 1.4,
          }}
        >
          {status}
        </p>
        {error && (
          <p
            style={{
              color: "tomato",
              marginTop: 0,
              fontSize: 14,
              lineHeight: 1.4,
            }}
          >
            Error: {error}
          </p>
        )}

        {inviteLinkUI}

        {showMissingRoomWarning && (
          <div
            style={{
              background: "rgba(255,0,0,0.08)",
              border: "1px solid rgba(255,0,0,0.4)",
              color: "#ff8b8b",
              borderRadius: 8,
              padding: "8px 12px",
              marginTop: 12,
              fontSize: 13,
              lineHeight: 1.4,
              maxWidth: 480,
            }}
          >
            Ask your tutor for their session link. It should look like:
            /room?roomId=theirRoomIdHere
          </div>
        )}
      </div>

      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          display: "flex",
          flexDirection: "row",
          gap: 16,
          overflow: "hidden",
        }}
      >
        <div
          ref={videoColumnRef}
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            width: `${tileSize.w + 4}px`,
            maxWidth: `${tileSize.w + 4}px`,
            minWidth: `${tileSize.w + 4}px`,
            overflow: "hidden",
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: "100%",
              flex: "1 1 auto",
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          />
        </div>

        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 0,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            backgroundColor: "#111",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              padding: "8px 12px",
              fontSize: 13,
              lineHeight: 1.2,
              color: "#fff",
              background: "rgba(255,255,255,0.06)",
              borderBottom: "1px solid rgba(255,255,255,0.15)",
              flexWrap: "wrap",
              rowGap: "8px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 600, color: "#fff" }}>
                Whiteboard
              </span>
              <span
                style={{
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  lineHeight: 1.2,
                }}
              >
                Viewing: {viewBoardFor || "—"}
              </span>
              <span
                style={{
                  color: "rgba(255,255,255,0.6)",
                  fontSize: 11,
                  lineHeight: 1.2,
                }}
              >
                {editable ? "You can draw" : "Read only"}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                color: "#fff",
                fontSize: 12,
                lineHeight: 1.2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: editable ? 1 : 0.4,
                }}
              >
                {["#ffffff", "#ffe066", "#ff6b6b", "#4dabf7", "#51cf66"].map(
                  (col) => (
                    <div
                      key={col}
                      onClick={() => {
                        if (!editable) return;
                        setTool("pen");
                        setStrokeColor(col);
                      }}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        backgroundColor: col,
                        border:
                          strokeColor === col && tool === "pen"
                            ? "2px solid #6ecf9a"
                            : "2px solid #444",
                        cursor: editable ? "pointer" : "default",
                      }}
                      title={`Color ${col}`}
                    />
                  )
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 6,
                  opacity: editable ? 1 : 0.4,
                }}
              >
                <button
                  onClick={() => {
                    if (!editable) return;
                    setTool("pen");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    background:
                      tool === "pen" && editable ? "#3a6" : "#2a2a2a",
                    border:
                      tool === "pen" && editable
                        ? "1px solid #6ecf9a"
                        : "1px solid #444",
                    color: "#fff",
                    fontSize: 12,
                    lineHeight: 1.2,
                    cursor: editable ? "pointer" : "default",
                    minWidth: 60,
                  }}
                >
                  Pen
                </button>

                <button
                  onClick={() => {
                    if (!editable) return;
                    setTool("eraser");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    background:
                      tool === "eraser" && editable ? "#3a6" : "#2a2a2a",
                    border:
                      tool === "eraser" && editable
                        ? "1px solid #6ecf9a"
                        : "1px solid #444",
                    color: "#fff",
                    fontSize: 12,
                    lineHeight: 1.2,
                    cursor: editable ? "pointer" : "default",
                    minWidth: 60,
                  }}
                >
                  Eraser
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#fff",
                  opacity: editable ? 1 : 0.4,
                }}
                title="Brush size"
              >
                <span style={{ fontSize: 11 }}>Size</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={strokeSize}
                  onChange={(e) => {
                    if (!editable) return;
                    const v = parseInt(e.target.value, 10);
                    setStrokeSize(v);
                  }}
                  style={{
                    width: 80,
                    cursor: editable ? "pointer" : "default",
                  }}
                />
                <span
                  style={{
                    minWidth: 24,
                    textAlign: "right",
                    fontSize: 11,
                    opacity: 0.8,
                  }}
                >
                  {strokeSize}
                </span>
              </div>

              <button
                onClick={async () => {
                  if (!editable) return;
                  await clearViewedBoard();
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: editable ? "#a33" : "#2a2a2a",
                  border: editable
                    ? "1px solid #ff8b8b"
                    : "1px solid #444",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: 1.2,
                  cursor: editable ? "pointer" : "default",
                  minWidth: 70,
                }}
              >
                Clear all
              </button>
            </div>
          </div>

          <div
            ref={wbContainerRef}
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              minWidth: 0,
              position: "relative",
              backgroundColor: "#111",
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                touchAction: "none",
                cursor: editable
                  ? tool === "eraser"
                    ? "cell"
                    : "crosshair"
                  : "default",
              }}
              onPointerDown={startDraw}
              onPointerMove={moveDraw}
              onPointerUp={endDraw}
              onPointerLeave={endDraw}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 24,
          bottom: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          color: "#fff",
          zIndex: 10,
        }}
      >
        {lockedRole !== "admin" && !camOn && (
          <button
            onClick={turnCameraOn}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.2,
              minWidth: 120,
              textAlign: "left",
            }}
          >
            Turn Camera On
          </button>
        )}

        {lockedRole !== "admin" && !micOn && (
          <button
            onClick={turnMicOn}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.2,
              minWidth: 120,
              textAlign: "left",
            }}
          >
            Mic On
          </button>
        )}
      </div>
    </main>
  );
}
