# Auth API tests: Google OAuth callback rejection, session /me, and logout.
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient


from pathlib import Path


def _frontend_env(key):
    for p in ["/app/frontend/.env", str(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")]:
        try:
            with open(p) as f:
                for line in f:
                    if line.startswith(key + "="):
                        return line.split("=", 1)[1].strip().strip('"')
        except FileNotFoundError:
            pass
    return "http://localhost:8000"


BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _frontend_env("REACT_APP_BACKEND_URL")).rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest.fixture(scope="module")
def db():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest.fixture(scope="module")
def created(db):
    rec = {"users": [], "tokens": []}
    yield rec
    for uid in rec["users"]:
        db.users.delete_one({"user_id": uid})
    for t in rec["tokens"]:
        db.user_sessions.delete_one({"session_token": t})


def make_user(db, created, expires_delta=timedelta(days=7), expires_as_str=False):
    suffix = uuid.uuid4().hex[:10]
    uid = f"test-user-{suffix}"
    token = f"test_session_{suffix}"
    email = f"test.user.{suffix}@example.com"
    db.users.insert_one({"user_id": uid, "email": email, "name": "TEST_User",
                         "picture": "https://via.placeholder.com/150", "created_at": datetime.now(timezone.utc)})
    exp = datetime.now(timezone.utc) + expires_delta
    db.user_sessions.insert_one({"user_id": uid, "session_token": token,
                                 "expires_at": exp.isoformat() if expires_as_str else exp,
                                 "created_at": datetime.now(timezone.utc)})
    created["users"].append(uid)
    created["tokens"].append(token)
    return uid, token, email


class TestMe:
    def test_me_no_credentials(self):
        r = requests.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401
        assert "detail" in r.json()

    def test_me_invalid_token(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": "Bearer nope_" + uuid.uuid4().hex})
        assert r.status_code == 401

    def test_me_bearer_valid(self, db, created):
        uid, token, email = make_user(db, created)
        r = requests.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        d = r.json()
        assert d["user_id"] == uid and d["email"] == email and d["name"] == "TEST_User"
        assert d["picture"] == "https://via.placeholder.com/150"
        assert "_id" not in d

    def test_me_cookie_valid(self, db, created):
        uid, token, email = make_user(db, created)
        r = requests.get(f"{BASE_URL}/api/auth/me", cookies={"session_token": token})
        assert r.status_code == 200
        assert r.json()["email"] == email

    def test_me_expired(self, db, created):
        _, token, _ = make_user(db, created, expires_delta=timedelta(hours=-1))
        r = requests.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401
        assert r.json()["detail"] == "Session expired"

    def test_me_expired_iso_string(self, db, created):
        _, token, _ = make_user(db, created, expires_delta=timedelta(hours=-1), expires_as_str=True)
        r = requests.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401

    def test_me_orphan_session(self, db, created):
        token = f"test_session_orphan_{uuid.uuid4().hex[:8]}"
        db.user_sessions.insert_one({"user_id": "missing-user", "session_token": token,
                                     "expires_at": datetime.now(timezone.utc) + timedelta(days=1)})
        created["tokens"].append(token)
        r = requests.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401


class TestGoogleOAuth:
    def test_callback_rejects_missing_state_and_returns_to_frontend(self):
        r = requests.get(
            f"{BASE_URL}/api/auth/google/callback",
            params={"code": "invalid", "state": "invalid"},
            allow_redirects=False,
        )
        assert r.status_code == 303
        assert "auth_error=1" in r.headers["location"]


class TestLogout:
    def test_logout_bearer(self, db, created):
        _, token, _ = make_user(db, created)
        h = {"Authorization": f"Bearer {token}"}
        assert requests.get(f"{BASE_URL}/api/auth/me", headers=h).status_code == 200
        r = requests.post(f"{BASE_URL}/api/auth/logout", headers=h)
        assert r.status_code == 200 and r.json() == {"ok": True}
        assert db.user_sessions.find_one({"session_token": token}) is None
        assert requests.get(f"{BASE_URL}/api/auth/me", headers=h).status_code == 401

    def test_logout_clears_cookie_header(self, db, created):
        _, token, _ = make_user(db, created)
        r = requests.post(f"{BASE_URL}/api/auth/logout", cookies={"session_token": token})
        assert r.status_code == 200
        sc = r.headers.get("set-cookie", "")
        assert "session_token=" in sc and ("Max-Age=0" in sc or "expires" in sc.lower())
        assert db.user_sessions.find_one({"session_token": token}) is None

    def test_logout_anonymous(self):
        r = requests.post(f"{BASE_URL}/api/auth/logout")
        assert r.status_code == 200
