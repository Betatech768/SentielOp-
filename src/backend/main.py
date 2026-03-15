from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import boto3
import os
import json
import asyncio
from datetime import datetime
import uuid
from botocore.exceptions import ClientError
from botocore.config import Config as BotoConfig
from openai import OpenAI
import time
import random
import logging
import base64
from dotenv import load_dotenv

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

# ── Database ──────────────────────────────────────────────────────────────────
from database import get_db, init_db, AsyncSessionLocal
from models import Patient, CheckIn, Vital, VoiceSession, Transcript

# ── Nova Sonic SDK ────────────────────────────────────────────────────────────
from aws_sdk_bedrock_runtime.client import (
    BedrockRuntimeClient,
    InvokeModelWithBidirectionalStreamOperationInput,
)
from aws_sdk_bedrock_runtime.models import (
    InvokeModelWithBidirectionalStreamInputChunk,
    BidirectionalInputPayloadPart,
)
from aws_sdk_bedrock_runtime.config import Config
from smithy_aws_core.identity.environment import EnvironmentCredentialsResolver

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="PostOp Sentinel API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── AWS config ────────────────────────────────────────────────────────────────
AWS_REGION       = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET_NAME   = os.getenv("S3_BUCKET_NAME")
AWS_NOVA_API_KEY = os.getenv("AWS_NOVA_API_KEY")

# S3 client — your working config kept exactly as-is
s3_client = boto3.client(
    "s3",
    region_name="us-east-1",
    config=BotoConfig(signature_version="s3v4")
)

# Bedrock boto3 client — used for background risk analysis
bedrock_client = boto3.client("bedrock-runtime", region_name=AWS_REGION)

# Nova Sonic client factory
def _make_sonic_client() -> BedrockRuntimeClient:
    config = Config(
        endpoint_uri=f"https://bedrock-runtime.{AWS_REGION}.amazonaws.com",
        region=AWS_REGION,
        aws_credentials_identity_resolver=EnvironmentCredentialsResolver(),
    )
    return BedrockRuntimeClient(config=config)

# ── Model IDs — your versions kept exactly ───────────────────────────────────
NOVA_SONIC_MODEL = "amazon.nova-2-sonic-v1:0"
NOVA_LITE_MODEL  = "amazon.nova-2-lite-v1:0"
NOVA_AGENT_ID    = "AGENT-84f5330fada14b549fb17171457598cc"


# ── Pydantic schemas ──────────────────────────────────────────────────────────
class CheckinRequest(BaseModel):
    patient_id:   str
    s3_key:       str
    symptoms:     str
    days_post_op: int

class CheckinResponse(BaseModel):
    risk_level:      str
    assessment:      str
    recommendations: list[str]
    timestamp:       str

class PatientCreate(BaseModel):
    patient_code: str
    name:         str
    surgery_type: str
    surgery_date: str | None = None

class VitalCreate(BaseModel):
    patient_code: str
    temperature:  float | None = None
    heart_rate:   int   | None = None
    pain_score:   int   | None = None


# ── Conversation Manager ──────────────────────────────────────────────────────
class ConversationManager:
    def __init__(self):
        self.sessions: dict[str, dict] = {}

    def get_or_create(self, patient_id: str) -> dict:
        if patient_id not in self.sessions:
            self.sessions[patient_id] = {
                "transcript":  [],
                "risk_level":  "LOW",
                "started_at":  datetime.utcnow().isoformat(),
            }
        return self.sessions[patient_id]

    def append(self, patient_id: str, role: str, text: str):
        self.get_or_create(patient_id)["transcript"].append(
            {"role": role, "text": text}
        )

    def get_context(self, patient_id: str, last_n: int = 10) -> str:
        session = self.get_or_create(patient_id)
        return "\n".join(
            f"{t['role']}: {t['text']}"
            for t in session["transcript"][-last_n:]
        )

    def set_risk(self, patient_id: str, risk: str):
        self.get_or_create(patient_id)["risk_level"] = risk

    def get_risk(self, patient_id: str) -> str:
        return self.get_or_create(patient_id).get("risk_level", "LOW")


conversation_manager = ConversationManager()

ALERT_KEYWORDS = [
    "chest pain", "can't breathe", "cannot breathe",
    "heavy bleeding", "passed out", "severe pain", "emergency",
]

def build_system_prompt(patient_id: str, context: str) -> str:
    return (
        f"You are PostOp Sentinel, a compassionate clinical post-operative care assistant. "
        f"Patient ID: {patient_id}. "
        "This is a real-time voice conversation — keep all responses brief, warm, and clear. "
        "Your goals: check pain level 1-10, ask about wound appearance, fever, and mobility. "
        "If the patient mentions chest pain, heavy bleeding, or severe breathing difficulty, "
        "immediately tell them to call emergency services. "
        "Speak in short sentences. Never use bullet points. "
        f"Recent context:\n{context if context else 'Start of session.'}"
    )

def build_prompt(patient_id, days_post_op, symptoms, context, risk, has_image):
    image_instruction = (
        """A wound image has been shared.

STEP 1 — Verify the image FIRST before anything else:
- Does it show a surgical incision, stitches, staples, or the operated area?
- For a knee arthroplasty patient, it should show the knee area specifically.
- If it shows an arm, face, random object, or anything unrelated to a knee surgical site → 
  do NOT assess it. Tell the patient clearly and warmly that this doesn't look like 
  the knee wound site, and ask them to reshare a photo of the actual knee incision.
- If blurry or too dark → ask them to retake in better lighting.
- Only if the image clearly shows the surgical site → proceed with wound assessment."""
        if has_image
        else "No wound image provided. Assess based on symptoms only."
    )

    # Format context clearly so AI knows what's already been said
    formatted_context = ""
    if context:
        formatted_context = f"""
CONVERSATION SO FAR (do NOT repeat or restate any of this):
{context}

The patient's NEW message is below. Respond ONLY to what is new.
Do not reintroduce yourself. Do not repeat previous assessments.
"""
    else:
        formatted_context = "This is the FIRST message in this conversation. Greet the patient warmly."

    return f"""
You are PostOp Sentinel — a warm, compassionate post-operative care assistant.
You speak like a caring nurse having an ongoing conversation with a patient you already know.

Patient ID: {patient_id}
Surgery: Right Knee Arthroplasty
Days since surgery: {days_post_op}
Current risk level: {risk}

{formatted_context}

Patient's new message:
\"\"\"{symptoms}\"\"\"

{image_instruction}

STRICT RULES — read carefully before responding:
- This is a CONVERSATION, not a fresh assessment each time. Treat it like a chat thread.
- NEVER reintroduce yourself if context exists — you already know this patient.
- NEVER repeat information already given in previous turns.
- NEVER say "Hi there!" again if you've already greeted them.
- NEVER give a full re-assessment if you just gave one — only address what's NEW.
- If the patient sends a short message like "ok" or "thanks", reply briefly and naturally.
- If an image is shared, verify it's the correct body part BEFORE commenting on healing.
- Ask only ONE follow-up question per response.
- Speak directly to the patient using "you" and "your".
- Keep it concise — 2-4 sentences is enough for most replies.
- If risk is HIGH or patient mentions emergency symptoms, urge them to contact their care team immediately.

Risk level guidance:
- If image is wrong/unrelated → keep "LOW", note the image issue
- Mild symptoms, good healing → "LOW"  
- Concerning symptoms or image → "MODERATE" or "HIGH"

Reply ONLY with valid JSON (no markdown):

{{
  "risk_level": "LOW"|"MODERATE"|"HIGH",
  "assessment": "Conversational, warm, direct response to what the patient just said. 2-4 sentences max.",
  "recommendations": [
    "Specific actionable step 1",
    "Specific actionable step 2",
    "Specific actionable step 3"
  ]
}}
"""

@app.get("/vitals/{patient_code}")
async def get_latest_vitals(
    patient_code: str,
    db:           AsyncSession = Depends(get_db),
):
    patient = await get_patient_by_code(db, patient_code)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found.")

    # Get the most recent vital record
    result = await db.execute(
        select(Vital)
        .join(CheckIn, Vital.check_in_id == CheckIn.id)
        .where(CheckIn.patient_id == patient.id)
        .order_by(Vital.recorded_at.desc())
        .limit(1)
    )
    vital = result.scalar_one_or_none()

    # Get latest check-in for days_post_op and risk
    checkin_result = await db.execute(
        select(CheckIn)
        .where(CheckIn.patient_id == patient.id)
        .order_by(CheckIn.created_at.desc())
        .limit(1)
    )
    latest_checkin = checkin_result.scalar_one_or_none()

    return {
        "temperature":   vital.temperature  if vital else None,
        "heart_rate":    vital.heart_rate   if vital else None,
        "pain_score":    vital.pain_score   if vital else None,
        "recorded_at":   vital.recorded_at.isoformat() if vital else None,
        "days_post_op":  latest_checkin.days_post_op   if latest_checkin else None,
        "risk_level":    latest_checkin.risk_level      if latest_checkin else "LOW",
    }

def fetch_image_from_s3(s3_key: str):
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET_NAME, Key=s3_key)
        return response["Body"].read()
    except ClientError as e:
        logger.warning("S3 fetch failed: %s", e)
        return None

def run_ai_assessment(content_blocks, model_id=NOVA_AGENT_ID,
                      retries: int = 5, base_delay: float = 2.0):
    """Your working OpenAI-compatible Nova API call with retry logic — unchanged."""
    chat_content = ""
    for block in content_blocks:
        if "text" in block:
            chat_content += block["text"].strip() + "\n"
        elif "image" in block:
            img_bytes = block["image"]["source"]["bytes"]
            b64_str = base64.b64encode(img_bytes).decode("utf-8")
            chat_content += f"[Image: {b64_str[:200]}...]\n"

    for attempt in range(retries):
        try:
            client = OpenAI(
                base_url="https://api.nova.amazon.com/v1",
                api_key=AWS_NOVA_API_KEY,
            )
            response = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": chat_content}],
            )
            return response

        except Exception as e:
            if "ThrottlingException" in str(e) or "429" in str(e):
                wait_time = (2 ** attempt) * base_delay + random.uniform(0, 0.5)
                logger.warning(
                    "Nova busy (Throttling/429), retrying in %.2f sec... (attempt %d/%d)",
                    wait_time, attempt + 1, retries
                )
                time.sleep(wait_time)
                continue
            logger.error("Nova API error: %s", e)
            raise HTTPException(status_code=502, detail="AI assessment unavailable.")

    logger.warning("Nova busy — all retries exhausted")
    raise HTTPException(status_code=429, detail="AI busy — please retry shortly.")

def parse_ai_response(response):
    """Your working response parser — unchanged."""
    try:
        raw = response.choices[0].message.content
        cleaned = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(cleaned)
    except Exception as e:
        logger.error("AI response parsing failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to parse AI assessment.")

# ── DB helper ─────────────────────────────────────────────────────────────────
async def get_patient_by_code(db: AsyncSession, patient_code: str) -> Patient | None:
    result = await db.execute(
        select(Patient).where(Patient.patient_code == patient_code)
    )
    return result.scalar_one_or_none()


# ══════════════════════════════════════════════════════════════════════════════
# STARTUP
# ══════════════════════════════════════════════════════════════════════════════
@app.on_event("startup")
async def startup():
    await init_db()
    logger.info("✅ Database tables ready")


# ══════════════════════════════════════════════════════════════════════════════
# GET /health
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


# ══════════════════════════════════════════════════════════════════════════════
# POST /patients  — register a new patient
# ══════════════════════════════════════════════════════════════════════════════
@app.post("/patients", status_code=201)
async def create_patient(
    payload: PatientCreate,
    db:      AsyncSession = Depends(get_db),
):
    existing = await get_patient_by_code(db, payload.patient_code)
    if existing:
        raise HTTPException(status_code=409, detail="Patient code already exists.")

    surgery_date = None
    if payload.surgery_date:
        try:
            surgery_date = datetime.fromisoformat(payload.surgery_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid surgery_date — use ISO 8601.")

    patient = Patient(
        patient_code= payload.patient_code,
        name=         payload.name,
        surgery_type= payload.surgery_type,
        surgery_date= surgery_date,
    )
    db.add(patient)
    await db.flush()
    await db.refresh(patient)
    logger.info("New patient registered: %s", payload.patient_code)
    return {
        "id":           str(patient.id),
        "patient_code": patient.patient_code,
        "name":         patient.name,
        "surgery_type": patient.surgery_type,
        "created_at":   patient.created_at.isoformat(),
    }


# ══════════════════════════════════════════════════════════════════════════════
# GET /patients/{patient_code}
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/patients/{patient_code}")
async def get_patient(
    patient_code: str,
    db:           AsyncSession = Depends(get_db),
):
    patient = await get_patient_by_code(db, patient_code)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found.")

    result = await db.execute(
        select(CheckIn)
        .where(CheckIn.patient_id == patient.id)
        .order_by(CheckIn.created_at.desc())
        .limit(5)
    )
    check_ins = result.scalars().all()

    return {
        "id":           str(patient.id),
        "patient_code": patient.patient_code,
        "name":         patient.name,
        "surgery_type": patient.surgery_type,
        "surgery_date": patient.surgery_date.isoformat() if patient.surgery_date else None,
        "recent_check_ins": [
            {
                "id":           str(c.id),
                "days_post_op": c.days_post_op,
                "risk_level":   c.risk_level,
                "assessment":   c.assessment,
                "created_at":   c.created_at.isoformat(),
            }
            for c in check_ins
        ],
    }


# ══════════════════════════════════════════════════════════════════════════════
# POST /vitals
# ══════════════════════════════════════════════════════════════════════════════
@app.post("/vitals", status_code=201)
async def record_vitals(
    payload: VitalCreate,
    db:      AsyncSession = Depends(get_db),
):
    patient = await get_patient_by_code(db, payload.patient_code)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found.")

    result = await db.execute(
        select(CheckIn)
        .where(CheckIn.patient_id == patient.id)
        .order_by(CheckIn.created_at.desc())
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    if not latest:
        raise HTTPException(status_code=404, detail="No check-in found to attach vitals to.")

    vital = Vital(
        check_in_id= latest.id,
        temperature= payload.temperature,
        heart_rate=  payload.heart_rate,
        pain_score=  payload.pain_score,
    )
    db.add(vital)
    logger.info("Vitals recorded — patient %s", payload.patient_code)
    return {"status": "recorded", "check_in_id": str(latest.id)}


# ══════════════════════════════════════════════════════════════════════════════
# GET /get-upload-link  — your working presigned_post kept exactly as-is
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/get-upload-link")
async def get_upload_link(content_type: str = "image/jpeg"):
    date_prefix = datetime.utcnow().strftime("%Y/%m/%d")
    ext    = content_type.split("/")[-1]
    s3_key = f"wound-images/{date_prefix}/{uuid.uuid4()}.{ext}"

    try:
        upload = s3_client.generate_presigned_post(
            Bucket=S3_BUCKET_NAME,
            Key=s3_key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, 5242880],
            ],
            ExpiresIn=300,
        )
        return {
            "upload_url": upload["url"],
            "fields":     upload["fields"],
            "s3_key":     s3_key,
        }
    except ClientError as e:
        raise HTTPException(status_code=500, detail="Could not generate upload link")


@app.post("/submit-checkin", response_model=CheckinResponse)
async def submit_checkin(
    payload: CheckinRequest,
    db:      AsyncSession = Depends(get_db),
):
    logger.info("Check-in received — patient %s day %s", payload.patient_id, payload.days_post_op)

    current_risk = conversation_manager.get_risk(payload.patient_id)

    # ── Load DB history + live session context ────────────────────────────────
    db_context   = ""
    patient      = await get_patient_by_code(db, payload.patient_id)

    if patient:
        result = await db.execute(
            select(CheckIn)
            .where(CheckIn.patient_id == patient.id)
            .order_by(CheckIn.created_at.desc())
            .limit(5)
        )
        past_checkins = result.scalars().all()
        if past_checkins:
            lines = [
                f"[Day {c.days_post_op} | {c.risk_level}] "
                f"Symptoms: {c.symptoms} → Assessment: {c.assessment}"
                for c in reversed(past_checkins)  # oldest first
            ]
            db_context = "Previous check-ins from database:\n" + "\n".join(lines)
            # Seed current risk from most recent DB record if session is fresh
            if not conversation_manager.get_context(payload.patient_id):
                current_risk = past_checkins[0].risk_level

    live_context = conversation_manager.get_context(payload.patient_id)
    full_context = f"{db_context}\n\n{live_context}".strip() if db_context else live_context

    # ── Image fetch ───────────────────────────────────────────────────────────
    content_blocks = []
    image_bytes    = None

    if payload.s3_key and payload.s3_key != "no-image":
        image_bytes = fetch_image_from_s3(payload.s3_key)

    if image_bytes:
        if isinstance(image_bytes, str):
            image_bytes = base64.b64decode(image_bytes)
        content_blocks.append({
            "image": {
                "format": "jpeg",
                "source": {"bytes": base64.b64encode(image_bytes)}
            }
        })

    # ── Build prompt with full context ────────────────────────────────────────
    prompt = build_prompt(
        payload.patient_id,
        payload.days_post_op,
        payload.symptoms,
        full_context,          # ← was `context`, now includes DB history
        current_risk,
        bool(image_bytes),
    )
    content_blocks.append({"text": prompt})

    # ── Call Nova ─────────────────────────────────────────────────────────────
    try:
        response = run_ai_assessment(content_blocks)
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error("Check-in failed: %s", e)
        raise HTTPException(status_code=500, detail="Internal server error during AI assessment")

    # ── Parse response ────────────────────────────────────────────────────────
    result = parse_ai_response(response)

    # ── Auto-extract pain score from symptoms and save vitals ─────────────────
    import re

    def extract_pain_score(symptoms: str) -> int | None:
        """Extract pain score if patient mentions it e.g. 'pain is 7/10' or 'pain level 6'"""
        patterns = [
            r'pain\D{0,10}(\d{1,2})\s*(?:/|out of)\s*10',
            r'(\d{1,2})\s*(?:/|out of)\s*10\s*pain',
            r'pain\s+(?:level|score|is|of)\s+(\d{1,2})',
            r'(\d{1,2})\s*\/\s*10',
        ]
        for pattern in patterns:
            match = re.search(pattern, symptoms.lower())
            if match:
                score = int(match.group(1))
                if 0 <= score <= 10:
                    return score
        return None

    # Add this after the check_in is saved to DB:
    if patient:
        pain_score = extract_pain_score(payload.symptoms)
        if pain_score is not None:
            vital = Vital(
                check_in_id=check_in.id,
                pain_score=pain_score,
            )
            db.add(vital)
            await db.flush()
            logger.info("Pain score extracted and saved — patient %s score=%s", payload.patient_id, pain_score)

    # ── Update in-memory session ──────────────────────────────────────────────
    conversation_manager.set_risk(payload.patient_id, result["risk_level"])
    conversation_manager.append(
        payload.patient_id,
        "ASSESSMENT",
        f"[Risk:{result['risk_level']}] {result['assessment']}"
    )

    # ── Persist to Aurora ─────────────────────────────────────────────────────
    if patient:
        check_in = CheckIn(
            patient_id=      patient.id,
            days_post_op=    payload.days_post_op,
            symptoms=        payload.symptoms,
            s3_key=          payload.s3_key if payload.s3_key != "no-image" else None,
            risk_level=      result["risk_level"],
            assessment=      result["assessment"],
            recommendations= json.dumps(result["recommendations"]),
        )
        db.add(check_in)
        await db.flush()
        logger.info("Check-in saved — patient %s risk=%s", payload.patient_id, result["risk_level"])
    else:
        logger.warning("Patient %s not in DB — check-in not persisted", payload.patient_id)

    return CheckinResponse(
        risk_level=      result["risk_level"],
        assessment=      result["assessment"],
        recommendations= result["recommendations"],
        timestamp=       datetime.utcnow().isoformat(),
    )
# ══════════════════════════════════════════════════════════════════════════════
# GET /session-risk/{patient_id}
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/session-risk/{patient_id}")
def get_session_risk(patient_id: str):
    return {
        "patient_id":       patient_id,
        "risk_level":       conversation_manager.get_risk(patient_id),
        "transcript_turns": len(
            conversation_manager.get_or_create(patient_id)["transcript"]
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# GET /check-ins/{patient_code}  — full history from Aurora
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/check-ins/{patient_code}")
async def get_check_in_history(
    patient_code: str,
    db:           AsyncSession = Depends(get_db),
):
    patient = await get_patient_by_code(db, patient_code)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found.")

    result = await db.execute(
        select(CheckIn)
        .where(CheckIn.patient_id == patient.id)
        .order_by(CheckIn.created_at.desc())
    )
    check_ins = result.scalars().all()

    return [
        {
            "id":              str(c.id),
            "days_post_op":    c.days_post_op,
            "symptoms":        c.symptoms,
            "risk_level":      c.risk_level,
            "assessment":      c.assessment,
            "recommendations": json.loads(c.recommendations) if c.recommendations else [],
            "s3_key":          c.s3_key,
            "created_at":      c.created_at.isoformat(),
        }
        for c in check_ins
    ]


# ══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET /voice-checkin  — your working Nova Sonic code + DB persistence
# ══════════════════════════════════════════════════════════════════════════════
@app.websocket("/voice-checkin")
async def voice_checkin(websocket: WebSocket, patient_id: str):
    await websocket.accept()
    logger.info("Voice session started — patient %s", patient_id)

    context            = conversation_manager.get_context(patient_id)
    alerted_keywords:  set[str] = set()
    current_role       = None
    display_text       = False
    prompt_name        = str(uuid.uuid4())
    text_content_name  = str(uuid.uuid4())
    audio_content_name = str(uuid.uuid4())
    sonic_client       = _make_sonic_client()
    stream             = None
    voice_session      = None   # ← NEW: DB record

    try:
        # ── NEW: Create voice session record in Aurora ────────────────────────
        async with AsyncSessionLocal() as db:
            patient = await get_patient_by_code(db, patient_id)
            if patient:
                voice_session = VoiceSession(patient_id=patient.id)
                db.add(voice_session)
                await db.commit()
                await db.refresh(voice_session)
                logger.info("Voice session DB record: %s", voice_session.id)
            else:
                logger.warning("Patient %s not in DB — session not persisted", patient_id)

        # ── Your working Nova Sonic stream — unchanged from here ──────────────
        stream = await sonic_client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=NOVA_SONIC_MODEL)
        )

        async def send(event_dict: dict):
            chunk = InvokeModelWithBidirectionalStreamInputChunk(
                value=BidirectionalInputPayloadPart(
                    bytes_=json.dumps(event_dict).encode("utf-8")
                )
            )
            await stream.input_stream.send(chunk)

        await send({"event": {"sessionStart": {"inferenceConfiguration": {"maxTokens": 1024, "topP": 0.9, "temperature": 0.7}}}})
        await send({"event": {"promptStart": {"promptName": prompt_name, "textOutputConfiguration": {"mediaType": "text/plain"}, "audioOutputConfiguration": {"mediaType": "audio/lpcm", "sampleRateHertz": 24000, "sampleSizeBits": 16, "channelCount": 1, "voiceId": "matthew", "encoding": "base64", "audioType": "SPEECH"}}}})

        system_text = build_system_prompt(patient_id, context)
        await send({"event": {"contentStart": {"promptName": prompt_name, "contentName": text_content_name, "type": "TEXT", "interactive": False, "role": "SYSTEM", "textInputConfiguration": {"mediaType": "text/plain"}}}})
        await send({"event": {"textInput": {"promptName": prompt_name, "contentName": text_content_name, "content": system_text}}})
        await send({"event": {"contentEnd": {"promptName": prompt_name, "contentName": text_content_name}}})
        await send({"event": {"contentStart": {"promptName": prompt_name, "contentName": audio_content_name, "type": "AUDIO", "interactive": True, "role": "USER", "audioInputConfiguration": {"mediaType": "audio/lpcm", "sampleRateHertz": 16000, "sampleSizeBits": 16, "channelCount": 1, "audioType": "SPEECH", "encoding": "base64"}}}})

        # ── NEW: helper to persist each transcript turn ───────────────────────
        async def save_transcript_turn(role: str, text: str):
            if not voice_session:
                return
            try:
                async with AsyncSessionLocal() as db:
                    db.add(Transcript(session_id=voice_session.id, role=role, text=text))
                    await db.commit()
            except Exception as e:
                logger.warning("Transcript save failed (non-fatal): %s", e)

        # ── Your Coroutine A — unchanged ──────────────────────────────────────
        async def browser_to_sonic():
            while True:
                raw_bytes = await websocket.receive_bytes()
                b64       = base64.b64encode(raw_bytes).decode("utf-8")
                await send({"event": {"audioInput": {"promptName": prompt_name, "contentName": audio_content_name, "content": b64}}})

        # ── Your Coroutine B — unchanged except save_transcript_turn added ────
        async def sonic_to_browser():
            nonlocal current_role, display_text

            while True:
                output = await stream.await_output()
                result = await output[1].receive()

                if not (result.value and result.value.bytes_):
                    continue

                data = json.loads(result.value.bytes_.decode("utf-8"))
                if "event" not in data:
                    continue

                event = data["event"]

                if "contentStart" in event:
                    cs           = event["contentStart"]
                    current_role = cs.get("role")
                    if "additionalModelFields" in cs:
                        extra        = json.loads(cs["additionalModelFields"])
                        display_text = extra.get("generationStage") == "SPECULATIVE"
                    else:
                        display_text = False

                elif "audioOutput" in event:
                    audio_b64   = event["audioOutput"]["content"]
                    audio_bytes = base64.b64decode(audio_b64)
                    await websocket.send_bytes(audio_bytes)

                elif "textOutput" in event:
                    text = event["textOutput"]["content"]

                    if current_role == "USER" or (current_role == "ASSISTANT" and display_text):
                        conversation_manager.append(patient_id, current_role, text)

                        await websocket.send_text(json.dumps({
                            "type": "transcript",
                            "role": current_role,
                            "text": text,
                        }))

                        # ── NEW: save to Aurora (non-blocking) ────────────────
                        asyncio.ensure_future(save_transcript_turn(current_role, text))

                        if current_role == "USER":
                            lower = text.lower()
                            for keyword in ALERT_KEYWORDS:
                                if keyword in lower and keyword not in alerted_keywords:
                                    alerted_keywords.add(keyword)
                                    conversation_manager.set_risk(patient_id, "HIGH")
                                    logger.warning("🚨 ALERT | Patient %s | '%s'", patient_id, keyword)
                                    await websocket.send_text(json.dumps({
                                        "type":    "alert",
                                        "keyword": keyword,
                                        "message": "Emergency keyword detected — please call emergency services immediately.",
                                    }))

                        elif current_role == "ASSISTANT":
                            turns = len(conversation_manager.get_or_create(patient_id)["transcript"])
                            if turns > 0 and turns % 4 == 0:
                                asyncio.ensure_future(background_risk_analysis(patient_id))

        await asyncio.gather(browser_to_sonic(), sonic_to_browser())

    except WebSocketDisconnect:
        logger.info("Patient %s disconnected", patient_id)

    except Exception as e:
        logger.error("Voice session error — patient %s: %s", patient_id, e)
        try:
            await websocket.send_text(json.dumps({
                "type":    "error",
                "message": "Voice session encountered an error. Please try again.",
            }))
        except Exception:
            pass

    finally:
        # ── NEW: mark session as ended in Aurora ──────────────────────────────
        if voice_session:
            try:
                async with AsyncSessionLocal() as db:
                    result = await db.execute(
                        select(VoiceSession).where(VoiceSession.id == voice_session.id)
                    )
                    vs = result.scalar_one_or_none()
                    if vs:
                        vs.risk_level = conversation_manager.get_risk(patient_id)
                        vs.ended_at   = datetime.utcnow()
                        await db.commit()
            except Exception as e:
                logger.warning("Could not update session end time: %s", e)

        # Your stream cleanup — unchanged
        if stream:
            try:
                await send({"event": {"contentEnd": {"promptName": prompt_name, "contentName": audio_content_name}}})
                await send({"event": {"promptEnd": {"promptName": prompt_name}}})
                await send({"event": {"sessionEnd": {}}})
                await stream.input_stream.close()
            except Exception:
                pass
        logger.info("Voice session closed — patient %s", patient_id)


# ── Background Risk Analysis — your version kept, model ID unchanged ──────────
async def background_risk_analysis(patient_id: str):
    context      = conversation_manager.get_context(patient_id, last_n=12)
    current_risk = conversation_manager.get_risk(patient_id)
    prompt = (
        f"Clinical risk analyser. Patient: {patient_id} | Current risk: {current_risk}\n"
        f"Transcript:\n{context}\n\n"
        'Reply ONLY with JSON: {"risk_level":"LOW"|"MODERATE"|"HIGH","summary":"one sentence"}'
    )
    try:
        response = bedrock_client.converse(
            modelId=NOVA_LITE_MODEL,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 128, "temperature": 0.1},
        )
        raw    = response["output"]["message"]["content"][0]["text"]
        clean  = raw.strip().replace("```json", "").replace("```", "").strip()
        result = json.loads(clean)
        conversation_manager.set_risk(patient_id, result["risk_level"])
        logger.info("Risk update — patient %s → %s", patient_id, result["risk_level"])
    except Exception as e:
        logger.warning("Background risk analysis failed (non-fatal): %s", e)