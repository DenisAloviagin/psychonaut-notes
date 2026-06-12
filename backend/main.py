import os
import hmac
import hashlib
import json
from urllib.parse import parse_qsl

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Конфигурация из переменных окружения Render ─────────────────────────────────
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Цена премиума в звёздах. На тесте = 1. Меняется только тут, без правок кода.
try:
    PREMIUM_STARS = int(os.environ.get("PREMIUM_STARS", "1"))
except ValueError:
    PREMIUM_STARS = 1

# Секрет вебхука: им подписываются апдейты от Telegram, чтобы не приняли подделку.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
# Секрет для служебных операций (настройка вебхука и возврат денег).
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")
# Публичный адрес вебхука. По умолчанию наш бэкенд на Render.
WEBHOOK_URL = os.environ.get(
    "WEBHOOK_URL",
    "https://psychonaut-notes-backend.onrender.com/telegram-webhook",
)

# Проверку подписи можно временно выключить для отладки: VERIFY_INIT_DATA=false
VERIFY_INIT_DATA = os.environ.get("VERIFY_INIT_DATA", "true").lower() != "false"

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-sonnet-4-6"

app = FastAPI()

# ── CORS: разрешаем фронту на Vercel обращаться к серверу ───────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://psychonaut-notes.vercel.app",
    ],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# ── База данных ─────────────────────────────────────────────────────────────────
def db_execute(query: str, params=None, fetch: bool = False):
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            row = cur.fetchone() if fetch else None
        conn.commit()
    return row


def init_db() -> None:
    if not DATABASE_URL:
        print("DATABASE_URL not set, skipping DB init")
        return
    try:
        with psycopg.connect(DATABASE_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS payments (
                        id                          BIGSERIAL   PRIMARY KEY,
                        telegram_user_id            BIGINT      NOT NULL,
                        telegram_payment_charge_id  TEXT        NOT NULL UNIQUE,
                        stars_amount                INTEGER     NOT NULL,
                        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
                        refunded                    BOOLEAN     NOT NULL DEFAULT FALSE,
                        refunded_at                 TIMESTAMPTZ
                    );
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_payments_user_active
                        ON payments (telegram_user_id)
                        WHERE refunded = FALSE;
                    """
                )
            conn.commit()
        print("DB init OK: table payments is ready")
    except Exception as e:
        print(f"DB init error: {e}")


@app.on_event("startup")
def on_startup() -> None:
    init_db()


# ── Верификация подписи Telegram WebApp ─────────────────────────────────────────
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


def get_user_id_from_init_data(init_data: str):
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        user_json = pairs.get("user", "")
        if not user_json:
            return None
        return json.loads(user_json).get("id")
    except Exception:
        return None


# ── Запросы к Telegram Bot API ──────────────────────────────────────────────────
async def tg_api(method: str, payload: dict) -> dict:
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="BOT_TOKEN not set")
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload)
    return r.json()


# ── Запрос к Claude ─────────────────────────────────────────────────────────────
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


# ── Модели тела запроса ─────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    prompt: str
    initData: str = ""


class InitDataRequest(BaseModel):
    initData: str = ""


class RefundRequest(BaseModel):
    adminSecret: str = ""
    chargeId: str = ""


# ── Базовые эндпоинты ────────────────────────────────────────────────────────────
@app.get("/")
def health():
    return {"status": "ok"}


@app.get("/db-health")
def db_health():
    if not DATABASE_URL:
        return {"db": "no DATABASE_URL"}
    try:
        row = db_execute("SELECT COUNT(*) FROM payments;", fetch=True)
        return {"db": "ok", "payments_rows": row[0] if row else 0}
    except Exception as e:
        return {"db": "error", "detail": str(e)}


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


# ── Оплата ───────────────────────────────────────────────────────────────────────
@app.post("/create-invoice")
async def create_invoice(req: InitDataRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(req.initData)
    if not user_id:
        raise HTTPException(status_code=400, detail="No user id")
    result = await tg_api(
        "createInvoiceLink",
        {
            "title": "Заметки психонавта Premium",
            "description": "Полный доступ к функциям приложения",
            "payload": json.dumps({"uid": user_id}),
            "provider_token": "",
            "currency": "XTR",
            "prices": [{"label": "Premium", "amount": PREMIUM_STARS}],
        },
    )
    link = result.get("result")
    if not link:
        raise HTTPException(status_code=502, detail="Invoice error")
    return {"invoiceLink": link, "stars": PREMIUM_STARS}


@app.post("/premium-status")
def premium_status(req: InitDataRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(req.initData)
    if not user_id:
        return {"premium": False}
    try:
        row = db_execute(
            "SELECT 1 FROM payments "
            "WHERE telegram_user_id=%s AND refunded=FALSE LIMIT 1;",
            (user_id,),
            fetch=True,
        )
        return {"premium": bool(row)}
    except Exception as e:
        print(f"premium-status error: {e}")
        return {"premium": False}


@app.post("/telegram-webhook")
async def telegram_webhook(request: Request):
    secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    update = await request.json()

    # Подтверждение оплаты до списания: ответить надо быстро (окно ~10 сек).
    pcq = update.get("pre_checkout_query")
    if pcq:
        await tg_api(
            "answerPreCheckoutQuery",
            {"pre_checkout_query_id": pcq["id"], "ok": True},
        )
        return {"ok": True}

    # Факт состоявшейся оплаты: записываем в БД (это источник истины).
    msg = update.get("message") or {}
    sp = msg.get("successful_payment")
    if sp:
        user_id = (msg.get("from") or {}).get("id")
        charge_id = sp.get("telegram_payment_charge_id")
        amount = sp.get("total_amount", 0)
        if user_id and charge_id:
            try:
                db_execute(
                    "INSERT INTO payments "
                    "(telegram_user_id, telegram_payment_charge_id, stars_amount) "
                    "VALUES (%s, %s, %s) "
                    "ON CONFLICT (telegram_payment_charge_id) DO NOTHING;",
                    (user_id, charge_id, amount),
                )
            except Exception as e:
                print(f"payment insert error: {e}")

    return {"ok": True}


@app.get("/setup-webhook")
async def setup_webhook(secret: str = ""):
    if not ADMIN_SECRET or secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")
    result = await tg_api(
        "setWebhook",
        {
            "url": WEBHOOK_URL,
            "secret_token": WEBHOOK_SECRET,
            "allowed_updates": ["message", "pre_checkout_query"],
        },
    )
    return result


@app.get("/test-invoice")
async def test_invoice(secret: str = "", uid: int = 0):
    if not ADMIN_SECRET or secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")
    if not uid:
        raise HTTPException(status_code=400, detail="uid required")
    result = await tg_api(
        "sendInvoice",
        {
            "chat_id": uid,
            "title": "Заметки психонавта Premium",
            "description": "Тестовая оплата доступа",
            "payload": json.dumps({"uid": uid}),
            "provider_token": "",
            "currency": "XTR",
            "prices": [{"label": "Premium", "amount": PREMIUM_STARS}],
        },
    )
    return result


@app.get("/refund-last")
async def refund_last(secret: str = "", uid: int = 0):
    if not ADMIN_SECRET or secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")
    if not uid:
        raise HTTPException(status_code=400, detail="uid required")
    row = db_execute(
        "SELECT telegram_payment_charge_id FROM payments "
        "WHERE telegram_user_id=%s AND refunded=FALSE "
        "ORDER BY created_at DESC LIMIT 1;",
        (uid,),
        fetch=True,
    )
    if not row:
        raise HTTPException(status_code=404, detail="no active payment")
    charge_id = row[0]
    result = await tg_api(
        "refundStarPayment",
        {"user_id": uid, "telegram_payment_charge_id": charge_id},
    )
    if result.get("ok"):
        db_execute(
            "UPDATE payments SET refunded=TRUE, refunded_at=now() "
            "WHERE telegram_payment_charge_id=%s;",
            (charge_id,),
        )
    return result


@app.post("/refund")
async def refund(req: RefundRequest):
    if not ADMIN_SECRET or req.adminSecret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")
    row = db_execute(
        "SELECT telegram_user_id FROM payments "
        "WHERE telegram_payment_charge_id=%s AND refunded=FALSE;",
        (req.chargeId,),
        fetch=True,
    )
    if not row:
        raise HTTPException(status_code=404, detail="payment not found")
    user_id = row[0]
    result = await tg_api(
        "refundStarPayment",
        {"user_id": user_id, "telegram_payment_charge_id": req.chargeId},
    )
    if result.get("ok"):
        db_execute(
            "UPDATE payments SET refunded=TRUE, refunded_at=now() "
            "WHERE telegram_payment_charge_id=%s;",
            (req.chargeId,),
        )
    return result
