import { useRef, useState, useCallback } from "react";

export type MessageEntry = {
  sender: "AI" | "Patient";
  text:   string;
  time:   string;
  image:  null;
};

export type AlertEntry = {
  keyword: string;
  message: string;
};

type VoiceHookResult = {
  start:      () => Promise<void>;
  stop:       () => void;
  isLive:     boolean;
  error:      string | null;
  alert:      AlertEntry | null;
  clearAlert: () => void;
};

const now = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ── Audio queue — plays LPCM chunks in order without overlap ─────────────────
class AudioQueue {
  private ctx:     AudioContext;
  private queue:   ArrayBuffer[] = [];
  private playing  = false;
  private nextTime = 0;          // scheduled time for next chunk

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  enqueue(pcmBuffer: ArrayBuffer) {
    this.queue.push(pcmBuffer);
    if (!this.playing) this.playNext();
  }

  private async playNext() {
    if (this.queue.length === 0) { this.playing = false; return; }
    this.playing = true;

    const raw = this.queue.shift()!;

    try {
      // Nova Sonic returns 24kHz 16-bit signed PCM — decode manually
      const int16 = new Int16Array(raw);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const audioBuffer = this.ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      const src = this.ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.ctx.destination);

      // Schedule back-to-back to avoid gaps
      const startAt = Math.max(this.ctx.currentTime, this.nextTime);
      src.start(startAt);
      this.nextTime = startAt + audioBuffer.duration;

      src.onended = () => this.playNext();
    } catch {
      this.playNext();
    }
  }

  clear() {
    this.queue   = [];
    this.playing = false;
    this.nextTime = 0;
  }
}

// ── AudioWorklet processor source (inlined as a Blob URL) ───────────────────
// Captures raw 16-bit PCM from the microphone at 16kHz and posts it
// back to the main thread as an ArrayBuffer.
const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    // Convert float32 → int16
    const int16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function makeWorkletURL(): string {
  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

// ══════════════════════════════════════════════════════════════════════════════
// useVoiceChat hook
// ══════════════════════════════════════════════════════════════════════════════
export function useVoiceChat(
  patientId:    string,
  onTranscript: (msg: MessageEntry) => void,
  onRiskUpdate?: (risk: string) => void,
): VoiceHookResult {

  const wsRef         = useRef<WebSocket | null>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  const workletRef    = useRef<AudioWorkletNode | null>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const workletUrlRef = useRef<string | null>(null);

  const [isLive, setIsLive] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [alert,  setAlert]  = useState<AlertEntry | null>(null);

  const start = useCallback(async () => {
    try {
      setError(null);
      setAlert(null);

      // ── 1. AudioContext at 16kHz for capture, 24kHz for playback ─────────
      //    We create one context at 16kHz (mic sample rate Nova Sonic wants).
      //    Playback is handled by manually decoding at 24kHz inside AudioQueue.
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current  = audioCtx;
      audioQueueRef.current = new AudioQueue(
        // Playback context at 24kHz — separate from capture
        new AudioContext({ sampleRate: 24000 })
      );

      // ── 2. Load PCM worklet ───────────────────────────────────────────────
      const workletUrl = makeWorkletURL();
      workletUrlRef.current = workletUrl;
      await audioCtx.audioWorklet.addModule(workletUrl);

      // ── 3. Open microphone ────────────────────────────────────────────────
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate:       16000,
          channelCount:     1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // ── 4. Open WebSocket to FastAPI ──────────────────────────────────────
      const ws = new WebSocket(
        `ws://localhost:8000/voice-checkin?patient_id=${patientId}`
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setIsLive(true);
        console.log("✅ Voice session open");
      };

      ws.onmessage = async (event) => {
        // Binary = raw PCM audio from Nova Sonic → enqueue for playback
        if (event.data instanceof ArrayBuffer) {
          audioQueueRef.current?.enqueue(event.data);
          return;
        }

        // JSON = transcript / alert / error
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "transcript") {
            onTranscript({
              sender: msg.role === "USER" ? "Patient" : "AI",
              text:   msg.text,
              time:   now(),
              image:  null,
            });
          } else if (msg.type === "alert") {
            setAlert({ keyword: msg.keyword, message: msg.message });
            onTranscript({
              sender: "AI",
              text:   `⚠️ ${msg.message}`,
              time:   now(),
              image:  null,
            });
          } else if (msg.type === "error") {
            setError(msg.message);
          }
        } catch {
          // Not JSON — ignore
        }
      };

      ws.onerror = () => {
        setError("Voice connection failed. Check that the backend is running on port 8000.");
      };

      ws.onclose = () => {
        setIsLive(false);
        console.log("Voice session closed");
      };

      // ── 5. Wire AudioWorklet → WebSocket ──────────────────────────────────
      //    Worklet posts raw Int16 PCM chunks; we forward them as binary
      //    over the WebSocket. The backend base64-encodes before sending
      //    to Nova Sonic, so we just send the raw buffer here.
      const source  = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
      workletRef.current = worklet;

      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      source.connect(worklet);
      // worklet output not connected to destination — we only want the side-effect

      // ── 6. Poll /session-risk every 8s ────────────────────────────────────
      if (onRiskUpdate) {
        pollRef.current = setInterval(async () => {
          try {
            const res  = await fetch(
              `http://localhost:8000/session-risk/${patientId}`
            );
            const data = await res.json();
            if (data.risk_level) onRiskUpdate(data.risk_level);
          } catch { /* non-fatal */ }
        }, 8000);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      setError(msg);
      console.error("Failed to start voice session:", err);
    }
  }, [patientId, onTranscript, onRiskUpdate]);

  const stop = useCallback(() => {
    workletRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    wsRef.current?.close();
    audioCtxRef.current?.close();
    audioQueueRef.current?.clear();
    if (pollRef.current) clearInterval(pollRef.current);
    if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current);
    setIsLive(false);
  }, []);

  const clearAlert = useCallback(() => setAlert(null), []);

  return { start, stop, isLive, error, alert, clearAlert };
}