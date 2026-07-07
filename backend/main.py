import os
import hmac
import hashlib
import json
import base64
import asyncio
import time
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

# Срок доступа в днях. 365 = год. Меняется тут, без правок кода.
try:
    PREMIUM_DAYS = int(os.environ.get("PREMIUM_DAYS", "365"))
except ValueError:
    PREMIUM_DAYS = 365

# Секрет вебхука: им подписываются апдейты от Telegram, чтобы не приняли подделку.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
# Секрет для служебных операций (настройка вебхука и возврат денег).
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")
# Секрет режима нагрузочного теста. Пустой = режим выключен (боевое поведение).
LOADTEST_SECRET = os.environ.get("LOADTEST_SECRET", "")
# Публичный адрес вебхука. По умолчанию наш бэкенд на Render.
WEBHOOK_URL = os.environ.get(
    "WEBHOOK_URL",
    "https://psychonaut-notes-backend.onrender.com/telegram-webhook",
)
# Адрес самого приложения (Vercel). На него ведёт кнопка запуска.
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://psychonaut-notes.vercel.app")

# Белый список Telegram ID тестировщиков. Пустой набор = вход открыт всем.
# На время закрытого теста сюда впишутся ID тестировщиков.
ALLOWLIST = {
    "631093482",     # @dostoevski_fm (Денис)
    # --- ТЕСТИРОВЩИКИ (доступ открыт), для всех остальных приложение закрыто ---
    "1617653940",    # @tulasika
    "393603088",     # @Rbk_kg
    "5589255130",    # @Kika3232
    "6064118682",    # @ibratrue
    "1344091386",    # @alenkabrazil
    "834656842",     # @nesu_svit_na
    "192273255",     # @Nyillt
    "7841938564",    # @eldar_zhitskii2
    "5877670648",    # @i_Dengo
    "340115482",     # @AlexShpak
    "121939826",     # @vidun_n
    "633552131",     # @djoinsky
    "1911756701",    # @teona_nakatl
    "160690850",     # @jkrushinskaya
    "320575916",     # @LatGy
}

GREETING = "🖥️ Заметки психонавта запущены.\n\nЭто мини-приложение для интеграции психоделического опыта. Место, где опыт не теряется: подготовка до, запись по горячим следам, спокойный разбор после.\n\nЧто внутри:\n📝 Заметки. Намерения, сама сессия, сложные моменты, что пришло\n🔍 Разбор сессий. Claude отражает паттерны и задаёт вопросы для углубления\n📊 Трекер. Как меняются твои грани от сессии к сессии, два радара\n📚 База знаний. Статьи о подготовке, самом опыте и интеграции\n🛟 Кризис. Что делать в трудный момент, упражнения для заземления\n\nЖми кнопку ниже 👇"

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
                cur.execute(
                    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;"
                )
                cur.execute(
                    "UPDATE payments SET expires_at = created_at + make_interval(days => %s) "
                    "WHERE expires_at IS NULL;",
                    (PREMIUM_DAYS,),
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS consents (
                        telegram_user_id  BIGINT      PRIMARY KEY,
                        agreed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
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


def get_user_name_from_init_data(init_data: str) -> str:
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        u = json.loads(pairs.get("user", "") or "{}")
        return u.get("username") or u.get("first_name") or ""
    except Exception:
        return ""


def is_allowed(user_id) -> bool:
    if not ALLOWLIST:
        return True
    return str(user_id) in ALLOWLIST


def require_tester(init_data: str):
    if not verify_init_data(init_data):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(init_data)
    if not is_allowed(user_id):
        raise HTTPException(status_code=403, detail="Not in allowlist")
    return user_id


# ── Запросы к Telegram Bot API ──────────────────────────────────────────────────
async def tg_api(method: str, payload: dict) -> dict:
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="BOT_TOKEN not set")
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload)
    return r.json()


async def tg_send_text_chunks(chat_id, text: str) -> dict:
    """Отправляет длинный текст пользователю несколькими сообщениями (лимит Telegram ~4096)."""
    text = (text or "").strip()
    if not text:
        return {"ok": False}
    LIMIT = 3500
    parts = []
    while text:
        if len(text) <= LIMIT:
            parts.append(text); break
        cut = text.rfind("\n", 0, LIMIT)
        if cut < LIMIT * 0.5:
            cut = LIMIT
        parts.append(text[:cut]); text = text[cut:].lstrip("\n")
    last = {"ok": True}
    for idx, p in enumerate(parts):
        sent = False
        for attempt in range(3):
            last = await tg_api("sendMessage", {"chat_id": chat_id, "text": p})
            if last.get("ok"):
                sent = True
                break
            await asyncio.sleep(1.2)
        if not sent:
            return last
        if idx < len(parts) - 1:
            await asyncio.sleep(0.4)
    return last


async def tg_send_photo_bytes(chat_id, png_bytes: bytes, caption: str = "") -> dict:
    """Отправляет картинку пользователю как фото. Файл идёт транзитом, нигде не хранится."""
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="BOT_TOKEN not set")
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto"
    data = {"chat_id": str(chat_id)}
    if caption:
        data["caption"] = caption
    files = {"photo": ("zarisovka.png", png_bytes, "image/png")}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(url, data=data, files=files)
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
    loadtest: str = ""  # секрет режима нагрузочного теста; в боевом режиме игнорируется


class InitDataRequest(BaseModel):
    initData: str = ""


class RefundRequest(BaseModel):
    adminSecret: str = ""
    chargeId: str = ""


class SketchRequest(BaseModel):
    initData: str = ""
    image: str = ""  # PNG в base64 (можно с префиксом data:image/png;base64,)


class AnalysisSendRequest(BaseModel):
    initData: str = ""
    text: str = ""


# ── Защита ручек анализа: потолок длины и ограничение частоты ────────────────────
MAX_ANALYZE_CHARS = 60000  # разумный потолок промпта, отсекает мусорные мегабайтные запросы
_rate_buckets: dict = {}

def check_rate(user_id, name: str, limit: int, window: int) -> None:
    """Простое ограничение частоты в памяти процесса. Защищает ручку от бесконтрольного дёргания."""
    key = f"{name}:{user_id}"
    now = time.time()
    bucket = [t for t in _rate_buckets.get(key, []) if now - t < window]
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Слишком часто, попробуй чуть позже")
    bucket.append(now)
    _rate_buckets[key] = bucket


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
    # Режим нагрузочного теста: включается ТОЛЬКО если на сервере задан LOADTEST_SECRET
    # и запрос принёс тот же секрет. Отдаёт мгновенный фейк без Claude, без БД, без лимитов.
    # В боевом режиме LOADTEST_SECRET пуст, поэтому это условие всегда ложно.
    if LOADTEST_SECRET and req.loadtest == LOADTEST_SECRET:
        return {"text": "LOADTEST OK"}
    user_id = require_tester(req.initData)
    if len(req.prompt or "") > MAX_ANALYZE_CHARS:
        raise HTTPException(status_code=413, detail="Слишком длинный запрос")
    check_rate(user_id, "analyze", limit=15, window=300)
    text = await ask_claude(req.prompt, max_tokens=1500)
    return {"text": text or "Не удалось получить анализ."}


@app.post("/ratings")
async def ratings(req: AnalyzeRequest):
    user_id = require_tester(req.initData)
    if len(req.prompt or "") > MAX_ANALYZE_CHARS:
        raise HTTPException(status_code=413, detail="Слишком длинный запрос")
    check_rate(user_id, "ratings", limit=20, window=300)
    raw = await ask_claude(req.prompt, max_tokens=100)
    cleaned = raw.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
    except Exception:
        parsed = {}
    return {"ratings": parsed}


# ── Зарисовка: отправляем картинку пользователю в личку от бота ──────────────────
@app.post("/send-sketch")
async def send_sketch(req: SketchRequest):
    user_id = require_tester(req.initData)
    if not user_id:
        raise HTTPException(status_code=400, detail="No user id")
    check_rate(user_id, "sketch", limit=10, window=86400)
    raw = req.image or ""
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        png = base64.b64decode(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="bad image")
    if not png:
        raise HTTPException(status_code=400, detail="empty image")
    if len(png) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="image too large")
    result = await tg_send_photo_bytes(user_id, png)
    if not result.get("ok"):
        print(f"send-sketch error: {result}")
        raise HTTPException(status_code=502, detail="send failed")
    return {"ok": True}


# ── Анализ: отправляем готовый разбор пользователю в личку текстом ───────────────
@app.post("/send-analysis")
async def send_analysis(req: AnalysisSendRequest):
    user_id = require_tester(req.initData)
    if not user_id:
        raise HTTPException(status_code=400, detail="No user id")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    result = await tg_send_text_chunks(user_id, text)
    if not result.get("ok"):
        print(f"send-analysis error: {result}")
        raise HTTPException(status_code=502, detail="send failed")
    return {"ok": True}


# ── Оплата ───────────────────────────────────────────────────────────────────────
@app.post("/access-check")
def access_check(req: InitDataRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(req.initData)
    name = get_user_name_from_init_data(req.initData)
    allowed = is_allowed(user_id)
    print(f"ACCESS id={user_id} name={name} allowed={allowed}")
    return {"allowed": allowed}


@app.post("/consent-status")
def consent_status(req: InitDataRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(req.initData)
    if not user_id:
        return {"consented": False}
    try:
        row = db_execute(
            "SELECT 1 FROM consents WHERE telegram_user_id=%s LIMIT 1;",
            (user_id,),
            fetch=True,
        )
        return {"consented": bool(row)}
    except Exception as e:
        print(f"consent-status error: {e}")
        return {"consented": False}


@app.post("/consent-accept")
def consent_accept(req: InitDataRequest):
    if not verify_init_data(req.initData):
        raise HTTPException(status_code=403, detail="Invalid init data")
    user_id = get_user_id_from_init_data(req.initData)
    if not user_id:
        raise HTTPException(status_code=400, detail="No user id")
    try:
        db_execute(
            "INSERT INTO consents (telegram_user_id) VALUES (%s) "
            "ON CONFLICT (telegram_user_id) DO NOTHING;",
            (user_id,),
        )
    except Exception as e:
        print(f"consent-accept error: {e}")
        raise HTTPException(status_code=500, detail="DB error")
    return {"ok": True}


@app.post("/create-invoice")
async def create_invoice(req: InitDataRequest):
    user_id = require_tester(req.initData)
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
    user_id = require_tester(req.initData)
    if not user_id:
        return {"premium": False}
    try:
        row = db_execute(
            "SELECT expires_at FROM payments "
            "WHERE telegram_user_id=%s AND refunded=FALSE AND expires_at > now() "
            "ORDER BY expires_at DESC LIMIT 1;",
            (user_id,),
            fetch=True,
        )
        if row:
            exp = row[0]
            return {"premium": True, "expiresAt": exp.isoformat() if exp else None}
        return {"premium": False, "expiresAt": None}
    except Exception as e:
        print(f"premium-status error: {e}")
        return {"premium": False, "expiresAt": None}


@app.post("/telegram-webhook")
async def telegram_webhook(request: Request):
    secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")

    try:
        update = await request.json()
    except Exception:
        return {"ok": True}
    if not isinstance(update, dict):
        return {"ok": True}

    try:
        # Подтверждение оплаты до списания: ответить надо быстро (окно ~10 сек).
        pcq = update.get("pre_checkout_query")
        if pcq:
            pcq_id = pcq.get("id")
            if pcq_id:
                await tg_api(
                    "answerPreCheckoutQuery",
                    {"pre_checkout_query_id": pcq_id, "ok": True},
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
                        "(telegram_user_id, telegram_payment_charge_id, stars_amount, expires_at) "
                        "VALUES (%s, %s, %s, now() + make_interval(days => %s)) "
                        "ON CONFLICT (telegram_payment_charge_id) DO NOTHING;",
                        (user_id, charge_id, amount, PREMIUM_DAYS),
                    )
                except Exception as e:
                    print(f"payment insert error: {e}")

        # Приветствие на /start с кнопкой запуска приложения.
        text = (msg.get("text") or "").strip()
        if text.startswith("/start"):
            u = msg.get("from") or {}
            print(f"TESTER_START id={u.get('id')} username={u.get('username')} name={u.get('first_name')}")
            chat_id = (msg.get("chat") or {}).get("id")
            if chat_id:
                await tg_api(
                    "sendMessage",
                    {
                        "chat_id": chat_id,
                        "text": GREETING,
                        "reply_markup": {
                            "inline_keyboard": [[
                                {"text": "Открыть приложение",
                                 "web_app": {"url": WEBAPP_URL}}
                            ]]
                        },
                    },
                )
    except Exception as e:
        print(f"webhook error: {e}")

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


@app.get("/setup-menu")
async def setup_menu(secret: str = ""):
    if not ADMIN_SECRET or secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")
    result = await tg_api(
        "setChatMenuButton",
        {
            "menu_button": {
                "type": "web_app",
                "text": "Открыть",
                "web_app": {"url": WEBAPP_URL},
            }
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
