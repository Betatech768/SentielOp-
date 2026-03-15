import { useState, useRef, useEffect } from "react";
import { useVoiceChat } from "./components/VoiceChat";

const API_BASE = "http://localhost:8000";

// Type definitions for better type safety
type RiskLevel = "LOW" | "MODERATE" | "HIGH";

interface Message {
  sender: "AI" | "Patient";
  text: string;
  time: string;
  image: string | null;
}

interface FlaggedItem {
  time: string;
  note: string;
  severity: "high" | "moderate";
}

interface Vitals {
  temperature: number | null;
  heart_rate: number | null;
  pain_score: number | null;
  recorded_at: string | null;
}

interface RiskConfigItem {
  color: string;
  bg: string;
  border: string;
  dot: string;
  label: string;
}

type RiskConfig = Record<RiskLevel, RiskConfigItem>;

interface SymptomKeyword {
  keyword: string;
  severity: "high" | "moderate";
}

interface VitalsResponse {
  temperature?: number;
  heart_rate?: number;
  pain_score?: number;
  recorded_at?: string;
  days_post_op?: number;
  risk_level?: RiskLevel;
}

interface CheckinResponse {
  risk_level?: RiskLevel;
  assessment: string;
  recommendations?: string[];
}

interface HistoryCheckin {
  symptoms?: string;
  s3_key?: string;
  created_at: string;
  assessment?: string;
  recommendations?: string[];
  risk_level: RiskLevel;
}

/**
 * Main application component for the PostOp Sentinel patient interface.
 * 
 * This component manages the entire patient check-in experience, including:
 * - Chat conversation with AI assistant
 * - Voice recording and transcription
 * - Image uploads for wound photos
 * - Risk level monitoring and symptom flagging
 * - Patient vitals display
 * - Emergency alert handling
 * 
 * The app communicates with a backend API for check-ins, vitals, and voice processing.
 */
function App() {
   // Input and file handling state
  const [input,               setInput]               = useState<string>("");
  const [selectedFile,        setSelectedFile]        = useState<File | null>(null);
  const [isTyping,            setIsTyping]            = useState<boolean>(false);
  const [imagePreview,        setImagePreview]        = useState<string | null>(null);
  const [sending,             setSending]             = useState<boolean>(false);
  const [sendHovered,         setSendHovered]         = useState<boolean>(false);
  const [imgHovered,          setImgHovered]          = useState<boolean>(false);
  const [riskLevel,           setRiskLevel]           = useState<RiskLevel>("LOW");
  const [flagged,             setFlagged]             = useState<FlaggedItem[]>([]);
  const [showEmergencyBanner, setShowEmergencyBanner] = useState<boolean>(false);
  const [showImageConfirm,    setShowImageConfirm]    = useState<boolean>(false);
  const [daysPostOp,          setDaysPostOp]          = useState<number>(6);
  const [vitals,              setVitals]              = useState<Vitals>({
    temperature: null, heart_rate: null, pain_score: null, recorded_at: null,
  });

  
  // Patient-specific constants (would typically come from authentication/API in production)
  function scheduleCheckin(hours:number) {
  let nextCheckinTime = null
  if(riskLevel === "HIGH") {
   nextCheckinTime = new Date(Date.now() + 4 * 60 * 60 * 1000).toLocaleString(); 
  }else{
    nextCheckinTime = new Date(Date.now() + hours * 60 * 60 * 1000).toLocaleString();
  }
  return nextCheckinTime;}

const currentTime = new Date().toLocaleTimeString([], {
  hour: "numeric",
  minute: "2-digit",
  hour12: true
});

  // Example patient data - in a real app, this would be dynamically loaded based on authentication/session
  const name        = "John Doe";
  const patientId   = "PT-2024-0892";
  const surgeryDate = "28 Feb 2026";
  const surgeryType = "Right Knee Arthroplasty";
  const nextCheckin = scheduleCheckin(4);

  // State for chat messages (patient and AI responses)
  const [messages, setMessages] = useState<Message[]>([{
    sender: "AI",
    text: `Hello ${name}. I'm PostOp Sentinel, your recovery assistant. Whenever you're ready, press the microphone button and we'll begin your check-in — just speak naturally.`,
    time: currentTime, image: null,
  }]);

 
  // Voice chat hook for microphone access and real-time transcription
  const { start, stop, isLive, error, alert, clearAlert } = useVoiceChat(
    patientId,
    (msg) => setMessages((prev) => [...prev, msg as Message]),
    (risk) => setRiskLevel(risk as RiskLevel),
  );

  // Effect to handle emergency alerts from voice processing
  useEffect(() => {
    if (alert) {
      setRiskLevel("HIGH");
      setShowEmergencyBanner(true);
      setFlagged((prev) => [
        ...prev,
        {
          time: now(),
          note: `⚠️ Alert: ${alert.keyword}`,
          severity: "high",
        },
      ]);
    }
  }, [alert]);

  // Function to fetch and update patient vitals from backend
  const refreshVitals = async () => {
    try {
      const res = await fetch(`${API_BASE}/vitals/${patientId}`);
      if (!res.ok) return;
      const data: VitalsResponse = await res.json();
      setVitals({
        temperature: data.temperature ?? null,
        heart_rate:  data.heart_rate  ?? null,
        pain_score:  data.pain_score  ?? null,
        recorded_at: data.recorded_at ?? null,
      });
      if (data.days_post_op) setDaysPostOp(data.days_post_op);
      if (data.risk_level)   setRiskLevel(data.risk_level);
    } catch { /* non-fatal */ }
  };

  // Effect to initialize patient data and load conversation history on mount
  useEffect(() => {
    const initPatient = async () => {
      try {
        // Register patient with backend (idempotent operation)
        await fetch(`${API_BASE}/patients`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patient_code: patientId, name, surgery_type: surgeryType, surgery_date: "2026-02-28" }),
        });

        // Load current vitals
        await refreshVitals();

        // Load previous check-in history to populate chat and symptom log
        const historyRes = await fetch(`${API_BASE}/check-ins/${patientId}`);
        if (!historyRes.ok) return;
        const history: HistoryCheckin[] = await historyRes.json();
        if (!history.length) return;

        const previousMessage: Message[] = [];
        const previousFlagged: FlaggedItem[]  = [];

        // Process historical check-ins in reverse chronological order
        history.slice().reverse().forEach((checkin) => {
          // Add patient symptoms to chat if present
          // Add patient symptoms to chat if present
          if (checkin.symptoms && checkin.symptoms !== "Patient submitted a wound photo") {
            previousMessage.push({
              sender: "Patient",
              text: checkin.symptoms,
              image: null,
              time: new Date(checkin.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            });
          }
          // Add wound photo message if present
          if (checkin.s3_key && checkin.s3_key !== "no-image") {
            previousMessage.push({
              sender: "Patient",
              text: "",
              image: `${API_BASE}/wound-photo/${checkin.s3_key}`,
              time: new Date(checkin.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            });
          }
          // Add AI assessment to chat
          if (checkin.assessment) {
            previousMessage.push({
              sender: "AI",
              text: checkin.assessment,
              image: null,
              time: new Date(checkin.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            });
          }
          // Add recommendations to symptom log
          if (checkin.recommendations?.length) {
            checkin.recommendations.forEach((rec: string) => {
              previousFlagged.push({
                note: rec, severity: checkin.risk_level === "HIGH" ? "high" : "moderate",
                time: new Date(checkin.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              });
            });
          }
        });

        // Update state with historical data
        if (history.length > 0) setRiskLevel(history[0].risk_level);
        if (previousMessage.length) setMessages((prev) => [...previousMessage, ...prev]);
        if (previousFlagged.length)  setFlagged(previousFlagged);

      } catch { console.warn("Could not load patient history"); }
    };
    initPatient();
  }, []);

  // Refs for DOM elements and scrolling
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef   = useRef<HTMLInputElement | null>(null);

  // Effect to auto-scroll chat to bottom when new messages arrive
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);

  // Utility function to get current time in HH:MM format
  const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Handler for file input changes (image uploads)
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Validate file type and size
    if (!["image/jpeg","image/jpg","image/png","image/webp"].includes(file.type)) { window.alert("Please upload a JPEG or PNG image."); return; }
    if (file.size > 5 * 1024 * 1024) { window.alert("Image must be under 5MB."); return; }
    setImagePreview(URL.createObjectURL(file));
    setSelectedFile(file);
    setShowImageConfirm(true);
  };

  // Main handler for sending messages (text or image)
  const handleSend = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() && !selectedFile) return;
    if (showImageConfirm) return; // Wait for image confirmation

    setSending(true);
    const text    = input.trim();
    const userMsg: Message = { sender: "Patient", text, time: now(), image: imagePreview || null };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setImagePreview(null);
    setSelectedFile(null);
    if (fileRef.current) fileRef.current.value = "";

    // Local symptom flagging based on keywords in text
    const lower = text.toLowerCase();
    // Local symptom flagging based on keywords in text
    const symptomKeywords: SymptomKeyword[] = [
      { keyword: "pain", severity: "moderate" },
      { keyword: "swollen", severity: "moderate" },
      { keyword: "swelling", severity: "moderate" },
      { keyword: "fever", severity: "high" },
      { keyword: "bleed", severity: "high" },
      { keyword: "redness", severity: "moderate" },
      { keyword: "pus", severity: "high" },
      { keyword: "discharge", severity: "high" },
      { keyword: "hot", severity: "moderate" },
      { keyword: "numb", severity: "moderate" },
      { keyword: "tingling", severity: "moderate" },
      { keyword: "severe", severity: "high" },
      { keyword: "emergency", severity: "high" },
    ];

    const matched = symptomKeywords.find(({ keyword }) => lower.includes(keyword));
    if (matched) {
      setRiskLevel((prev: RiskLevel) =>
      matched.severity === "high"
        ? "HIGH"
        : prev === "LOW"
        ? "MODERATE"
        : prev
      );
      setFlagged((prev) => [
      ...prev,
      {
        time: now(),
        note: text.slice(0, 48) + (text.length > 48 ? "…" : ""),
        severity: matched.severity,
      },
      ]);
    }

    setIsTyping(true);
    setSending(false);

    try {
      let s3Key = null;

      // Handle image upload to S3 if present
      if (selectedFile) {
        setFlagged((prev) => [...prev, { time: now(), note: "Wound photo submitted", severity: "moderate" }]);
        // Get presigned URL from backend
        const linkRes = await fetch(`${API_BASE}/get-upload-link`);
        if (!linkRes.ok) throw new Error("Failed to obtain upload URL");
        const { upload_url, fields, s3_key } = await linkRes.json();
        // Build form data and upload directly to S3
        const formData = new FormData();
        Object.entries(fields).forEach(([k, v]) => formData.append(k, v as string));
        formData.append("file", selectedFile);
        const uploadRes = await fetch(upload_url, { method: "POST", body: formData });
        if (!uploadRes.ok) { const err = await uploadRes.text(); console.error("S3 error:", err); throw new Error("Image upload to S3 failed"); }
        s3Key = s3_key;
      }

      // Submit check-in to backend for AI assessment
      const checkinRes = await fetch(`${API_BASE}/submit-checkin`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_id: patientId, s3_key: s3Key ?? "no-image", symptoms: text || "Patient submitted a wound photo", days_post_op: daysPostOp }),
      });

      if (checkinRes.status === 429) throw new Error("busy");
      if (!checkinRes.ok)           throw new Error("Check-in submission failed");

      const result: CheckinResponse = await checkinRes.json();
      if (result.risk_level) setRiskLevel(result.risk_level);
      setIsTyping(false);
      setMessages((prev) => [...prev, { sender: "AI", text: result.assessment, time: now(), image: null }]);
      // Add any recommendations to symptom log
      if (result.recommendations?.length) {
        result.recommendations.forEach((rec: string) => {
          setFlagged((prev) => [...prev, { time: now(), note: rec, severity: result.risk_level === "HIGH" ? "high" : "moderate" }]);
        });
      }
      await refreshVitals();

    } catch (err) {
      console.error("Check-in error:", err);
      setIsTyping(false);
      const isBusy = (err as Error).message === "busy";
      setMessages((prev) => [...prev, {
        sender: "AI", time: now(), image: null,
        text: isBusy
          ? "The AI service is momentarily busy. Please wait 30 seconds and try again."
          : "I'm having trouble reaching the care system. Please try again or contact your care team if symptoms are urgent.",
      }]);
    }
  };

  // Configuration for risk level display styling
  const riskConfig: RiskConfig = {
    LOW:      { color: "text-emerald-400", bg: "bg-emerald-50",  border: "border-emerald-100", dot: "bg-emerald-400", label: "Low Risk"      },
    MODERATE: { color: "text-amber-400",   bg: "bg-amber-50",    border: "border-amber-100",   dot: "bg-amber-400",   label: "Moderate Risk" },
    HIGH:     { color: "text-red-400",     bg: "bg-red-50",      border: "border-red-100",     dot: "bg-red-400",     label: "High Risk"     },
  };
  const risk = riskConfig[riskLevel] ?? riskConfig.LOW;

  // Render chat messages as JSX elements
  const chat = messages.map((message, index) => {
    const isAI = message.sender === "AI";
    return isAI ? (
      // AI message bubble
      <div key={index} className="flex items-end gap-2 max-w-sm" style={{ animation: "fadeSlideUp 0.4s cubic-bezier(0.4,0,0.2,1) both" }}>
        <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0 mb-4">
          <svg width="10" height="10" viewBox="0 0 32 32" fill="none"><path d="M16 2 L28 7 L28 17 C28 23.5 22.5 28.5 16 30 C9.5 28.5 4 23.5 4 17 L4 7 Z" fill="white"/></svg>
        </div>
        <div className="border-b border-stone-100 pb-2 flex-1">
          <p className="text-xs tracking-widest uppercase text-orange-300 mb-0.5">Sentinel</p>
          <p className="text-sm text-stone-400 leading-relaxed">{message.text}</p>
          <p className="text-xs text-stone-200 mt-1">{message.time}</p>
        </div>
      </div>
    ) : (
      // Patient message bubble
      <div key={index} className="flex items-end gap-2 max-w-sm self-end flex-row-reverse" style={{ animation: "fadeSlideUp 0.4s cubic-bezier(0.4,0,0.2,1) both" }}>
        <div className="w-5 h-5 rounded-full border border-stone-200 flex items-center justify-center flex-shrink-0 mb-4">
          <span className="text-xs text-stone-400 font-semibold leading-none">P</span>
        </div>
        <div className="border-b border-stone-100 pb-2">
          <p className="text-xs tracking-widest uppercase text-stone-300 mb-0.5 text-right">You</p>
          {message.image && (
            <div className="mb-1.5 flex justify-end">
              <img src={message.image} alt="wound" className="max-w-40 max-h-32 rounded-lg border border-stone-100 object-cover" />
            </div>
          )}
          {message.text && <p className="text-sm text-stone-500 leading-relaxed text-right">{message.text}</p>}
          <p className="text-xs text-stone-200 mt-1 text-right">{message.time}</p>
        </div>
      </div>
    );
  });

  // Main JSX render for the app UI
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600&family=DM+Sans:wght@300;400;500&display=swap');
        * { font-family: 'DM Sans', sans-serif; }
        .font-display { font-family: 'Cormorant Garamond', serif; }
        @keyframes fadeSlideDown  { from{opacity:0;transform:translateY(-16px);}to{opacity:1;transform:translateY(0);} }
        @keyframes fadeSlideUp    { from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);} }
        @keyframes fadeSlideLeft  { from{opacity:0;transform:translateX(-18px);}to{opacity:1;transform:translateX(0);} }
        @keyframes fadeSlideRight { from{opacity:0;transform:translateX(18px);}to{opacity:1;transform:translateX(0);} }
        @keyframes letterSpacingExpand { from{letter-spacing:0.4em;opacity:0;}to{letter-spacing:normal;opacity:1;} }
        @keyframes drawLine    { from{width:0%;}to{width:100%;} }
        @keyframes pulse-dot   { 0%,100%{opacity:1;}50%{opacity:0.3;} }
        @keyframes pop         { 0%{transform:scale(1);}40%{transform:scale(.88);}70%{transform:scale(1.1);}100%{transform:scale(1);} }
        @keyframes shimmer     { 0%{opacity:.6;}50%{opacity:1;}100%{opacity:.6;} }
        @keyframes previewIn   { from{opacity:0;transform:translateY(6px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);} }
        @keyframes flagIn      { from{opacity:0;transform:translateX(10px);}to{opacity:1;transform:translateX(0);} }
        @keyframes bannerIn    { from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);} }
        @keyframes micPulse    { 0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4);}70%{box-shadow:0 0 0 8px rgba(239,68,68,0);} }
        .animate-header-logo  { animation: fadeSlideDown 0.7s cubic-bezier(0.4,0,0.2,1) both; }
        .animate-header-title { animation: letterSpacingExpand 0.9s cubic-bezier(0.4,0,0.2,1) 0.2s both; }
        .animate-header-line  { animation: drawLine 0.8s cubic-bezier(0.4,0,0.2,1) 0.6s both; }
        .animate-left  { animation: fadeSlideLeft  0.7s cubic-bezier(0.4,0,0.2,1) 0.8s both; }
        .animate-chat  { animation: fadeSlideUp    0.6s cubic-bezier(0.4,0,0.2,1) 1.0s both; }
        .animate-right { animation: fadeSlideRight 0.7s cubic-bezier(0.4,0,0.2,1) 0.8s both; }
        .animate-input { animation: fadeSlideUp    0.6s cubic-bezier(0.4,0,0.2,1) 1.2s both; }
        .typing-dot { animation: pulse-dot 1.2s ease-in-out infinite; }
        .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        .btn-send-pop { animation: pop 0.3s cubic-bezier(0.4,0,0.2,1) both; }
        .btn-shimmer  { animation: shimmer 1.5s ease-in-out infinite; }
        .preview-in   { animation: previewIn 0.35s cubic-bezier(0.4,0,0.2,1) both; }
        .flag-in      { animation: flagIn 0.3s cubic-bezier(0.4,0,0.2,1) both; }
        .banner-in    { animation: bannerIn 0.4s cubic-bezier(0.4,0,0.2,1) both; }
        .mic-pulse    { animation: micPulse 1.5s ease-in-out infinite; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        .img-btn  { transition: color 0.2s, transform 0.2s; }
        .img-btn:hover  { transform: scale(1.18) rotate(-6deg); }
        .img-btn:active { transform: scale(0.9); }
        .send-btn { transition: color 0.2s, transform 0.2s, letter-spacing 0.2s; }
        .send-btn:hover  { letter-spacing: 0.2em; }
        .send-btn:active { transform: scale(0.93); }
        .action-btn { transition: color 0.2s, border-color 0.2s, transform 0.15s; }
        .action-btn:hover  { transform: translateY(-1px); }
        .action-btn:active { transform: translateY(0px); }
        .mic-btn { transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
      `}</style>

      <div className="h-screen flex flex-col overflow-hidden">

        {/* Emergency alert banner - shown when voice processing detects urgent keywords */}
        {showEmergencyBanner && (
          <div className="banner-in flex-shrink-0 bg-red-50 border-b border-red-200 px-6 py-3 flex items-center gap-3">
            <span className="text-red-400 text-lg">🚨</span>
            <p className="text-xs text-red-500 font-semibold tracking-wider flex-1">
              Emergency keyword detected — please contact your care team or call emergency services immediately.
            </p>
            <button onClick={() => { setShowEmergencyBanner(false); clearAlert(); }} className="text-xs text-red-300 hover:text-red-400 tracking-widest uppercase">Dismiss</button>
          </div>
        )}

        {/* App header with logo and title */}
        <header className="flex-shrink-0 flex flex-col items-center justify-center pt-6 pb-4 w-full border-b border-stone-100">
          <div className="flex justify-center items-center gap-2.5">
            <div className="animate-header-logo"><img src="/favicon.png" alt="PostOp Sentinel Logo" className="w-8 h-8" /></div>
            <h1 className="font-display text-4xl font-semibold text-orange-500 animate-header-title">PostOp Sentinel</h1>
          </div>
          <p className="font-display text-xs tracking-[0.25em] uppercase text-stone-300 mt-1 animate-header-title">Intelligent Post-Operative Care</p>
          <div className="mt-3 h-px bg-gradient-to-r from-transparent via-orange-200 to-transparent animate-header-line" />
        </header>

        <div className="flex-1 flex overflow-hidden">

          {/* LEFT PANEL */}
          <aside className="animate-left w-64 flex-shrink-0 border-r border-stone-100 flex flex-col overflow-y-auto scrollbar-hide px-5 py-5 gap-6">

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">Patient</p>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-full border border-stone-200 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm text-stone-400 font-semibold">JD</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-stone-600">{name}</p>
                  <p className="text-xs text-stone-300 tracking-wider">{patientId}</p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {[{ label: "Surgery", value: surgeryType }, { label: "Date", value: surgeryDate }, { label: "Next check-in", value: nextCheckin }].map(({ label, value }) => (
                  <div key={label} className="flex flex-col border-b border-stone-50 pb-2">
                    <span className="text-xs tracking-widest uppercase text-stone-300">{label}</span>
                    <span className="text-xs text-stone-500 mt-0.5">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-2">Post-op day</p>
              <div className="flex items-end gap-1.5">
                <span className="font-display text-5xl font-semibold text-orange-400 leading-none">{daysPostOp}</span>
                <span className="text-xs text-stone-300 mb-1">/ 14 target</span>
              </div>
              <div className="mt-2 h-1 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-orange-300 rounded-full transition-all duration-700" style={{ width: `${Math.min((daysPostOp / 14) * 100, 100)}%` }} />
              </div>
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-2">Risk level</p>
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${risk.bg} ${risk.border} transition-all duration-500`}>
                <span className={`w-2 h-2 rounded-full ${risk.dot} typing-dot`} />
                <span className={`text-xs font-semibold tracking-wider uppercase ${risk.color}`}>{risk.label}</span>
              </div>
              {isLive && <p className="text-xs text-stone-200 tracking-wider mt-1.5 text-center">updating live from session</p>}
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">
                Last Recorded Vitals
                {vitals.recorded_at && (
                  <span className="ml-1 normal-case font-normal text-stone-200">
                    · {new Date(vitals.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </p>
              <div className="flex flex-col gap-2">
                {[
                  { label: "Temperature", value: vitals.temperature !== null ? `${vitals.temperature}°C` : "Not recorded", ok: vitals.temperature !== null ? vitals.temperature < 38.0 : true },
                  { label: "Heart rate",  value: vitals.heart_rate  !== null ? `${vitals.heart_rate} bpm` : "Not recorded", ok: vitals.heart_rate  !== null ? vitals.heart_rate  < 100  : true },
                  { label: "Pain score",  value: vitals.pain_score  !== null ? `${vitals.pain_score} / 10` : "Not recorded", ok: vitals.pain_score !== null ? vitals.pain_score   < 5    : true },
                ].map(({ label, value, ok }) => (
                  <div key={label} className="flex items-center justify-between border-b border-stone-50 pb-1.5">
                    <span className="text-xs text-stone-300">{label}</span>
                    <span className={`text-xs font-medium ${value === "Not recorded" ? "text-stone-200 italic" : ok ? "text-stone-400" : "text-amber-400"}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>

          </aside>

          {/* CENTRE CHAT */}
          <div className="flex-1 flex flex-col overflow-hidden border-r border-stone-100">

            <div className="flex-shrink-0 px-6 py-1.5 flex items-center gap-1.5 border-b border-stone-100">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" opacity="0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <p className="text-xs text-stone-300 tracking-wider">End-to-end encrypted · HIPAA compliant · Messages logged to care record</p>
              <div className="ml-auto flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-red-400" : "bg-emerald-400"} typing-dot`} />
                <span className="text-xs text-stone-300 tracking-wider uppercase">{isLive ? "Recording" : "Live"}</span>
              </div>
            </div>

            {!isLive && messages.length <= 1 && (
              <div className="flex-shrink-0 mx-6 mt-4 px-4 py-3 rounded-xl border border-orange-100 bg-orange-50 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="1.5">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-semibold text-orange-500 tracking-wider">Voice check-in ready</p>
                  <p className="text-xs text-orange-400 mt-0.5">Press the microphone button below to start speaking with Sentinel</p>
                </div>
              </div>
            )}

            <div className="animate-chat flex-1 overflow-y-auto scrollbar-hide px-6 py-5 flex flex-col gap-5">
              {chat}
              {isTyping && (
                <div className="flex items-end gap-2 max-w-sm">
                  <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0">
                    <svg width="10" height="10" viewBox="0 0 32 32" fill="none"><path d="M16 2 L28 7 L28 17 C28 23.5 22.5 28.5 16 30 C9.5 28.5 4 23.5 4 17 L4 7 Z" fill="white"/></svg>
                  </div>
                  <div className="pb-2 flex items-center gap-1 pl-1">
                    <span className="w-1 h-1 rounded-full bg-stone-300 typing-dot" />
                    <span className="w-1 h-1 rounded-full bg-stone-300 typing-dot" />
                    <span className="w-1 h-1 rounded-full bg-stone-300 typing-dot" />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {showImageConfirm && imagePreview && (
              <div className="mx-6 mb-2 px-4 py-3 rounded-xl border border-amber-100 bg-amber-50 flex items-center gap-3 flex-shrink-0">
                <span className="text-amber-400 text-lg flex-shrink-0">📸</span>
                <div className="flex-1">
                  <p className="text-xs font-semibold text-amber-600 tracking-wider">Is this your knee wound site?</p>
                  <p className="text-xs text-amber-500 mt-0.5">Please confirm this photo shows your right knee incision before sending.</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => setShowImageConfirm(false)} className="text-xs px-3 py-1.5 rounded-lg bg-amber-400 text-white font-semibold hover:bg-amber-500 transition-colors">Yes, it is</button>
                  <button onClick={() => { setImagePreview(null); setSelectedFile(null); setShowImageConfirm(false); if (fileRef.current) fileRef.current.value = ""; }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-amber-200 text-amber-500 hover:bg-amber-100 transition-colors">Wrong photo</button>
                </div>
              </div>
            )}

            {imagePreview && !showImageConfirm && (
              <div className="preview-in px-6 pb-2 flex items-end gap-2 flex-shrink-0">
                <div className="relative inline-block">
                  <img src={imagePreview} alt="preview" className="h-20 w-20 object-cover rounded-xl border border-stone-100 shadow-sm" />
                  <button type="button" onClick={() => { setImagePreview(null); setSelectedFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-stone-400 text-white flex items-center justify-center hover:bg-red-400 transition-colors" style={{ fontSize: "9px", lineHeight: 1 }}>✕</button>
                </div>
                <p className="text-xs text-stone-300 tracking-wider pb-1">Ready to send</p>
              </div>
            )}

            <div className="animate-input flex-shrink-0 px-6 py-3 border-t border-stone-100">
              <p className="text-xs text-stone-200 tracking-wider text-center mb-2">Not a substitute for professional medical advice · Contact your care team for emergencies</p>
              <form onSubmit={handleSend} className="flex items-center gap-1.5">

                <label className={`img-btn cursor-pointer p-2 flex-shrink-0 ${imgHovered ? "text-orange-400" : "text-stone-200"}`} onMouseEnter={() => setImgHovered(true)} onMouseLeave={() => setImgHovered(false)}>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </label>

                <button type="button" onClick={isLive ? stop : start}
                  className={`mic-btn p-2 rounded-full flex-shrink-0 flex items-center justify-center ${isLive ? "bg-red-50 text-red-400 mic-pulse" : "text-stone-300 hover:text-orange-500 hover:bg-orange-50"}`}
                  title={isLive ? "Stop voice check-in" : "Start voice check-in"}>
                  {isLive ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  )}
                </button>

                {isLive && <span className="text-xs text-red-300 tracking-widest uppercase flex-shrink-0">Recording…</span>}
                {error && !isLive && <p className="text-xs text-red-300 tracking-wider px-1 flex-shrink-0">{error}</p>}

                <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                  placeholder={isLive ? "Listening…" : "Or type your symptoms here…"} disabled={isLive}
                  className="flex-1 border-b border-stone-100 bg-transparent px-2 py-1.5 text-sm text-stone-500 placeholder-stone-200 focus:outline-none focus:border-orange-200 transition-colors disabled:opacity-40" />

                {!isLive && (
                  <button type="submit" disabled={(!input.trim() && !imagePreview) || showImageConfirm}
                    onMouseEnter={() => setSendHovered(true)} onMouseLeave={() => setSendHovered(false)}
                    className={`send-btn px-4 py-1.5 text-xs tracking-widest uppercase font-semibold flex-shrink-0 disabled:opacity-20 disabled:cursor-not-allowed ${sending ? "btn-send-pop" : ""} ${sendHovered && !sending ? "text-orange-500" : "text-orange-400"}`}>
                    {sending ? <span className="btn-shimmer">Sending…</span> : "Send"}
                  </button>
                )}
              </form>
            </div>
          </div>

          {/* RIGHT PANEL */}
          <aside className="animate-right w-64 flex-shrink-0 flex flex-col overflow-y-auto scrollbar-hide px-5 py-5 gap-6">

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">Symptom Log</p>
              <div className="flex flex-col gap-2">
                {flagged.length === 0 && <p className="text-xs text-stone-200 italic">No symptoms flagged yet.</p>}
                {flagged.map((f, i) => (
                  <div key={i} className="flag-in flex gap-2 items-start border-b border-stone-50 pb-2">
                    <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${f.severity === "high" ? "bg-red-400" : "bg-amber-400"}`} />
                    <div><p className="text-xs text-stone-400 leading-snug">{f.note}</p><p className="text-xs text-stone-200 mt-0.5">{f.time}</p></div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">Session</p>
              <div className="flex flex-col gap-2">
                {[{ label: "Messages", value: messages.length }, { label: "Started", value: "09:00" }, { label: "Voice mode", value: isLive ? "Active" : "Standby" }].map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between border-b border-stone-50 pb-1.5">
                    <span className="text-xs text-stone-300">{label}</span>
                    <span className={`text-xs font-medium ${label === "Voice mode" && isLive ? "text-red-400" : "text-stone-400"}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">Quick Actions</p>
              <div className="flex flex-col gap-2">
                {[{ label: "Request Callback", icon: "📞" }, { label: "Download Report", icon: "📄" }, { label: "Message Care Team", icon: "💬" }, { label: "Emergency Contact", icon: "🚨" }].map(({ label, icon }) => (
                  <button key={label} className="action-btn w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg border border-stone-100 hover:border-orange-200 hover:text-orange-400 text-stone-400 transition-colors">
                    <span className="text-sm">{icon}</span><span className="text-xs tracking-wide">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs tracking-widest uppercase text-stone-300 mb-3">Care Team</p>
              <div className="flex flex-col gap-2.5">
                {[{ name: "Dr. A. Mensah", role: "Surgeon", initials: "AM" }, { name: "Nurse K. Osei", role: "Recovery Nurse", initials: "KO" }].map(({ name: n, role, initials }) => (
                  <div key={n} className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full border border-stone-200 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs text-stone-400 font-semibold">{initials}</span>
                    </div>
                    <div><p className="text-xs font-medium text-stone-500">{n}</p><p className="text-xs text-stone-300">{role}</p></div>
                  </div>
                ))}
              </div>
            </div>

          </aside>
        </div>
      </div>
    </>
  );
}

export default App;