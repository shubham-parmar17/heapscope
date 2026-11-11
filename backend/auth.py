# auth.py — Google OpenID Connect login with app-owned MongoDB sessions and httpOnly cookies.
# OAuth settings stay in the backend environment; no identity token or client secret is sent to the frontend.
# Sign-in is optional for allocator views; saved runs use the same get_current_user dependency.
import asyncio
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
SESSION_DAYS = 7
SESSION_COOKIE = "session_token"
STATE_COOKIE = "google_oauth_state"
NONCE_COOKIE = "google_oauth_nonce"
OAUTH_COOKIE_PATH = "/api/auth/google"
OAUTH_COOKIE_MAX_AGE = 600
logger = logging.getLogger(__name__)


class User(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None


def _oauth_settings() -> tuple[str, str, str]:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI")
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(
            status_code=503,
            detail="Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
        )
    return client_id, client_secret, redirect_uri


def _cookie_settings() -> tuple[bool, str]:
    secure = os.environ.get("COOKIE_SECURE", "true").strip().lower() not in {"0", "false", "no"}
    same_site = os.environ.get("SESSION_COOKIE_SAMESITE", "none" if secure else "lax").strip().lower()
    if same_site not in {"lax", "strict", "none"}:
        same_site = "none" if secure else "lax"
    if same_site == "none":
        secure = True
    return secure, same_site


def _frontend_url(auth_error: bool = False) -> str:
    configured = os.environ.get("FRONTEND_URL", "http://localhost:3000").strip()
    parts = urlsplit(configured)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise HTTPException(status_code=500, detail="FRONTEND_URL must be an absolute HTTP(S) URL")
    path = parts.path.rstrip("/") + "/"
    query = "auth_error=1" if auth_error else ""
    return urlunsplit((parts.scheme, parts.netloc, path, query, ""))


def _clear_oauth_cookies(response: Response, secure: bool) -> None:
    response.delete_cookie(STATE_COOKIE, path=OAUTH_COOKIE_PATH, secure=secure, httponly=True, samesite="lax")
    response.delete_cookie(NONCE_COOKIE, path=OAUTH_COOKIE_PATH, secure=secure, httponly=True, samesite="lax")


def build_router(db) -> APIRouter:
    router = APIRouter(prefix="/auth")

    async def user_from_token(token: str) -> User:
        session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=401, detail="Invalid session")
        expires_at = session["expires_at"]
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="Session expired")
        user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return User(**user)

    def token_from_request(request: Request) -> Optional[str]:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            return token
        auth = request.headers.get("Authorization", "")
        return auth[7:] if auth.startswith("Bearer ") else None

    async def get_current_user(request: Request) -> User:
        token = token_from_request(request)
        if not token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return await user_from_token(token)

    @router.get("/google/login")
    async def google_login():
        client_id, _, redirect_uri = _oauth_settings()
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        authorization_url = GOOGLE_AUTH_URL + "?" + urlencode({
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
        })
        secure, _ = _cookie_settings()
        response = RedirectResponse(authorization_url, status_code=302)
        for key, value in ((STATE_COOKIE, state), (NONCE_COOKIE, nonce)):
            response.set_cookie(
                key=key,
                value=value,
                max_age=OAUTH_COOKIE_MAX_AGE,
                httponly=True,
                secure=secure,
                samesite="lax",
                path=OAUTH_COOKIE_PATH,
            )
        return response

    @router.get("/google/callback")
    async def google_callback(
        request: Request,
        code: Optional[str] = None,
        state: Optional[str] = None,
        error: Optional[str] = None,
    ):
        secure, same_site = _cookie_settings()
        expected_state = request.cookies.get(STATE_COOKIE, "")
        expected_nonce = request.cookies.get(NONCE_COOKIE, "")
        failure = RedirectResponse(_frontend_url(auth_error=True), status_code=303)
        _clear_oauth_cookies(failure, secure)

        if error or not code or not state or not expected_state or not expected_nonce:
            return failure
        if not secrets.compare_digest(state, expected_state):
            return failure

        try:
            client_id, client_secret, redirect_uri = _oauth_settings()
            async with httpx.AsyncClient(timeout=10) as http:
                token_response = await http.post(GOOGLE_TOKEN_URL, data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                })
            if token_response.status_code != 200:
                logger.warning("Google token exchange failed with status %s", token_response.status_code)
                return failure
            token_data = token_response.json()
            google_id_token = token_data.get("id_token") if isinstance(token_data, dict) else None
            if not google_id_token:
                logger.warning("Google token exchange response did not include an ID token")
                return failure
        except (httpx.HTTPError, ValueError, HTTPException) as exc:
            logger.warning("Google token exchange failed (%s)", type(exc).__name__)
            return failure

        try:
            claims = await asyncio.to_thread(_verify_google_id_token, google_id_token, client_id)
        except Exception as exc:
            logger.warning("Google ID token verification failed (%s)", type(exc).__name__)
            return failure

        email = claims.get("email")
        subject = claims.get("sub")
        if (
            not isinstance(email, str)
            or not email
            or claims.get("email_verified") is not True
            or not isinstance(subject, str)
            or not subject
            or not secrets.compare_digest(str(claims.get("nonce", "")), expected_nonce)
        ):
            return failure

        email = email.strip().lower()
        existing = await db.users.find_one({"google_sub": subject}, {"_id": 0})
        if not existing:
            existing = await db.users.find_one({"email": email}, {"_id": 0})
        profile = {
            "email": email,
            "name": claims.get("name") or email,
            "picture": claims.get("picture"),
            "google_sub": subject,
        }
        if existing:
            user_id = existing["user_id"]
            await db.users.update_one({"user_id": user_id}, {"$set": profile})
        else:
            user_id = f"user_{uuid.uuid4().hex[:12]}"
            try:
                await db.users.insert_one({
                    "user_id": user_id,
                    "email": email,
                    **profile,
                    "created_at": datetime.now(timezone.utc),
                })
            except DuplicateKeyError:
                existing = await db.users.find_one({"google_sub": subject}, {"_id": 0})
                if not existing:
                    existing = await db.users.find_one({"email": email}, {"_id": 0})
                if not existing:
                    raise HTTPException(status_code=409, detail="Could not create user")
                user_id = existing["user_id"]
                await db.users.update_one({"user_id": user_id}, {"$set": profile})

        now = datetime.now(timezone.utc)
        session_token = secrets.token_urlsafe(32)
        await db.user_sessions.insert_one({
            "user_id": user_id,
            "session_token": session_token,
            "created_at": now,
            "expires_at": now + timedelta(days=SESSION_DAYS),
        })

        response = RedirectResponse(_frontend_url(), status_code=303)
        _clear_oauth_cookies(response, secure)
        response.set_cookie(
            key=SESSION_COOKIE,
            value=session_token,
            httponly=True,
            secure=secure,
            samesite=same_site,
            path="/",
            max_age=SESSION_DAYS * 24 * 3600,
        )
        return response

    @router.get("/me", response_model=User)
    async def me(request: Request):
        return await get_current_user(request)

    @router.post("/logout")
    async def logout(request: Request, response: Response):
        token = token_from_request(request)
        if token:
            await db.user_sessions.delete_one({"session_token": token})
        secure, same_site = _cookie_settings()
        response.delete_cookie(SESSION_COOKIE, path="/", secure=secure, samesite=same_site)
        return {"ok": True}

    router.get_current_user = get_current_user
    return router


def _verify_google_id_token(token: str, client_id: str) -> dict:
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import id_token

    return id_token.verify_oauth2_token(
        token,
        GoogleRequest(),
        audience=client_id,
        clock_skew_in_seconds=60,
    )
