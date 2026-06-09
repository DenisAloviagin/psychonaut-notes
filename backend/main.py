import os
import hmac
import hashlib
import json
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Конфигурация из переменных окружения Render ──────────────────────────────
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
# Проверку подписи можно временно выключить для отладки: VERIFY_INIT_DATA=false
VERIFY_INIT_DATA = os.environ.get("VERIFY_INIT_DATA", "true").lower() != "false"

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-sonnet-4-6"

app = FastAPI()

# ── CORS: разрешаем фронту на Vercel обращаться к серверу ────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://psychonaut-notes.vercel.app",
    ],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# ── Верификация подписи Telegram WebApp ──────────────────────────────────────
def verify_init_data(init_data: str) -> bool:
    if not VERIFY_INIT_DATA:
        return True
    if not init_data or not BOT_TOKEN:
        return False
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = pairs.pop("hash", None)
        if not received_hash:
            return False
        data_check_string = "\n".join(
            f"{k}={pairs[k]}" for k in sorted(pairs.keys())
        )
        secret_key = hmac.new(
            b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256
        ).digest()
        calc_hash = hmac.new(
            secret_key, data_check_string.encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(calc_hash, received_hash)
    except Exception:
        return False


# ── Запрос к Claude ──────────────────────────────────────────────────────────
async def ask_claude(prompt: str, max_tokens: int) -> str:
    if not CLAUDE_API_KEY:
        raise HTTPException(status_code=500, detail="CLAUDE_API_KEY not set")
    headers = {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(CLAUDE_URL, headers=headers, json=body)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Claude API error")
    data = r.json()
    parts = data.get("content", [])
    if parts and isinstance(parts, list):
        return parts[0].get("text", "")
    return ""


# ── Модель тела запроса ───────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    prompt: str
    initData: str = ""


# ── Эндпоинты ─────────────────────────────────────────────────────────────────
@app.get("/")
def health():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    text = await ask_claude(req.prompt, max_tokens=1000)
    return {"text": text or "Не удалось получить анализ."}


@app.post("/ratings")
async def ratings(req: AnalyzeRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    raw = await ask_claude(req.prompt, max_tokens=100)
    cleaned = raw.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
    except Exception:
        parsed = {}
    return {"ratings": parsed}
