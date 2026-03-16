import psycopg2
import boto3

password = AWS_PASSWORD

conn = None
try:
    conn = psycopg2.connect(
        host='postopsentiel.cluster-cmdyuka4ytnc.us-east-1.rds.amazonaws.com',
        port=5432,
        database='postgres',
        user='postgres',
        password=password,
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
