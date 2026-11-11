# Google sign-in testing

Sign-in is optional. The allocator views work anonymously; Google sign-in enables saving and sharing benchmark runs.

## Configure local OAuth

1. Copy `backend/.env.example` to `backend/.env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. Copy `frontend/.env.example` to `frontend/.env`.
3. In the Google Cloud OAuth web client, set the JavaScript origin to `http://localhost:3000` and the exact
   redirect URI to `http://localhost:8000/api/auth/google/callback`.
4. Start MongoDB, the backend on port 8000, and the frontend on port 3000.

## Verify the flow

- Open the app and click **sign in with Google**. The browser should visit `accounts.google.com`.
- Complete sign-in. Google returns to the backend callback, which creates the app session cookie and returns
  to the frontend. The account email should appear in the top bar.
- Refresh the page; the account should remain signed in.
- Click **sign out**; the sign-in button should return and `/api/auth/me` should return 401.
- Test a callback without OAuth state: `GET /api/auth/google/callback?code=bad&state=bad` should return to
  the frontend with `?auth_error=1` and must not create a session.

Backend API integration tests are in `backend/tests/`. They use a running API and MongoDB configured with
`REACT_APP_BACKEND_URL`, `MONGO_URL`, and `DB_NAME`.
