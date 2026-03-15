import os
import ssl
from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from models import Base

load_dotenv()

# ── Build DATABASE_URL from individual .env parts ─────────────────────────────
_user     = os.getenv("DB_USER")
_password = os.getenv("DB_PASSWORD")
_host     = os.getenv("DB_HOST")
_port     = os.getenv("DB_PORT", "5432")
_name     = os.getenv("DB_NAME")

DATABASE_URL = (
    f"postgresql+asyncpg://{_user}:{_password}@{_host}:{_port}/{_name}"
)

# ── SSL configuration for Aurora ─────────────────────────────────────────────
# Aurora requires SSL. We pass the cert bundle downloaded from AWS.
_ssl_cert = os.getenv("DB_SSLROOTCERT")   # path to global-bundle.pem

if _ssl_cert and os.path.exists(_ssl_cert):
    # Full SSL verification using the AWS cert bundle
    ssl_ctx = ssl.create_default_context(cafile=_ssl_cert)
    ssl_ctx.check_hostname = True
    ssl_ctx.verify_mode    = ssl.CERT_REQUIRED
    connect_args = {"ssl": ssl_ctx}
else:
    # Fallback — no cert file, still require SSL (less strict)
    connect_args = {"ssl": "require"}

# ── Engine ────────────────────────────────────────────────────────────────────
engine = create_async_engine(
    DATABASE_URL,
    connect_args=connect_args,
    echo=False,          # set True to log all SQL queries (useful for debugging)
    pool_size=5,         # max persistent connections
    max_overflow=10,     # extra connections allowed under load
    pool_pre_ping=True,  # test connections before using (handles Aurora failover)
)

# ── Session factory ───────────────────────────────────────────────────────────
AsyncSessionLocal = sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# ── Dependency for FastAPI routes ─────────────────────────────────────────────
async def get_db():
    """
    FastAPI dependency — injects an async DB session into route handlers.
    Usage:
        @app.post("/some-route")
        async def my_route(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

# ── Table creation ────────────────────────────────────────────────────────────
async def init_db():
    """
    Creates all tables on startup if they don't exist.
    Safe to call every time — won't drop existing tables.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)