"""Unit tests for the app-owned Google OAuth flow."""
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth


class FakeCollection:
    def __init__(self):
        self.documents = []

    async def find_one(self, query, projection=None):
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    async def insert_one(self, document):
        self.documents.append(dict(document))

    async def update_one(self, query, update):
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                document.update(update.get("$set", {}))
                return

    async def delete_one(self, query):
        self.documents = [
            document for document in self.documents
            if not all(document.get(key) == value for key, value in query.items())
        ]


class FakeDatabase:
    def __init__(self):
        self.users = FakeCollection()
        self.user_sessions = FakeCollection()


def make_client(db):
    app = FastAPI()
    app.include_router(auth.build_router(db), prefix="/api")
    return TestClient(app)


def configure_google(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/auth/google/callback")
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")
    monkeypatch.setenv("COOKIE_SECURE", "false")
    monkeypatch.setenv("SESSION_COOKIE_SAMESITE", "lax")


def test_google_login_redirects_to_google_and_sets_state_and_nonce(monkeypatch):
    configure_google(monkeypatch)
    client = make_client(FakeDatabase())

    response = client.get("/api/auth/google/login", follow_redirects=False)

    assert response.status_code == 302
    assert urlparse(response.headers["location"]).netloc == "accounts.google.com"
    params = parse_qs(urlparse(response.headers["location"]).query)
    assert params["client_id"] == ["test-client-id.apps.googleusercontent.com"]
    assert params["redirect_uri"] == ["http://localhost:8000/api/auth/google/callback"]
    assert params["state"][0] == client.cookies.get(auth.STATE_COOKIE)
    assert params["nonce"][0] == client.cookies.get(auth.NONCE_COOKIE)
    assert "session_token" not in response.cookies


def test_google_callback_rejects_a_mismatched_state(monkeypatch):
    configure_google(monkeypatch)
    client = make_client(FakeDatabase())
    client.cookies.set(auth.STATE_COOKIE, "expected-state", path=auth.OAUTH_COOKIE_PATH)
    client.cookies.set(auth.NONCE_COOKIE, "expected-nonce", path=auth.OAUTH_COOKIE_PATH)

    response = client.get(
        "/api/auth/google/callback?code=unused&state=wrong-state",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "http://localhost:3000/?auth_error=1"
    assert not response.cookies.get(auth.SESSION_COOKIE)


def test_validated_google_callback_creates_app_session(monkeypatch):
    configure_google(monkeypatch)
    db = FakeDatabase()
    client = make_client(db)
    login = client.get("/api/auth/google/login", follow_redirects=False)
    params = parse_qs(urlparse(login.headers["location"]).query)

    class TokenResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"id_token": "mock.google.id-token"}

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, data):
            assert url == auth.GOOGLE_TOKEN_URL
            assert data["client_secret"] == "test-client-secret"
            return TokenResponse()

    monkeypatch.setattr(auth.httpx, "AsyncClient", MockAsyncClient)
    monkeypatch.setattr(auth, "_verify_google_id_token", lambda token, client_id: {
        "sub": "google-user-123",
        "email": "user@example.com",
        "email_verified": True,
        "name": "Test User",
        "picture": "https://example.com/avatar.png",
        "nonce": params["nonce"][0],
    })

    response = client.get(
        "/api/auth/google/callback",
        params={"code": "mock.authorization-code", "state": params["state"][0]},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "http://localhost:3000/"
    session_cookie = response.cookies.get(auth.SESSION_COOKIE)
    assert session_cookie
    assert db.users.documents[0]["email"] == "user@example.com"
    assert db.users.documents[0]["google_sub"] == "google-user-123"
    assert db.user_sessions.documents[0]["session_token"] == session_cookie
