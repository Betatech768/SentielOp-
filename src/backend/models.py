from sqlalchemy import (
    Column, String, Integer, Float, DateTime,
    ForeignKey, Text, Enum as SAEnum
)
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.dialects.postgresql import UUID
import uuid
from datetime import datetime

Base = declarative_base()


class Patient(Base):
    __tablename__ = "patients"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_code = Column(String(50), unique=True, nullable=False)  # e.g. PT-2024-0892
    name         = Column(String(100), nullable=False)
    surgery_type = Column(String(200))
    surgery_date = Column(DateTime, nullable=True)
    created_at   = Column(DateTime, default=datetime.utcnow)

    # Relationships
    check_ins      = relationship("CheckIn",      back_populates="patient", cascade="all, delete-orphan")
    voice_sessions = relationship("VoiceSession", back_populates="patient", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Patient {self.patient_code} — {self.name}>"


class CheckIn(Base):
    __tablename__ = "check_ins"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id   = Column(UUID(as_uuid=True), ForeignKey("patients.id"), nullable=False)
    days_post_op = Column(Integer)
    symptoms     = Column(Text)
    s3_key       = Column(String(500), nullable=True)   # wound image S3 location
    risk_level   = Column(
        SAEnum("LOW", "MODERATE", "HIGH", name="risk_level_enum"),
        default="LOW",
        nullable=False,
    )
    assessment      = Column(Text, nullable=True)
    recommendations = Column(Text, nullable=True)       # stored as JSON string
    created_at      = Column(DateTime, default=datetime.utcnow)

    # Relationships
    patient = relationship("Patient", back_populates="check_ins")
    vitals  = relationship("Vital",   back_populates="check_in", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<CheckIn patient={self.patient_id} day={self.days_post_op} risk={self.risk_level}>"


class Vital(Base):
    __tablename__ = "vitals"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    check_in_id = Column(UUID(as_uuid=True), ForeignKey("check_ins.id"), nullable=False)
    temperature = Column(Float, nullable=True)   # °C
    heart_rate  = Column(Integer, nullable=True) # bpm
    pain_score  = Column(Integer, nullable=True) # 1-10
    recorded_at = Column(DateTime, default=datetime.utcnow)

    check_in = relationship("CheckIn", back_populates="vitals")

    def __repr__(self):
        return f"<Vital pain={self.pain_score} temp={self.temperature} hr={self.heart_rate}>"


class VoiceSession(Base):
    __tablename__ = "voice_sessions"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id = Column(UUID(as_uuid=True), ForeignKey("patients.id"), nullable=False)
    risk_level = Column(String(20), default="LOW")
    started_at = Column(DateTime, default=datetime.utcnow)
    ended_at   = Column(DateTime, nullable=True)

    # Relationships
    patient     = relationship("Patient",    back_populates="voice_sessions")
    transcripts = relationship("Transcript", back_populates="session", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<VoiceSession patient={self.patient_id} risk={self.risk_level}>"


class Transcript(Base):
    __tablename__ = "transcripts"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("voice_sessions.id"), nullable=False)
    role       = Column(String(20), nullable=False)  # USER | ASSISTANT | SYSTEM
    text       = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("VoiceSession", back_populates="transcripts")

    def __repr__(self):
        return f"<Transcript role={self.role} text={self.text[:40]}>"