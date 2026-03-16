import psycopg2
import boto3
load.dotenv()
_user     = os.getenv("DB_USER")
_password = os.getenv("DB_PASSWORD")
_host     = os.getenv("DB_HOST")
_port     = os.getenv("DB_PORT", "5432")
_name     = os.getenv("DB_NAME")
conn = None
try:
    conn = psycopg2.connect(
        host=_host,
        port=_port,
        database=_name,
        user=_user,
        password=_password,
        sslmode='verify-full',
    sslrootcert='/certs/global-bundle.pem'
    )
    cur = conn.cursor()
    cur.execute('SELECT version();')
    print(cur.fetchone()[0])
    cur.close()
except Exception as e:
    print(f"Database error: {e}")
    raise
finally:
    if conn:
        conn.close()
