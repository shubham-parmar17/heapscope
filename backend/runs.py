# runs.py — saved benchmark runs for signed-in users. A run stores the 9 result cells, n, a label and
# the device info the browser reported, so runs from different machines can be compared side by side.
# Narrow, user-scoped queries only; deletion is per-run and only by its owner.
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import User


class RunCell(BaseModel):
    workload: Literal["small", "mixed", "churn"]
    allocator: Literal["new", "arena", "pool", "freelist"]
    ms: float = Field(ge=0)
    ops: int = Field(gt=0)
    resets: int = Field(default=0, ge=0)


class DeviceInfo(BaseModel):
    userAgent: str = ""
    platform: str = ""
    hardwareConcurrency: Optional[int] = None
    deviceMemory: Optional[float] = None


class RunCreate(BaseModel):
    label: str = Field(default="", max_length=80)
    n: int = Field(gt=0)
    device: DeviceInfo
    results: List[RunCell] = Field(min_length=1, max_length=12)


class Run(RunCreate):
    run_id: str
    user_id: str
    created_at: datetime
    share_id: Optional[str] = None


class SharedRun(RunCreate):  # public view: no user_id
    run_id: str
    created_at: datetime
    share_id: str


def build_router(db, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/runs")

    @router.get("/shared/{share_id}", response_model=SharedRun)
    async def get_shared(share_id: str):
        doc = await db.runs.find_one({"share_id": share_id}, {"_id": 0, "user_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Shared run not found")
        return SharedRun(**doc)

    @router.post("/{run_id}/share")
    async def share_run(run_id: str, user: User = Depends(get_current_user)):
        doc = await db.runs.find_one({"run_id": run_id, "user_id": user.user_id}, {"_id": 0, "run_id": 1, "share_id": 1})
        if doc is None:
            raise HTTPException(status_code=404, detail="Run not found")
        share_id = doc.get("share_id") or uuid.uuid4().hex[:16]
        await db.runs.update_one(
            {"run_id": run_id, "user_id": user.user_id}, {"$set": {"share_id": share_id}}
        )
        return {"share_id": share_id}

    @router.post("", response_model=Run)
    async def create_run(body: RunCreate, user: User = Depends(get_current_user)):
        doc: Dict = body.model_dump()
        doc.update({"run_id": f"run_{uuid.uuid4().hex[:12]}", "user_id": user.user_id, "created_at": datetime.now(timezone.utc)})
        await db.runs.insert_one(doc)
        doc.pop("_id", None)
        return Run(**doc)

    @router.get("", response_model=List[Run])
    async def list_runs(user: User = Depends(get_current_user)):
        docs = await db.runs.find({"user_id": user.user_id}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
        return [Run(**d) for d in docs]

    @router.delete("/{run_id}")
    async def delete_run(run_id: str, user: User = Depends(get_current_user)):
        res = await db.runs.delete_one({"run_id": run_id, "user_id": user.user_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Run not found")
        return {"ok": True}

    return router
