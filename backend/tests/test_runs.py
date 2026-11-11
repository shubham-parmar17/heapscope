# Saved benchmark runs API tests: /api/runs POST/GET/DELETE, auth, ownership, validation
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient


from pathlib import Path


def _env(path, key):
    candidates = [path]
    if path.startswith("/app/"):
        rel = path[len("/app/"):]
        candidates.append(str(Path(__file__).resolve().parent.parent.parent / rel))
    for p in candidates:
        try:
            with open(p) as f:
                for line in f:
                    if line.startswith(key + "="):
                        return line.split("=", 1)[1].strip().strip('"')
        except FileNotFoundError:
            pass
    return "http://localhost:8000" if "URL" in key else "mongodb://localhost:27017" if "MONGO" in key else "test_database"


BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _env("/app/frontend/.env", "REACT_APP_BACKEND_URL")).rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL") or _env("/app/backend/.env", "MONGO_URL")
DB_NAME = os.environ.get("DB_NAME") or _env("/app/backend/.env", "DB_NAME")


@pytest.fixture(scope="module")
def db():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest.fixture(scope="module")
def created(db):
    rec = {"users": [], "tokens": [], "runs": []}
    yield rec
    for rid in rec["runs"]:
        db.runs.delete_one({"run_id": rid})
    for uid in rec["users"]:
        db.users.delete_one({"user_id": uid})
    for t in rec["tokens"]:
        db.user_sessions.delete_one({"session_token": t})


def make_user(db, created):
    s = uuid.uuid4().hex[:10]
    uid, token = f"test-user-{s}", f"test_session_{s}"
    db.users.insert_one({"user_id": uid, "email": f"test.user.{s}@example.com", "name": "TEST_User",
                         "picture": None, "created_at": datetime.now(timezone.utc)})
    db.user_sessions.insert_one({"user_id": uid, "session_token": token,
                                 "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
                                 "created_at": datetime.now(timezone.utc)})
    created["users"].append(uid)
    created["tokens"].append(token)
    return uid, {"Authorization": f"Bearer {token}"}


def payload(label="TEST_run", n=200000, k=9, allocs=("new", "arena", "pool")):
    cells = [{"workload": w, "allocator": a, "ms": 1.5 + i, "ops": 200000}
             for i, (w, a) in enumerate((w, a) for w in ("small", "mixed", "churn") for a in allocs)]
    return {"label": label, "n": n,
            "device": {"userAgent": "pytest Chrome/120", "platform": "Linux", "hardwareConcurrency": 8, "deviceMemory": 8},
            "results": cells[:k]}


@pytest.fixture(scope="module")
def u1(db, created):
    return make_user(db, created)


@pytest.fixture(scope="module")
def u2(db, created):
    return make_user(db, created)


ALL4 = ("new", "arena", "pool", "freelist")


class TestRunsAuth:
    def test_get_no_auth(self):
        assert requests.get(f"{BASE_URL}/api/runs").status_code == 401

    def test_post_no_auth(self):
        assert requests.post(f"{BASE_URL}/api/runs", json=payload()).status_code == 401

    def test_delete_no_auth(self):
        assert requests.delete(f"{BASE_URL}/api/runs/run_x").status_code == 401

    def test_get_bad_token(self):
        assert requests.get(f"{BASE_URL}/api/runs", headers={"Authorization": "Bearer nope"}).status_code == 401


class TestRunsCRUD:
    def test_create_list_delete(self, u1, created):
        uid, h = u1
        r = requests.post(f"{BASE_URL}/api/runs", json=payload("TEST_first"), headers=h)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["run_id"].startswith("run_") and d["user_id"] == uid and d["created_at"]
        assert d["label"] == "TEST_first" and d["n"] == 200000 and len(d["results"]) == 9
        assert d["device"]["hardwareConcurrency"] == 8 and d["results"][0]["resets"] == 0
        assert "_id" not in d
        created["runs"].append(d["run_id"])
        time.sleep(0.05)
        r2 = requests.post(f"{BASE_URL}/api/runs", json=payload("TEST_second", k=1), headers=h).json()
        created["runs"].append(r2["run_id"])

        lst = requests.get(f"{BASE_URL}/api/runs", headers=h)
        assert lst.status_code == 200
        ids = [x["run_id"] for x in lst.json()]
        assert ids[:2] == [r2["run_id"], d["run_id"]]  # newest first
        assert all(x["user_id"] == uid for x in lst.json())

        dl = requests.delete(f"{BASE_URL}/api/runs/{d['run_id']}", headers=h)
        assert dl.status_code == 200 and dl.json() == {"ok": True}
        assert requests.delete(f"{BASE_URL}/api/runs/{d['run_id']}", headers=h).status_code == 404
        ids = [x["run_id"] for x in requests.get(f"{BASE_URL}/api/runs", headers=h).json()]
        assert d["run_id"] not in ids and r2["run_id"] in ids

    def test_ownership(self, u1, u2, created):
        _, h1 = u1
        _, h2 = u2
        r = requests.post(f"{BASE_URL}/api/runs", json=payload("TEST_owned"), headers=h1).json()
        created["runs"].append(r["run_id"])
        ids2 = [x["run_id"] for x in requests.get(f"{BASE_URL}/api/runs", headers=h2).json()]
        assert r["run_id"] not in ids2
        assert requests.delete(f"{BASE_URL}/api/runs/{r['run_id']}", headers=h2).status_code == 404
        ids1 = [x["run_id"] for x in requests.get(f"{BASE_URL}/api/runs", headers=h1).json()]
        assert r["run_id"] in ids1

    def test_limit_50(self, db, created):
        uid, h = make_user(db, created)
        now = datetime.now(timezone.utc)
        docs = []
        for i in range(55):
            rid = f"run_test{uuid.uuid4().hex[:8]}"
            p = payload(f"TEST_bulk{i}", k=1)
            p.update({"run_id": rid, "user_id": uid, "created_at": now + timedelta(seconds=i)})
            docs.append(p)
            created["runs"].append(rid)
        db.runs.insert_many(docs)
        lst = requests.get(f"{BASE_URL}/api/runs", headers=h).json()
        assert len(lst) == 50 and lst[0]["label"] == "TEST_bulk54"


class TestRunsValidation:
    @pytest.mark.parametrize("mut", [
        lambda p: p.update(results=[]),
        lambda p: p.update(n=0),
        lambda p: p.update(n=-5),
        lambda p: p.update(label="x" * 81),
        lambda p: p.update(results=payload(k=12, allocs=ALL4)["results"] + payload()["results"][:1]),  # 13 cells
        lambda p: p["results"][0].update(allocator="bogus"),
        lambda p: p.pop("device"),
        lambda p: p["results"][0].pop("ms"),
    ])
    def test_invalid(self, u1, mut):
        _, h = u1
        p = payload()
        mut(p)
        assert requests.post(f"{BASE_URL}/api/runs", json=p, headers=h).status_code == 422

    def test_label_80_ok(self, u1, created):
        _, h = u1
        r = requests.post(f"{BASE_URL}/api/runs", json=payload("y" * 80), headers=h)
        assert r.status_code == 200
        created["runs"].append(r.json()["run_id"])


# Share links: POST /api/runs/{id}/share, public GET /api/runs/shared/{share_id}
class TestShare:
    def test_12_cells_freelist_ok(self, u1, created):
        _, h = u1
        r = requests.post(f"{BASE_URL}/api/runs", json=payload("TEST_12", k=12, allocs=ALL4), headers=h)
        assert r.status_code == 200, r.text
        assert len(r.json()["results"]) == 12
        assert sum(c["allocator"] == "freelist" for c in r.json()["results"]) == 3
        created["runs"].append(r.json()["run_id"])

    def test_share_flow(self, u1, u2, created):
        uid, h = u1
        _, h2 = u2
        run = requests.post(f"{BASE_URL}/api/runs", json=payload("TEST_share", k=12, allocs=ALL4), headers=h).json()
        created["runs"].append(run["run_id"])
        assert run.get("share_id") is None
        assert requests.post(f"{BASE_URL}/api/runs/{run['run_id']}/share").status_code == 401
        s1 = requests.post(f"{BASE_URL}/api/runs/{run['run_id']}/share", headers=h)
        assert s1.status_code == 200, s1.text
        sid = s1.json()["share_id"]
        assert isinstance(sid, str) and len(sid) >= 8
        s2 = requests.post(f"{BASE_URL}/api/runs/{run['run_id']}/share", headers=h)
        assert s2.json()["share_id"] == sid  # idempotent
        g = requests.get(f"{BASE_URL}/api/runs/shared/{sid}")
        assert g.status_code == 200
        d = g.json()
        assert "user_id" not in d and "_id" not in d
        assert d["label"] == "TEST_share" and d["n"] == 200000 and len(d["results"]) == 12
        assert d["run_id"] == run["run_id"] and d["share_id"] == sid and d["created_at"]
        assert d["device"]["platform"] == "Linux"
        assert requests.post(f"{BASE_URL}/api/runs/{run['run_id']}/share", headers=h2).status_code == 404
        assert requests.post(f"{BASE_URL}/api/runs/run_nope/share", headers=h).status_code == 404
        lst = requests.get(f"{BASE_URL}/api/runs", headers=h).json()
        assert [x for x in lst if x["run_id"] == run["run_id"]][0]["share_id"] == sid
        # deleting the run kills the share link
        requests.delete(f"{BASE_URL}/api/runs/{run['run_id']}", headers=h)
        assert requests.get(f"{BASE_URL}/api/runs/shared/{sid}").status_code == 404

    def test_shared_bogus_404(self):
        r = requests.get(f"{BASE_URL}/api/runs/shared/bogus")
        assert r.status_code == 404 and r.json()["detail"]
