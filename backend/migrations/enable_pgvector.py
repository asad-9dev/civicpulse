"""
Apply backend/migrations/enable_pgvector.sql to Supabase.

    python backend/migrations/enable_pgvector.py            # run it, or say how to
    python backend/migrations/enable_pgvector.py --check    # only report what exists

How it runs depends on the credentials available:

  SUPABASE_DB_URL set   Connects to Postgres directly and runs the whole file in one
                        transaction. Needs `pip install psycopg[binary]`. Get the URL from
                        Supabase > Project Settings > Database > Connection string > URI.

  only the service key  The service key talks to PostgREST, which reads and writes rows but
                        cannot create extensions, tables or functions. So the script reports
                        what is missing and prints the SQL to paste into the Supabase SQL
                        Editor once, then verifies afterwards.

Safe to re-run either way: every statement in the SQL file is guarded.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from seed_boards import credentials, read_env_file  # noqa: E402
from common import PROJECT_ROOT  # noqa: E402

SQL_PATH = Path(__file__).resolve().parent / "enable_pgvector.sql"


def rest_get(url: str, key: str, path: str) -> int:
    request = urllib.request.Request(
        f"{url}/rest/v1/{path}", headers={"apikey": key, "Authorization": f"Bearer {key}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except urllib.error.URLError:
        return 0


def rest_rpc(url: str, key: str, name: str, payload: dict) -> int:
    request = urllib.request.Request(
        f"{url}/rest/v1/rpc/{name}",
        data=json.dumps(payload).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except urllib.error.URLError:
        return 0


def check(url: str, key: str) -> dict[str, bool]:
    """What the migration is supposed to create, and whether it's there."""
    present = {
        "documents table": rest_get(url, key, "documents?select=id&limit=1") == 200,
        "document_chunks table": rest_get(url, key, "document_chunks?select=id&limit=1") == 200,
    }
    # A missing function is 404; a present one called with a bad vector is 400 or 404 from
    # Postgres itself, so an empty-vector call distinguishes them by message rather than code.
    code = rest_rpc(url, key, "match_document_chunks", {"query_embedding": [0.0] * 768, "match_count": 1})
    present["match_document_chunks"] = code == 200
    return present


def run_with_postgres(connection_string: str) -> bool:
    try:
        import psycopg
    except ImportError:
        print("! SUPABASE_DB_URL is set but psycopg isn't installed.")
        print("  Run `pip install \"psycopg[binary]\"`, then run this again.")
        return False

    sql = SQL_PATH.read_text(encoding="utf-8")
    with psycopg.connect(connection_string, connect_timeout=30) as connection:
        with connection.cursor() as cursor:
            cursor.execute(sql)
        connection.commit()
    print("+ Ran enable_pgvector.sql against Postgres.")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Enable pgvector search tables in Supabase.")
    parser.add_argument("--check", action="store_true", help="report what exists and stop")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    env = read_env_file(PROJECT_ROOT / ".env.local")
    url, key = credentials()

    if not args.check:
        db_url = (env.get("SUPABASE_DB_URL") or env.get("POSTGRES_URL") or env.get("DATABASE_URL") or "").strip()
        if db_url and run_with_postgres(db_url):
            args.check = True  # fall through to verification

    state = check(url, key)
    print(f"State on {url.split('//')[-1]}:")
    for name, ok in state.items():
        print(f"  {name:24} {'present' if ok else 'MISSING'}")

    if all(state.values()):
        print("\n+ pgvector search is ready.")
        return 0

    if args.check:
        return 1

    print("\nThe service key can read and write rows but cannot create extensions, tables or")
    print("functions, so this has to be applied once. Either:")
    print("")
    print("  a) put the Postgres connection string in .env.local as SUPABASE_DB_URL")
    print("     (Supabase > Project Settings > Database > Connection string > URI),")
    print("     `pip install \"psycopg[binary]\"`, and run this again; or")
    print("  b) paste backend/migrations/enable_pgvector.sql into")
    print("     Supabase > SQL Editor > New query > Run.")
    print("")
    print("-" * 92)
    print(SQL_PATH.read_text(encoding="utf-8"))
    print("-" * 92)
    print("\nThen re-run with --check to confirm.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
