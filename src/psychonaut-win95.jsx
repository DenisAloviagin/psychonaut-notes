import { useState, useEffect, useRef } from "react";

// ── Backend (Render) ──────────────────────────────────────────────────────────
const API_BASE = "https://psychonaut-notes-backend.onrender.com";
const tgInitData = () =>
  (typeof window !== "undefined" && window.Telegram?.WebApp?.initData) || "";

// fetch с таймаутом: мёртвый или медленный сервер (холодный старт) не должен
// вешать приложение в бесконечную загрузку, вместо этого запрос чисто отпадает.
async function fetchT(url, opts = {}) {
  const { timeout = 20000, ...rest } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Премиум: статус и счёт берём только с сервера ─────────────
async function apiPremiumStatus() {
  try {
    const r = await fetchT(`${API_BASE}/premium-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tgInitData() }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return ""; }
}

async function apiCreateInvoice() {
  try {
    const r = await fetchT(`${API_BASE}/create-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tgInitData() }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function apiAccessCheck() {
  try {
    const r = await fetchT(`${API_BASE}/access-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tgInitData() }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return !!d.allowed;
  } catch { return null; }
}

async function apiConsentStatus() {
  try {
    const r = await fetchT(`${API_BASE}/consent-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tgInitData() }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return !!d.consented;
  } catch { return null; }
}

async function apiConsentAccept() {
  try {
    const r = await fetchT(`${API_BASE}/consent-accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tgInitData() }),
    });
    return r.ok;
  } catch { return false; }
}

// ── Persistent storage (Telegram CloudStorage с фолбэком на localStorage) ─────
const NOTE_PREFIX = "psy_note_";
const INDEX_KEY = "psy_index";
const PREMIUM_KEY = "psy_premium";
const MUSIC_KEY = "psy_music";
const LOCKER_KEY = "psy_locker";

function tgCloud() {
  return (typeof window !== "undefined" && window.Telegram?.WebApp?.CloudStorage) || null;
}
function storeGet(key) {
  return new Promise((resolve) => {
    const c = tgCloud();
    if (c) {
      try { c.getItem(key, (err, val) => resolve(err ? null : (val || null))); }
      catch { resolve(null); }
    } else {
      try { resolve(localStorage.getItem(key)); } catch { resolve(null); }
    }
  });
}
function storeSet(key, value) {
  return new Promise((resolve) => {
    const c = tgCloud();
    if (c) {
      try { c.setItem(key, value, (err, ok) => resolve(!err && !!ok)); }
      catch { resolve(false); }
    } else {
      try { localStorage.setItem(key, value); resolve(true); } catch { resolve(false); }
    }
  });
}
function storeRemove(key) {
  return new Promise((resolve) => {
    const c = tgCloud();
    if (c) {
      try { c.removeItem(key, () => resolve(true)); } catch { resolve(true); }
    } else {
      try { localStorage.removeItem(key); resolve(true); } catch { resolve(true); }
    }
  });
}
function storeKeys() {
  return new Promise((resolve) => {
    const c = tgCloud();
    if (c && c.getKeys) {
      try { c.getKeys((err, keys) => resolve(err ? [] : (keys || []))); } catch { resolve([]); }
    } else {
      try { resolve(Object.keys(localStorage)); } catch { resolve([]); }
    }
  });
}

// CloudStorage режет значение на 4КБ. Большие записи (сессия + анализ) не влезают,
// поэтому режем их на куски по CHUNK_LIMIT и собираем обратно при чтении. Всё остаётся в Telegram.
const CHUNK_LIMIT = 3800;
const CHUNK_TAG = "\u0001CHUNKS:";
async function storeSetBig(key, value) {
  value = String(value == null ? "" : value);
  try {
    const prev = await storeGet(key);
    if (prev && prev.indexOf(CHUNK_TAG) === 0) {
      const pn = parseInt(prev.slice(CHUNK_TAG.length), 10) || 0;
      for (let i = 0; i < pn; i++) await storeRemove(key + "__c" + i);
    }
  } catch (e) {}
  if (value.length <= CHUNK_LIMIT) {
    return await storeSet(key, value);
  }
  const n = Math.ceil(value.length / CHUNK_LIMIT);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const part = value.slice(i * CHUNK_LIMIT, (i + 1) * CHUNK_LIMIT);
    const r = await storeSet(key + "__c" + i, part);
    ok = ok && r;
  }
  const m = await storeSet(key, CHUNK_TAG + n);
  return ok && m;
}
async function storeGetBig(key) {
  const v = await storeGet(key);
  if (v && v.indexOf(CHUNK_TAG) === 0) {
    const n = parseInt(v.slice(CHUNK_TAG.length), 10) || 0;
    let out = "";
    for (let i = 0; i < n; i++) {
      const part = await storeGet(key + "__c" + i);
      if (part == null) return null;
      out += part;
    }
    return out;
  }
  return v;
}

// ── Emoji через Twemoji (цветные картинки вместо чёрных системных) ────────────
function linkify(text) {
  if (!text) return text;
  const parts = String(text).split(/(https?:\/\/[^\s]+|t\.me\/[^\s]+)/g);
  return parts.map((part, i) => {
    if (/^(https?:\/\/|t\.me\/)/.test(part)) {
      const core = part.replace(/[.,!?;:»)\]]+$/, "");
      const trail = part.slice(core.length);
      const href = core.startsWith("t.me/") ? "https://" + core : core;
      const isTg = /t\.me\//.test(core);
      return (
        <span key={i}>
          <a href={href} target="_blank" rel="noopener noreferrer"
            onClick={(e) => {
              const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
              if (tg) {
                e.preventDefault();
                if (isTg && tg.openTelegramLink) tg.openTelegramLink(href);
                else if (tg.openLink) tg.openLink(href);
                else window.open(href, "_blank");
              }
            }}
            style={{ color: "#c0392b", textDecoration: "underline", wordBreak: "break-word" }}>
            {core}
          </a>{trail}
        </span>
      );
    }
    return part;
  });
}

function Emoji({ char, size = 18 }) {
  const tw = (typeof window !== "undefined" && window.twemoji) ? window.twemoji : null;
  const html = tw ? tw.parse(char, { folder: "svg", ext: ".svg" }) : char;
  return (
    <span
      style={{ fontSize: size, lineHeight: 0, display: "inline-flex", flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  accent: "#000080",
  ink: "#000000",
  mid: "#333333",
  muted: "#555555",
  light: "#808080",
  bg: "#c0c0c0",
  white: "#ffffff",
  facets: {
    mind:       { color: "#1a6a8a", bg: "#e8f4f8", label: "Разум" },
    body:       { color: "#b8520a", bg: "#fdf2e9", label: "Тело" },
    spirit:     { color: "#6c3483", bg: "#f4ecf7", label: "Дух" },
    relations:  { color: "#1a7a3e", bg: "#e9f7ef", label: "Отношения" },
    nature:     { color: "#7a6010", bg: "#fdf8e1", label: "Природа" },
    lifestyle:  { color: "#922b21", bg: "#fdedec", label: "Образ жизни" },
  }
};

// ── Data: questions per facet (exact from workbook) ───────────────────────────
const FACET_SUBTITLES = {
  mind:      "Психоделический опыт часто поднимает на поверхность мысли, убеждения и паттерны которые обычно скрыты.",
  body:      "Опыт живёт не только в голове. Тело помнит.",
  spirit:    "Эти вопросы не требуют религиозных убеждений. Они требуют только честности.",
  relations: "Как опыт повлиял на то, как ты видишь людей вокруг?",
  nature:    "Как опыт изменил твоё отношение к природному миру?",
  lifestyle: "Инсайт который не становится действием, остаётся просто мыслью.",
};

const FACET_QUESTIONS = {
  mind: [
    "Какие мысли или идеи были самыми яркими во время опыта?",
    "Какие убеждения о себе ты увидел, полезные или ограничивающие?",
    "Изменилось ли что-то в том, как ты думаешь о себе или о жизни?",
    "Есть ли паттерн мышления который хочется изменить? Как это могло бы выглядеть?",
    "Какой вопрос остался открытым, и как ты можешь продолжить его исследовать?",
  ],
  body: [
    "Когда ты вспоминаешь опыт, что чувствуешь в теле? Где именно?",
    "Были ли во время опыта интенсивные телесные ощущения, тепло, холод, напряжение, лёгкость?",
    "Изменилось ли что-то в твоём отношении к телу после опыта?",
    "Какая практика помогает тебе сейчас оставаться в теле?",
  ],
  spirit: [
    "Было ли во время опыта ощущение чего-то большего, единства, растворения границ?",
    "Изменилось ли что-то в твоём ощущении смысла или цели?",
    "Что стало важнее после опыта, а что потеряло значение?",
    "Есть ли практика которая помогает поддерживать эту связь в повседневной жизни?",
  ],
  relations: [
    "Как опыт повлиял на то, как ты видишь людей вокруг?",
    "Что изменилось в том, как ты воспринимаешь близких людей?",
    "Есть ли отношения которые хочется изменить, углубить, восстановить, или отпустить?",
    "Есть ли разговор который давно нужно было состояться? С кем и о чём?",
    "Есть ли кто-то кому ты хочешь сказать спасибо, или попросить прощения?",
  ],
  nature: [
    "Было ли во время опыта ощущение связи с природой или живым миром?",
    "Изменилось ли что-то в том как ты воспринимаешь природный мир?",
    "Как ты можешь привнести больше природы в свою повседневную жизнь?",
  ],
  lifestyle: [
    "Что конкретно ты хочешь изменить в том как живёшь?",
    "Одно маленькое действие которое ты можешь сделать уже сегодня:",
    "Что ты хочешь добавить в свою жизнь?",
    "Что ты хочешь убрать из своей жизни?",
    "Как через месяц будет выглядеть твоя жизнь если ты воплотишь то, что увидел?",
  ],
};

const FACET_ORDER = ["mind","body","spirit","relations","nature","lifestyle"];

const SUBSTANCES = null; // replaced by grouped select below

const MODES_OPTIONS = [
  { id: "write",    label: "Пишу", sub: "дневник, заметки, письма себе" },
  { id: "talk",     label: "Говорю", sub: "с другом, терапевтом, вслух наедине" },
  { id: "move",     label: "Двигаюсь", sub: "прогулки, танец, йога, спорт" },
  { id: "create",   label: "Создаю", sub: "рисую, пою, играю на инструменте" },
  { id: "silence",  label: "Сижу в тишине", sub: "медитирую, просто наблюдаю" },
  { id: "read",     label: "Читаю или слушаю", sub: "ищу слова других которые попадают" },
];

// ── Shared UI ─────────────────────────────────────────────────────────────────

const css = `
  :root{
    --surface:#c0c0c0;
    --raised: inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf;
    --sunken: inset -1px -1px #fff, inset 1px 1px #000, inset -2px -2px #dfdfdf, inset 2px 2px #808080;
    --titlebar: linear-gradient(90deg,#000080,#1084d0);
  }
  * {
    box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent;
    border-radius: 0 !important;
  }
  html, body { overflow-x: hidden; background: var(--surface); }
  body { background: var(--surface); color:#000; font-size:13px; line-height:1.45; font-family:'Montserrat', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'; }
  textarea, input:not([type=range]), select {
    width:100%; font-size:13px; color:#000; background:#fff;
    border:none; box-shadow: var(--sunken); padding:5px 7px; outline:none; resize:none;
  }
  textarea { resize:none; min-height:64px; }
  input[type=range]{ -webkit-appearance:none; appearance:none; width:100%; height:22px; background:transparent; padding:0; cursor:pointer; }
  input[type=range]::-webkit-slider-runnable-track{ height:4px; background:#808080; box-shadow: inset 1px 1px #000, inset -1px -1px #fff; }
  input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:11px; height:21px; margin-top:-9px; background:#c0c0c0; box-shadow:var(--raised); }
  input[type=range]::-moz-range-track{ height:4px; background:#808080; box-shadow: inset 1px 1px #000, inset -1px -1px #fff; }
  input[type=range]::-moz-range-thumb{ width:11px; height:21px; background:#c0c0c0; box-shadow:var(--raised); border:none; }
  button { font-family: inherit; cursor:pointer; }
  .tl-btn{ background:var(--surface); box-shadow:var(--raised); padding:5px 10px; font-size:12px; color:#000; border:none; }
  .tl-btn:active{ box-shadow:var(--sunken); }
  .tl-tile{ box-shadow:var(--raised); }
  .tl-tile:active{ box-shadow:var(--sunken); }
  .tl-swb{ box-shadow:var(--raised); cursor:pointer; }
  .tl-swb.on{ box-shadow:var(--sunken); }
  .tl-ta::placeholder{ font-size:10px; opacity:1; }
  img.emoji { width:1em; height:1em; display:inline-block; vertical-align:middle; margin:0; }
  ::selection{ background:#000080; color:#fff; }
  ::-webkit-scrollbar{ width:15px; height:15px; }
  ::-webkit-scrollbar-track{ background:#dfdfdf; box-shadow: inset 1px 1px #808080, inset -1px -1px #fff; }
  ::-webkit-scrollbar-thumb{ background:#c0c0c0; box-shadow: var(--raised); }
  ::-webkit-scrollbar-corner{ background:#dfdfdf; }
  @keyframes hgflip{ 0%{ transform:rotate(0deg); } 50%,60%{ transform:rotate(180deg); } 100%{ transform:rotate(360deg); } }
  .hg-spin{ display:inline-block; animation: hgflip 1.6s ease-in-out infinite; transform-origin:center; }
  body::before{ content:""; position:fixed; inset:0; border:4px solid #008080; pointer-events:none; z-index:9000; }
`;

function Style() {
  return (
    <>
      {/* Опционально: настоящий пиксельный шрифт на деплое. В песочнице может не грузиться, вид держится на CSS выше. */}
      <link rel="stylesheet" href="https://unpkg.com/98.css" />
      <style>{css}</style>
    </>
  );
}

function AccentBar() {
  const [confirmClose, setConfirmClose] = useState(false);
  const [showMinimizeHint, setShowMinimizeHint] = useState(false);
  const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  const actions = {
    "_": () => setShowMinimizeHint(true),
    "\u25A1": () => { try { if (tg && tg.expand) tg.expand(); } catch (e) {} },
    "\u2715": () => setConfirmClose(true),
  };
  return (
    <>
      <div style={{ position:"fixed", top:0, left:0, right:0, zIndex:300,
        maxWidth:480, margin:"0 auto", background:"var(--surface)", boxShadow:"var(--raised)", padding:3 }}>
        <div style={{ background:"var(--titlebar)", color:"#fff", fontWeight:700, fontSize:12,
          display:"flex", alignItems:"center", justifyContent:"space-between", padding:"3px 4px 3px 6px" }}>
          <span style={{ display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap", minWidth:0, overflow:"hidden" }}>
            <span style={{ width:14, height:14, background:"var(--surface)", boxShadow:"var(--raised)", display:"inline-block", flexShrink:0 }} />
            Заметки психонавта
          </span>
          <span style={{ display:"flex", gap:2, flexShrink:0 }}>
            {["_","\u25A1","\u2715"].map((c,i)=>(
              <button key={i} onClick={actions[c]} style={{ flex:"0 0 auto", width:30, minWidth:30, maxWidth:30, height:18, boxSizing:"border-box", background:"var(--surface)", boxShadow:"var(--raised)",
                color:"#000", fontSize:11, fontWeight:700, lineHeight:"16px", textAlign:"center", border:"none", padding:0, cursor:"pointer" }}>{c}</button>
            ))}
          </span>
        </div>
      </div>
      {confirmClose && (
        <MessageBox title="Выход"
          message="Закрыть приложение?"
          confirmLabel="Закрыть" cancelLabel="Отмена"
          onConfirm={() => { setConfirmClose(false); try { if (tg && tg.close) tg.close(); } catch (e) {} }}
          onCancel={() => setConfirmClose(false)} />
      )}
      {showMinimizeHint && (
        <MessageBox title="Свернуть"
          message="Свернуть приложение можно жестом Telegram: потяни вниз за верхнюю полоску с названием бота."
          confirmLabel="Понятно"
          onConfirm={() => setShowMinimizeHint(false)} />
      )}
    </>
  );
}

function Screen({ children, pad = "52px 10px 96px" }) {
  const ref = useRef(null);
  useEffect(() => {
    try { window.scrollTo(0, 0); } catch {}
    try {
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    } catch {}
    if (ref.current) ref.current.scrollTop = 0;
  }, []);
  return (
    <div ref={ref} style={{ minHeight:"100vh", background:"var(--surface)", padding:pad, overflowY:"auto" }}>
      {children}
    </div>
  );
}

function SectionTitle({ children, size = 36, style = {} }) {
  return (
    <div style={{ fontSize:Math.min(size,28), fontWeight:700, letterSpacing:"0.02em", color:"#000", lineHeight:1.05, marginBottom:6, ...style }}>
      {children}
    </div>
  );
}

function Sub({ children }) {
  return <div style={{ color:T.muted, fontSize:12, fontWeight:500, marginBottom:20 }}>{children}</div>;
}

function Label({ children, required }) {
  return (
    <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:T.muted, marginBottom:6 }}>
      {children}{required && <span style={{ color:T.accent }}> *</span>}
    </div>
  );
}

// Иконка папки Win95: закрытая / открытая (для выбранного пункта)
function Folder({ open, size = 18 }) {
  const h = Math.round(size * 14 / 18);
  return (
    <svg width={size} height={h} viewBox="0 0 18 14" shapeRendering="crispEdges" style={{ flex:"0 0 auto" }}>
      <path d="M1 3 h5 l1.5 1.5 H17 V11.5 H1 Z" fill={open ? "#c9a83a" : "#f0c34a"} stroke="#333" strokeWidth="1" />
      {open && <path d="M3.5 6 H18 L15.5 12 H1 Z" fill="#f7df93" stroke="#333" strokeWidth="1" />}
    </svg>
  );
}

// Пиксельные иконки граней (яркие, в своём цвете), для экрана «Оценка»
const FACET_ICON_COLORS = {
  mind:"#2a9fd0", body:"#f0801a", spirit:"#a763c9",
  relations:"#d957a8", nature:"#2fb457", lifestyle:"#e2483a",
};
function FacetIcon({ facet, size = 22 }) {
  const c = FACET_ICON_COLORS[facet] || "#000080";
  const shapes = {
    mind: (<>
      <path d="M3 6 C3 3.5 5 2 8 2 C11 2 13 3.5 13 6 C13 9 11 12 8 12 C5 12 3 9 3 6 Z" fill={c} stroke="#333" />
      <path d="M8 2.5 V11.5 M5.5 4 C6.6 5 6.6 6 5.5 7 M10.5 4 C9.4 5 9.4 6 10.5 7" fill="none" stroke="#333" />
    </>),
    body: <path d="M8 13.5 C8 13.5 2 9.5 2 5.5 C2 3.5 3.5 2 5.2 2 C6.4 2 7.4 2.8 8 3.8 C8.6 2.8 9.6 2 10.8 2 C12.5 2 14 3.5 14 5.5 C14 9.5 8 13.5 8 13.5 Z" fill={c} stroke="#333" />,
    spirit: <path d="M8 1 L9.2 6.8 L15 8 L9.2 9.2 L8 15 L6.8 9.2 L1 8 L6.8 6.8 Z" fill={c} stroke="#333" />,
    relations: (<>
      <circle cx="5" cy="5" r="2.3" fill={c} stroke="#333" />
      <circle cx="11" cy="5" r="2.3" fill={c} stroke="#333" />
      <path d="M1.5 14 C1.5 10 8.5 10 8.5 14 Z" fill={c} stroke="#333" />
      <path d="M7.5 14 C7.5 10 14.5 10 14.5 14 Z" fill={c} stroke="#333" />
    </>),
    nature: (<>
      <path d="M3 13 C3 6 8 2 14 2 C14 9 9 13 3 13 Z" fill={c} stroke="#333" />
      <path d="M4 12 L13 3.5" stroke="#333" fill="none" />
    </>),
    lifestyle: <path d="M9.5 1 L3 9 L7 9 L6 15 L13 6 L8.5 6 L9.5 1 Z" fill={c} stroke="#333" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ flex:"0 0 auto" }}>
      {shapes[facet] || null}
    </svg>
  );
}

// Тематический дропдаун вместо нативного <select> (родное меню iOS/Android стилизовать нельзя)
function WinSelect({ value, onChange, options, placeholder = "выбрать" }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position:"relative" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          background:"#fff", boxShadow:"var(--sunken)", padding:"4px 4px 4px 7px",
          fontSize:13, cursor:"pointer", minHeight:30 }}>
        <span style={{ color: value ? "#000" : "#555", overflow:"hidden",
          whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
          {value || placeholder}
        </span>
        <span style={{ flex:"0 0 auto", marginLeft:6, width:20, height:20,
          background:"var(--surface)", boxShadow: open ? "var(--sunken)" : "var(--raised)",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:9 }}>▼</span>
      </div>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position:"fixed", inset:0, zIndex:400 }} />
          <div style={{ position:"absolute", top:"calc(100% + 2px)", left:0, right:0, zIndex:401,
            background:"#fff", border:"2px solid #000080", boxShadow:"3px 3px 8px rgba(0,0,0,0.45)",
            maxHeight:240, overflowY:"auto" }}>
            {options.map(opt => {
              const sel = opt === value;
              return (
                <div key={opt} onClick={() => { onChange(opt); setOpen(false); }}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", fontSize:13, cursor:"pointer",
                    background: sel ? "#000080" : "#fff", color: sel ? "#fff" : "#000" }}>
                  <Folder open={sel} />
                  <span>{opt}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ children, style = {}, onClick }) {
  const [p, setP] = useState(false);
  return (
    <div onClick={onClick}
      onMouseDown={() => onClick && setP(true)}
      onMouseUp={() => setP(false)}
      onMouseLeave={() => setP(false)}
      style={{ background:"var(--surface)", padding:14,
        boxShadow: (p && onClick) ? "var(--sunken)" : "var(--raised)",
        cursor: onClick ? "pointer" : "default",
        ...style }}
    >{children}</div>
  );
}

function Btn({ children, onClick, variant="primary", disabled, style={} }) {
  const [p, setP] = useState(false);
  return (
    <button onClick={disabled ? undefined : onClick}
      onMouseDown={() => setP(true)} onMouseUp={() => setP(false)} onMouseLeave={() => setP(false)}
      style={{ background:"var(--surface)", color:"#000",
        boxShadow: (p && !disabled) ? "var(--sunken)" : "var(--raised)",
        padding:"8px 16px", fontSize:13, fontWeight:700,
        cursor: disabled ? "default" : "pointer", width:"100%",
        opacity: disabled ? 0.55 : 1,
        textShadow: disabled ? "1px 1px #fff" : "none",
        ...style }}
    >{children}</button>
  );
}

function BackBtn({ onClick }) {
  return (
    <button onClick={onClick} style={{ background:"var(--surface)", boxShadow:"var(--raised)",
      color:"#000", fontSize:12, fontWeight:700, padding:"4px 10px", marginBottom:10 }}>
      ← назад
    </button>
  );
}

const STEP_NAMES = [
  "Сессия", "Намерение", "После", "Сложное", "Режимы", "Грани", "Оценка", "Интеграция"
];

const FACET_KEYS = ["mind","body","spirit","relations","nature","lifestyle"];
const FACET_LABELS = { mind:"Разум", body:"Тело", spirit:"Дух", relations:"Отношения", nature:"Природа", lifestyle:"Образ жизни" };
const FACET_EMOJIS = { mind:"🧠", body:"🫀", spirit:"✨", relations:"🤝", nature:"🌿", lifestyle:"⚡" };

function ProgressBar({ current }) {
  const total = STEP_NAMES.length;
  const pct = Math.round((current / (total - 1)) * 100);
  return (
    <div style={{ marginBottom:16 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.04em", textTransform:"uppercase", color:"#000" }}>
          {STEP_NAMES[current]}
        </div>
        <div style={{ fontSize:11, color:"#333" }}>
          {current + 1} / {total}
        </div>
      </div>
      <div style={{ height:16, background:"#fff", boxShadow:"var(--sunken)", padding:2 }}>
        <div style={{ height:"100%", width:`${pct}%`, background:"#000080", transition:"width 0.3s ease" }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
        {STEP_NAMES.map((name, i) => (
          <div key={i} style={{ width:8, height:8,
            background: i <= current ? "#000080" : "#fff", boxShadow:"var(--sunken)" }} />
        ))}
      </div>
    </div>
  );
}

// Прогресс внутри одной грани
function FacetProgress({ facetKey, answers }) {
  const questions = FACET_QUESTIONS[facetKey] || [];
  const filled = questions.filter((_, i) => answers?.[i]?.trim()).length;
  const total = questions.length;
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  if (filled === 0) return null;
  return (
    <div style={{ marginTop:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <div style={{ fontSize:10, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>
          заполнено {filled} из {total}
        </div>
        <div style={{ fontSize:10, color: filled===total ? "#1a7a3e" : T.muted,
          fontWeight:600, fontFamily:"'Montserrat', sans-serif" }}>
          {pct}%
        </div>
      </div>
      <div style={{ height:3, background:T.light, borderRadius:2 }}>
        <div style={{ height:"100%", width:`${pct}%`,
          background: filled===total ? "#1a7a3e" : T.accent,
          borderRadius:2, transition:"width 0.3s" }} />
      </div>
    </div>
  );
}

function FacetTag({ facet }) {
  const f = T.facets[facet];
  if (!f) return null;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:10, fontWeight:700,
      letterSpacing:"0.06em", textTransform:"uppercase",
      padding:"3px 8px", boxShadow:"var(--raised)", background:"var(--surface)", color:"#000" }}>
      <span style={{ width:8, height:8, background:f.color, boxShadow:"var(--sunken)", display:"inline-block" }} />
      {f.label}
    </span>
  );
}

function QuoteBox({ children }) {
  return (
    <div style={{ borderLeft:"3px solid #000080", background:"#ffffff",
      boxShadow:"var(--sunken)", padding:"10px 12px", margin:"14px 0",
      fontSize:12, color:"#333", lineHeight:1.6, fontStyle:"italic" }}>
      {children}
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function FolderIcon({ size = 42, open = false }) {
  if (open) {
    return (
      <svg width={size} height={size*52/64} viewBox="0 0 64 52" style={{ display:"block" }}>
        <polygon points="6,12 25,12 31,18 56,18 56,40 6,40" fill="#d07d12" />
        <polygon points="16,8 46,8 46,24 16,24" fill="#ffffff" />
        <polygon points="16,8 46,8 46,11 16,11" fill="#e1e4eb" />
        <polygon points="2,25 62,25 53,47 11,47" fill="#ffc83a" />
        <polygon points="2,25 62,25 61,28 3,28" fill="#ffdd80" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size*52/64} viewBox="0 0 64 52" style={{ display:"block" }}>
      <polygon points="6,11 25,11 31,17 58,17 58,46 6,46" fill="#e08a1e" />
      <polygon points="4,23 60,23 56,48 8,48" fill="#ffbe2e" />
      <polygon points="4,23 60,23 59,26 5,26" fill="#ffd66e" />
    </svg>
  );
}
function DocIcon({ size = 40 }) {
  return (
    <svg width={size} height={size*56/48} viewBox="0 0 48 56" style={{ display:"block" }}>
      <polygon points="10,8 33,8 41,16 41,51 10,51" fill="rgba(0,0,0,0.16)" />
      <polygon points="8,6 31,6 39,14 39,49 8,49" fill="#ffffff" stroke="#96a0af" strokeWidth="1" />
      <polygon points="31,6 39,14 31,14" fill="#d6dbe4" stroke="#96a0af" strokeWidth="1" />
      <g stroke="#788caa" strokeWidth="2">
        <line x1="13" y1="22" x2="34" y2="22" /><line x1="13" y1="28" x2="34" y2="28" />
        <line x1="13" y1="34" x2="34" y2="34" /><line x1="13" y1="40" x2="34" y2="40" />
        <line x1="13" y1="46" x2="26" y2="46" />
      </g>
    </svg>
  );
}
function LockBadge({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display:"block" }}>
      <path d="M8 11 V8.5 a4 4 0 0 1 8 0 V11" fill="none" stroke="#8a8a8a" strokeWidth="2.4" />
      <rect x="6" y="11" width="12" height="9.5" rx="1.5" fill="#f0b429" stroke="#9a7414" strokeWidth="1" />
      <circle cx="12" cy="15" r="1.7" fill="#6b4e0a" />
      <rect x="11.2" y="15.5" width="1.6" height="3.2" fill="#6b4e0a" />
    </svg>
  );
}

function BinIcon({ size = 18 }) {
  return (
    <svg width={size} height={size*52/48} viewBox="0 0 48 52" style={{ display:"inline-block", verticalAlign:"middle" }}>
      <polygon points="13,18 35,18 32,47 16,47" fill="#c8c8c8" stroke="#505050" strokeWidth="1" />
      <polygon points="13,18 16,18 18,47 16,47" fill="#e0e0e0" />
      <ellipse cx="24" cy="17.5" rx="13" ry="3.5" fill="#e0e0e0" stroke="#505050" strokeWidth="1" />
      <ellipse cx="24" cy="17.5" rx="10" ry="2" fill="#969696" />
      <g fill="#229622">
      <polygon points="24.60,27.55 27.53,32.61 29.52,31.46 26.60,26.40" />
      <polygon points="26.53,33.18 30.51,30.88 30.02,34.63" />
      <polygon points="28.42,36.25 22.58,36.25 22.58,38.55 28.42,38.55" />
      <polygon points="22.58,35.10 22.58,39.70 19.58,37.40" />
      <polygon points="18.97,35.20 21.90,30.14 19.90,28.99 16.98,34.05" />
      <polygon points="22.89,30.72 18.91,28.42 22.40,26.97" />
      </g>
    </svg>
  );
}

function WarnIcon({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flex:"0 0 auto", display:"block" }}>
      <polygon points="16,3 30,28 2,28" fill="#f5c518" stroke="#000" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="14.5" y="11" width="3" height="9" fill="#000" />
      <rect x="14.5" y="22" width="3" height="3" fill="#000" />
    </svg>
  );
}
function MessageBox({ title = "Подтверждение", message, confirmLabel = "OK", cancelLabel, onConfirm, onCancel }) {
  const MB_RAISED = "inset -1px -1px #000, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff";
  return (
    <div onClick={onCancel || onConfirm} style={{ position:"fixed", inset:0, zIndex:2000,
      background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width:"100%", maxWidth:320, background:"#c0c0c0", boxShadow:MB_RAISED }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          background:"linear-gradient(90deg,#000080,#1084d0)", color:"#fff", padding:"3px 4px 3px 6px",
          margin:2, fontWeight:700, fontSize:12 }}>
          <span>{title}</span>
          <button onClick={onCancel || onConfirm} style={{ width:18, height:16, fontSize:11, lineHeight:"12px",
            background:"#c0c0c0", color:"#000", border:"none", cursor:"pointer", boxShadow:MB_RAISED }}>✕</button>
        </div>
        <div style={{ display:"flex", gap:12, padding:"16px 16px 8px", alignItems:"flex-start" }}>
          <WarnIcon size={32} />
          <div style={{ fontSize:13, color:"#000", lineHeight:1.5, paddingTop:2 }}>{message}</div>
        </div>
        <div style={{ display:"flex", justifyContent:"center", gap:10, padding:"8px 16px 16px" }}>
          <button onClick={onConfirm} style={{ minWidth:88, padding:"6px 14px", fontWeight:700, fontSize:13,
            background:"#c0c0c0", color:"#000", border:"none", cursor:"pointer", boxShadow:MB_RAISED }}>{confirmLabel}</button>
          {cancelLabel && (
            <button onClick={onCancel} style={{ minWidth:88, padding:"6px 14px", fontWeight:700, fontSize:13,
              background:"#c0c0c0", color:"#000", border:"none", cursor:"pointer", boxShadow:MB_RAISED }}>{cancelLabel}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function HourGlass({ size = 28 }) {
  return (
    <svg className="hg-spin" width={size} height={size} viewBox="0 0 24 24" style={{ display:"inline-block" }}>
      <rect x="4" y="2" width="16" height="2.4" fill="#000" />
      <rect x="4" y="19.6" width="16" height="2.4" fill="#000" />
      <polygon points="5.5,4.4 18.5,4.4 12,12" fill="#fff" stroke="#000" strokeWidth="1" />
      <polygon points="12,12 5.5,19.6 18.5,19.6" fill="#fff" stroke="#000" strokeWidth="1" />
      <polygon points="7.5,5.6 16.5,5.6 12,10.6" fill="#d9a441" />
      <polygon points="12,13.4 8.2,18.8 15.8,18.8" fill="#d9a441" />
    </svg>
  );
}

const NAV = [
  { id:"journal", label:"Заметки", icon:(
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="3" width="16" height="18" rx="2"/>
      <line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/>
      <line x1="8" y1="16" x2="12" y2="16"/>
    </svg>
  )},
  { id:"library", label:"База знаний", icon:(
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>
    </svg>
  )},
  { id:"crisis", label:"Кризис", icon:(
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none"/>
    </svg>
  )},
  { id:"tracker", label:"Трекер", icon:(
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <polygon points="12,2 22,8 22,16 12,22 2,16 2,8"/>
      <polygon points="12,7 17,10 17,14 12,17 7,14 7,10"/>
    </svg>
  )},
];


// Одинаковый треугольник-стрелка, рисуется кодом, поэтому все 4 стороны идентичны.
function Tri({ d }) {
  const pts = {
    up: "8,3 14,13 2,13",
    down: "2,3 14,3 8,13",
    left: "3,8 13,2 13,14",
    right: "13,8 3,2 3,14",
  }[d];
  return (<svg width="16" height="16" viewBox="0 0 16 16"><polygon points={pts} fill="#000" /></svg>);
}

// ── Змейка (только для премиума). Вся логика в браузере: сервер и база не участвуют. ──
function SnakeGame({ isPremium, onBack, onUpgrade }) {
  const GRID = 16;
  const HI_KEY = "psy_snake_hi";
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [px, setPx] = useState(320);
  const [score, setScore] = useState(0);
  const [hi, setHi] = useState(0);
  const [over, setOver] = useState(false);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false);
  const [fx, setFx] = useState("");
  const [rules, setRules] = useState(false);

  const snake = useRef([]);
  const dir = useRef({ x: 1, y: 0 });
  const nextDir = useRef({ x: 1, y: 0 });
  const items = useRef([]);
  const eff = useRef({ slow: 0, dash: 0, invert: 0, magnet: 0, mult: 0 });
  const strong = useRef([]);
  const peakUntil = useRef(0);
  const grow = useRef(0);
  const alive = useRef(false);
  const pausedR = useRef(false);
  const loop = useRef(null);
  const shake = useRef(0);
  const touch = useRef(null);
  const scoreRef = useRef(0);
  const hiRef = useRef(0);

  useEffect(() => {
    (async () => { try { const v = await storeGet(HI_KEY); if (v) { const n = parseInt(v, 10) || 0; hiRef.current = n; setHi(n); } } catch (e) {} })();
    const measure = () => {
      const w = wrapRef.current ? wrapRef.current.clientWidth : 320;
      setPx(Math.max(220, Math.min(360, w - 8)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); if (loop.current) clearTimeout(loop.current); };
  }, []);

  if (!isPremium) {
    return (
      <Screen>
        <BackBtn onClick={onBack} />
        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", borderRadius:14, padding:20, textAlign:"center", marginTop:8 }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🐍</div>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:22, letterSpacing:"0.05em", color:T.ink, marginBottom:10 }}>ЗМЕЙКА ПСИХОНАВТА</div>
          <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, marginBottom:20, fontFamily:"'Montserrat', sans-serif" }}>
            Змейка ловит грибы, кактусы, марки, таблетки и каннабис, и каждый предмет ненадолго меняет игру. Мини-игра для передышки, доступна в полной версии.
          </div>
          <Btn onClick={onUpgrade}>Открыть полный доступ</Btn>
        </div>
      </Screen>
    );
  }

  const boardPx = Math.floor(px / GRID) * GRID;
  const C = Math.floor(px / GRID);

  function randCell() { return { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) }; }
  function occupied(c) {
    return snake.current.some(sg => sg.x === c.x && sg.y === c.y) || items.current.some(it => it.x === c.x && it.y === c.y);
  }
  function specialsCount() { return items.current.filter(it => it.type !== "berry").length; }
  function spawnItem() {
    let c, tries = 0;
    do { c = randCell(); tries++; } while (occupied(c) && tries < 60);
    if (occupied(c)) return; // не удалось найти свободную клетку
    const canSpecial = specialsCount() < 2;
    const r = Math.random();
    let type;
    if (!canSpecial) type = "berry";
    else if (r < 0.41) type = "berry";
    else if (r < 0.53) type = "mushroom";
    else if (r < 0.65) type = "cactus";
    else if (r < 0.73) type = "marka";
    else if (r < 0.84) type = "pill";
    else type = "cannabis";
    items.current.push({ x: c.x, y: c.y, type });
  }
  function ensureItems() {
    let guard = 0;
    while (items.current.length < 5 && guard < 40) { spawnItem(); guard++; }
  }

  function reset() {
    const mid = Math.floor(GRID / 2);
    snake.current = [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
    dir.current = { x: 1, y: 0 }; nextDir.current = { x: 1, y: 0 };
    items.current = []; ensureItems();
    eff.current = { slow: 0, dash: 0, invert: 0, magnet: 0, mult: 0 };
    strong.current = []; peakUntil.current = 0; grow.current = 0; shake.current = 0;
    scoreRef.current = 0; setScore(0); setOver(false); setPaused(false); pausedR.current = false; setFx("");
    alive.current = true; setStarted(true);
    if (loop.current) clearTimeout(loop.current);
    schedule();
  }

  function tickMs() {
    const now = Date.now();
    if (eff.current.dash > now) return 92;
    if (eff.current.slow > now) return 250;
    return 165;
  }
  function schedule() { loop.current = setTimeout(step, tickMs()); }

  function setDir(nx, ny) {
    if (!alive.current || pausedR.current) return;
    if (Date.now() < peakUntil.current) return;
    let dx = nx, dy = ny;
    if (eff.current.invert > Date.now()) { dx = -nx; dy = -ny; }
    if (dx === -dir.current.x && dy === -dir.current.y) return;
    nextDir.current = { x: dx, y: dy };
  }

  function addScore(n) { scoreRef.current += n; setScore(scoreRef.current); }
  function strongHit(now) {
    strong.current = strong.current.filter(t => now - t < 8000);
    strong.current.push(now);
    if (strong.current.length >= 3) { peakUntil.current = now + 1500; strong.current = []; shake.current = 10; }
  }
  function cellTaken(x, y, self) {
    return items.current.some(it => it !== self && it.x === x && it.y === y) ||
      snake.current.some(sg => sg.x === x && sg.y === y);
  }
  function pullItems(head) {
    const d = dir.current;
    items.current.forEach(it => {
      let nx = it.x, ny = it.y;
      if (d.x !== 0 && it.y === head.y) {
        // движемся горизонтально: тянем то, что впереди на этой строке
        if (d.x > 0 && it.x > head.x) nx = it.x - 1;
        else if (d.x < 0 && it.x < head.x) nx = it.x + 1;
        else return;
      } else if (d.y !== 0 && it.x === head.x) {
        // движемся вертикально: тянем то, что впереди в этом столбце
        if (d.y > 0 && it.y > head.y) ny = it.y - 1;
        else if (d.y < 0 && it.y < head.y) ny = it.y + 1;
        else return;
      } else {
        return; // в соседних дорожках предметы не двигаются
      }
      if (nx === head.x && ny === head.y) return; // на голову не наезжаем (съедим на своём ходу)
      if (cellTaken(nx, ny, it)) return; // не наезжаем на другой предмет
      it.x = nx; it.y = ny;
    });
  }
  function eat(type, now) {
    const mult = eff.current.mult > now ? 2 : 1;
    if (type === "berry") { grow.current += 1; addScore(10 * mult); }
    else if (type === "mushroom") { grow.current += 1; eff.current.slow = now + 5000; addScore(5 * mult); }
    else if (type === "cactus") { grow.current += 3; eff.current.dash = now + 5000; addScore(15 * mult); strongHit(now); }
    else if (type === "marka") { grow.current += 1; eff.current.invert = now + 4000; addScore(5 * mult); strongHit(now); shake.current = 6; }
    else if (type === "pill") { grow.current += 1; eff.current.magnet = now + 5000; addScore(5 * mult); }
    else if (type === "cannabis") { grow.current += 1; eff.current.mult = now + 6000; addScore(10 * mult); }
  }
  function updateFx(now) {
    let label = "";
    if (now < peakUntil.current) label = "ПЕРЕДОЗ";
    else if (eff.current.invert > now) label = "ЛСД · инверсия";
    else if (eff.current.dash > now) label = "Мескалин · рывок";
    else if (eff.current.slow > now) label = "Гриб · замедление";
    else if (eff.current.magnet > now) label = "МДМА · магнит";
    else if (eff.current.mult > now) label = "Каннабис · x2";
    setFx(label);
  }
  function gameOver() {
    alive.current = false; setOver(true);
    if (scoreRef.current > hiRef.current) {
      hiRef.current = scoreRef.current; setHi(scoreRef.current);
      try { storeSet(HI_KEY, String(scoreRef.current)); } catch (e) {}
    }
  }

  function step() {
    if (!alive.current) return;
    if (pausedR.current) { schedule(); return; }
    const now = Date.now();
    dir.current = nextDir.current;
    const head = snake.current[0];
    const nh = { x: (head.x + dir.current.x + GRID) % GRID, y: (head.y + dir.current.y + GRID) % GRID };
    if (snake.current.some(sg => sg.x === nh.x && sg.y === nh.y)) { gameOver(); return; }
    snake.current.unshift(nh);
    const idx = items.current.findIndex(it => it.x === nh.x && it.y === nh.y);
    if (idx >= 0) { eat(items.current[idx].type, now); items.current.splice(idx, 1); ensureItems(); }
    if (grow.current > 0) grow.current--; else snake.current.pop();
    if (eff.current.magnet > now) pullItems(nh);
    updateFx(now);
    if (shake.current > 0) shake.current--;
    draw();
    schedule();
  }

  function rr(g, x, y, w, h, rad) {
    g.beginPath();
    g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath();
  }
  function drawItem(g, it) {
    const x = it.x * C, y = it.y * C, cx = x + C / 2, cy = y + C / 2, r = C * 0.34;
    if (it.type === "berry") {
      g.fillStyle = "#c0392b"; g.beginPath(); g.arc(cx, cy + 1, r, 0, 7); g.fill();
      g.fillStyle = "#e57368"; g.beginPath(); g.arc(cx - r * 0.3, cy - r * 0.2, r * 0.3, 0, 7); g.fill();
      g.strokeStyle = "#3a8f3a"; g.lineWidth = Math.max(1, C * 0.06); g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r * 0.3, cy - r * 1.4); g.stroke();
    }
    else if (it.type === "mushroom") {
      const R = C * 0.38;
      g.fillStyle = "#b98a4a"; g.fillRect(cx - C * 0.14, cy + R * 0.1, C * 0.28, R * 1.0);
      g.fillStyle = "#8f6a34"; g.fillRect(cx - C * 0.14, cy + R * 0.1, C * 0.09, R * 1.0);
      g.fillStyle = "#e02a1f"; g.beginPath(); g.arc(cx, cy + R * 0.05, R, Math.PI, 0); g.fill(); g.fillRect(cx - R, cy + R * 0.05 - 1, R * 2, 3);
      g.fillStyle = "#ffffff";
      g.beginPath(); g.arc(cx - R * 0.45, cy - R * 0.2, R * 0.2, 0, 7); g.fill();
      g.beginPath(); g.arc(cx + R * 0.4, cy - R * 0.15, R * 0.17, 0, 7); g.fill();
      g.beginPath(); g.arc(cx, cy - R * 0.5, R * 0.15, 0, 7); g.fill();
    }
    else if (it.type === "cactus") {
      g.fillStyle = "#2f9e3f";
      const tW = C * 0.20, stemTop = cy - r * 1.0, stemBot = cy + r * 1.05;
      rr(g, cx - tW / 2, stemTop, tW, stemBot - stemTop, 4); g.fill();
      const laX = cx - r * 0.95, laY = cy + r * 0.15;
      rr(g, laX, laY, r * 0.7, tW * 0.8, 3); g.fill();
      rr(g, laX, cy - r * 0.55, tW * 0.8, laY - (cy - r * 0.55) + tW * 0.8, 3); g.fill();
      const raY = cy - r * 0.1;
      rr(g, cx + tW * 0.2, raY, r * 0.75, tW * 0.8, 3); g.fill();
      rr(g, cx + r * 0.7, cy - r * 0.8, tW * 0.8, raY - (cy - r * 0.8) + tW * 0.8, 3); g.fill();
      g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(cx - tW / 2, stemTop, tW * 0.32, stemBot - stemTop);
      g.fillStyle = "#1f6b2f"; g.fillRect(cx - 1, cy - r * 0.4, 2, 2); g.fillRect(cx - 1, cy + r * 0.1, 2, 2); g.fillRect(cx - 1, cy + r * 0.6, 2, 2);
    }
    else if (it.type === "marka") {
      g.fillStyle = "#f2ecff"; g.fillRect(cx - r, cy - r, r * 2, r * 2);
      g.strokeStyle = "#7a4fd0"; g.lineWidth = Math.max(1, C * 0.05); g.strokeRect(cx - r, cy - r, r * 2, r * 2);
      g.lineWidth = Math.max(1, C * 0.07);
      g.beginPath(); g.arc(cx, cy, r * 0.5, 0, 5.2); g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.22, 0, 6.2); g.stroke();
    }
    else if (it.type === "pill") {
      const R = C * 0.38;
      g.fillStyle = "#ffffff"; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.fillStyle = "#2aa0d8"; g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.5, Math.PI * 1.5); g.fill();
      g.lineWidth = Math.max(2, C * 0.09); g.strokeStyle = "#12455f"; g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
      g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
    }
    else if (it.type === "cannabis") {
      g.fillStyle = "#2f9e3f";
      for (let k = -2; k <= 2; k++) { g.save(); g.translate(cx, cy + r * 0.3); g.rotate(k * 0.5); g.beginPath(); g.ellipse(0, -r * 0.6, r * 0.16, r * 0.85, 0, 0, 7); g.fill(); g.restore(); }
      g.strokeStyle = "#1f6b2f"; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, cy + r * 0.3); g.lineTo(cx, cy + r); g.stroke();
    }
  }
  function draw() {
    const cv = canvasRef.current; if (!cv) return;
    const g = cv.getContext("2d");
    const W = C * GRID;
    let ox = 0, oy = 0;
    if (shake.current > 0) { ox = Math.random() * 4 - 2; oy = Math.random() * 4 - 2; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.save(); g.translate(ox, oy);
    g.fillStyle = "#dfeecf"; g.fillRect(0, 0, W, W);
    g.strokeStyle = "rgba(0,0,0,0.06)"; g.lineWidth = 1;
    for (let i = 1; i < GRID; i++) { g.beginPath(); g.moveTo(i * C, 0); g.lineTo(i * C, W); g.stroke(); g.beginPath(); g.moveTo(0, i * C); g.lineTo(W, i * C); g.stroke(); }
    items.current.forEach(it => drawItem(g, it));
    snake.current.forEach((sg, i) => { g.fillStyle = i === 0 ? "#1f7a1f" : "#2f9e2f"; g.fillRect(sg.x * C + 1, sg.y * C + 1, C - 2, C - 2); });
    if (eff.current.invert > Date.now()) { g.fillStyle = "rgba(180,60,200,0.12)"; g.fillRect(0, 0, W, W); }
    g.restore();
  }

  function onTouchStart(e) { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }
  function onTouchMove(e) { if (e.cancelable) e.preventDefault(); }
  function onTouchEnd(e) {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x, dy = t.clientY - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 1 : -1, 0); else setDir(0, dy > 0 ? 1 : -1);
  }
  function togglePause() { if (!alive.current) return; const p = !pausedR.current; pausedR.current = p; setPaused(p); }

  const arrow = { width: 46, height: 40, WebkitAppearance: "none", appearance: "none", borderRadius: 0, background: "#c0c0c0", border: "none", cursor: "pointer", fontSize: 18, fontWeight: 700, color: "#000", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" };

  return (
    <Screen>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button onClick={onBack} style={{ height: 32, padding: "0 14px", WebkitAppearance: "none", appearance: "none", borderRadius: 0, background: "#c0c0c0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#000", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" }}>← Назад</button>
        <button onClick={() => setRules(true)} style={{ height: 32, padding: "0 14px", WebkitAppearance: "none", appearance: "none", borderRadius: 0, background: "#c0c0c0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#000", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" }}>Как играть</button>
      </div>
      <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, paddingTop: 8 }}>
        <div style={{ width: "100%", maxWidth: 380, background: "var(--surface)", boxShadow: "var(--raised)" }}>
          <div style={{ background: "linear-gradient(90deg,#000080,#1084d0)", color: "#fff", fontWeight: 700, fontSize: 13, padding: "4px 8px", margin: 2, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 14, height: 12, background: "#c0c0c0", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff", flex: "none" }} />
            <span>Змейка</span>
            <span style={{ marginLeft: "auto", fontSize: 12 }}>рекорд {hi}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 10px", fontFamily: "'Montserrat', sans-serif" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#000" }}>Счёт {score}</span>
            <span style={{ fontSize: 12, color: "#8a5fd0", minHeight: 16, fontWeight: 700 }}>{fx}</span>
          </div>
          <div style={{ position: "relative", padding: "0 8px 8px", display: "flex", justifyContent: "center" }}>
            <div style={{ position: "relative", boxShadow: "inset -1px -1px #fff, inset 1px 1px #808080, inset -2px -2px #dfdfdf, inset 2px 2px #000", lineHeight: 0 }}>
              <canvas ref={canvasRef} width={boardPx} height={boardPx}
                onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
                style={{ touchAction: "none", display: "block", width: boardPx, height: boardPx }} />
              {(!started || over || paused) && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, background: "rgba(0,0,0,0.35)" }}>
                  {over && <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Игра окончена · {score}</div>}
                  {paused && !over && <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Пауза</div>}
                  {(!started || over) && (
                    <button onClick={reset} style={{ ...arrow, width: 150, height: 38, fontSize: 14 }}>{over ? "Заново" : "Новая игра"}</button>
                  )}
                  {paused && !over && <button onClick={togglePause} style={{ ...arrow, width: 150, height: 38, fontSize: 14 }}>Продолжить</button>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <button style={arrow} onClick={() => setDir(0, -1)}><Tri d="up" /></button>
          <div style={{ display: "flex", gap: 4 }}>
            <button style={arrow} onClick={() => setDir(-1, 0)}><Tri d="left" /></button>
            <button style={arrow} onClick={togglePause}>{paused ? <Tri d="right" /> : (
              <svg width="16" height="16" viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" fill="#000" /><rect x="9" y="3" width="3" height="10" fill="#000" /></svg>
            )}</button>
            <button style={arrow} onClick={() => setDir(1, 0)}><Tri d="right" /></button>
          </div>
          <button style={arrow} onClick={() => setDir(0, 1)}><Tri d="down" /></button>
        </div>

      </div>

      {rules && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setRules(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 340, background: "#c0c0c0", boxShadow: "inset -1px -1px #000, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff" }}>
            <div style={{ background: "linear-gradient(90deg,#000080,#1084d0)", color: "#fff", fontWeight: 700, fontSize: 13, padding: "4px 8px", margin: 2, display: "flex", alignItems: "center", gap: 6 }}>
              <span>Как играть</span>
              <button onClick={() => setRules(false)} style={{ marginLeft: "auto", WebkitAppearance: "none", appearance: "none", borderRadius: 0, width: 24, height: 20, background: "#c0c0c0", color: "#000", border: "none", fontWeight: 700, fontSize: 12, cursor: "pointer", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" }}>✕</button>
            </div>
            <div style={{ padding: "10px 12px 14px", fontSize: 13, color: "#000", lineHeight: 1.7, fontFamily: "'Montserrat', sans-serif" }}>
              Веди змейку свайпами по полю или стрелками. Собирай предметы, каждый ненадолго меняет игру:
              <div style={{ height: 8 }} />
              🔴 ягода растит и даёт очки<br/>
              🍄 гриб замедляет<br/>
              🌵 кактус разгоняет и удлиняет<br/>
              🟪 марка переворачивает управление<br/>
              💊 таблетка притягивает еду<br/>
              🌿 каннабис даёт двойные очки
              <div style={{ height: 8 }} />
              Много сильных эффектов подряд дают короткий передоз, змейка на секунду перестаёт слушаться. Врезаться можно только в саму себя, стены сквозные.
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function NavBar({ active, onChange, onJournalTab, onPrivacy, onMusic, onLocker, onGame }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return (
    <>
      {menuOpen && (
        <div onClick={() => setMenuOpen(false)} style={{ position:"fixed", inset:0, zIndex:140 }} />
      )}
      <nav style={{ position:"fixed", bottom:0, left:0, right:0, maxWidth:480, margin:"0 auto",
        background:"#008080", zIndex:150,
        paddingLeft:"max(env(safe-area-inset-left, 0px), 6px)", paddingRight:"max(env(safe-area-inset-right, 0px), 6px)",
        paddingBottom:"calc(3px + max(env(safe-area-inset-bottom, 0px), var(--sab, 0px)))" }}>
        <div style={{ background:"var(--surface)", boxShadow:"inset 0 1px #fff, inset 0 2px #dfdfdf",
          borderTop:"1px solid #808080", display:"flex", alignItems:"stretch", gap:3, padding:3 }}>

        <div style={{ position:"relative", flex:"0 0 auto", display:"flex" }}>
          <button onClick={() => setMenuOpen(o => !o)} style={{ display:"flex", alignItems:"center", gap:5,
            padding:"0 8px", background:"var(--surface)", border:"none", cursor:"pointer",
            boxShadow: menuOpen ? "var(--sunken)" : "var(--raised)", fontWeight:700, fontSize:13, color:"#000" }}>
            <svg width="16" height="14" viewBox="0 0 16 14" style={{ display:"block", flex:"0 0 auto" }}>
              <rect x="1" y="1" width="14" height="12" fill="#fff" stroke="#000" />
              <rect x="1" y="1" width="14" height="3.5" fill="#000080" />
              <rect x="3" y="6" width="10" height="1.4" fill="#000080" />
              <rect x="3" y="8.5" width="7" height="1.4" fill="#000080" />
            </svg>
            Пуск
          </button>
          {menuOpen && (
            <div style={{ position:"absolute", left:0, bottom:"calc(100% + 6px)", width:230, zIndex:160,
              background:"var(--surface)", boxShadow:"var(--raised)", display:"flex" }}>
              <div style={{ width:28, background:"linear-gradient(#000080, #1084d0)", color:"#fff",
                display:"flex", alignItems:"center", justifyContent:"center", padding:"8px 0" }}>
                <span style={{ writingMode:"vertical-rl", transform:"rotate(180deg)",
                  fontWeight:700, fontSize:13, letterSpacing:"1px", whiteSpace:"nowrap" }}>Заметки психонавта</span>
              </div>
              <div style={{ flex:1, padding:3 }}>
                <div onClick={() => { setMenuOpen(false); if (onLocker) onLocker(); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>Черновики</div>
                {NAV.map(({ id, label }) => (
                  <div key={id} onClick={() => { setMenuOpen(false); onChange(id); }}
                    style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>{label}</div>
                ))}
                <div onClick={() => { setMenuOpen(false); if (onMusic) onMusic(); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>Музыка</div>
                <div onClick={() => { setMenuOpen(false); if (onGame) onGame(); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>Змейка</div>
                <div style={{ height:2, background:"#808080", borderBottom:"1px solid #fff", margin:"3px 2px" }} />
                <div onClick={() => { setMenuOpen(false); if (onPrivacy) onPrivacy(); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>Конфиденциальность</div>
                <div onClick={() => { setMenuOpen(false); setFeedback(true); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>Обратная связь</div>
                <div onClick={() => { setMenuOpen(false); setAbout(true); }}
                  style={{ padding:"8px 10px", fontSize:13, cursor:"pointer", color:"#000" }}>О программе</div>
              </div>
            </div>
          )}
        </div>

        {NAV.map(({ id, label, icon }) => (
          <button key={id} onClick={() => { setMenuOpen(false); onChange(id); }} style={{ flex:1, minWidth:0,
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, padding:"6px 0 4px",
            background:"var(--surface)", boxShadow: active===id ? "var(--sunken)" : "var(--raised)",
            color: active===id ? "#000080" : "#000", fontSize:7, fontWeight:700,
            letterSpacing:"0", textTransform:"uppercase" }}>
            {icon}<span style={{ maxWidth:"100%", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{label}</span>
          </button>
        ))}

        <div style={{ flex:"0 0 auto", display:"flex", alignItems:"center", padding:"0 8px",
          background:"var(--surface)", boxShadow:"var(--sunken)", fontSize:12, color:"#000" }}>{time}</div>
        </div>
      </nav>

      {about && (
        <MessageBox title="О программе"
          message="Заметки психонавта это инструмент интеграции психоделического опыта."
          confirmLabel="OK" onConfirm={() => setAbout(false)} onCancel={() => setAbout(false)} />
      )}

      {feedback && (
        <div onClick={() => setFeedback(false)} style={{ position:"fixed", inset:0, zIndex:2000,
          background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div onClick={e => e.stopPropagation()} style={{ width:"100%", maxWidth:340, background:"var(--surface)", boxShadow:"var(--raised)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              background:"linear-gradient(90deg,#000080,#1084d0)", color:"#fff", padding:"3px 4px 3px 6px",
              margin:2, fontWeight:700, fontSize:12 }}>
              <span>Обратная связь</span>
              <button onClick={() => setFeedback(false)} style={{ width:18, height:16, fontSize:11, lineHeight:"12px",
                background:"var(--surface)", color:"#000", border:"none", cursor:"pointer", boxShadow:"var(--raised)" }}>✕</button>
            </div>
            <div style={{ fontSize:12, color:"#000", lineHeight:1.5, padding:"14px 14px 6px" }}>С вопросами и предложениями заходи в чат или пиши на почту:</div>
            <div style={{ padding:"0 14px 8px" }}>
              <button onClick={() => {
                  const url = "https://t.me/+vlYSBmQQiVY5NTYy";
                  const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
                  if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
                  else if (tg && tg.openLink) tg.openLink(url);
                  else window.open(url, "_blank");
                }}
                style={{ display:"block", width:"100%", textAlign:"center", boxSizing:"border-box", WebkitAppearance:"none", appearance:"none", borderRadius:0,
                  background:"var(--surface)", boxShadow:"var(--raised)", border:"none", cursor:"pointer",
                  color:"#000", padding:"10px 12px", marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#000080" }}>Чат пользователей</div>
              </button>
              <a href="mailto:dostoevskifm@tutanota.com" target="_blank" rel="noreferrer"
                style={{ display:"block", width:"100%", textAlign:"center", boxSizing:"border-box",
                  background:"var(--surface)", boxShadow:"var(--raised)", textDecoration:"none",
                  color:"#000", padding:"10px 12px", marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#000080" }}>dostoevskifm@tutanota.com</div>
              </a>
            </div>
            <div style={{ display:"flex", justifyContent:"center", padding:"4px 14px 14px" }}>
              <button onClick={() => setFeedback(false)} style={{ minWidth:90, padding:"6px 14px", fontWeight:700, fontSize:13,
                background:"var(--surface)", color:"#000", border:"none", cursor:"pointer", boxShadow:"var(--raised)" }}>OK</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── SESSION FLOW ──────────────────────────────────────────────────────────────
// Steps: cover → intention → after72 → modes → facets(6) → difficult → longterm

// Step 0: Cover
function StepCover({ data, onChange, onNext }) {
  const [form, setForm] = useState(data);
  const f = (k, v) => {
    const updated = { ...form, [k]: v };
    setForm(updated);
    onChange(updated);
  };
  const s = form;

  return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>НОВАЯ СЕССИЯ</SectionTitle>
      </div>
      <Sub>{new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" })}</Sub>
      <ProgressBar current={0} />

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <Label>Вещество или практика</Label>
          <WinSelect value={s.substance||""} onChange={v => f("substance", v)}
            options={["Аяваска","Псилоцибин","МДМА","ЛСД","5-MeO-DMT","ДМТ","Ибогаин","Мескалин","Сан Педро","Мухомор","Холотропное дыхание","Другое"]} />
          {s.substance === "Другое" && (
            <input type="text" placeholder="напиши что именно"
              value={s.substance_other||""}
              onChange={e => f("substance_other", e.target.value)}
              style={{ marginTop:8 }} />
          )}
        </div>
        <div>
          <Label>Дозировка</Label>
          <input type="text" placeholder="например: 3г сухих" value={s.dose||""} onChange={e => f("dose", e.target.value)} />
        </div>
        <div>
          <Label>Место</Label>
          <input type="text" placeholder="где происходит опыт" value={s.place||""} onChange={e => f("place", e.target.value)} />
        </div>
        <div>
          <Label>Кто будет рядом?</Label>
          <input type="text" placeholder="имя или описание" value={s.companion||""} onChange={e => f("companion", e.target.value)} />
        </div>
        <div>
          <Label>Моё состояние сейчас</Label>
          <textarea rows={3} placeholder="физическое и эмоциональное состояние прямо сейчас"
            value={s.state_now||""} onChange={e => f("state_now", e.target.value)} />
        </div>
        <div>
          <Label>Что меня беспокоит или пугает?</Label>
          <textarea rows={3} placeholder="необязательно, но полезно записать"
            value={s.fears||""} onChange={e => f("fears", e.target.value)} />
        </div>

        <QuoteBox>
          Один трип может изменить всё. Интеграция это то, что делает это изменение реальным.
        </QuoteBox>

        <Btn onClick={onNext} disabled={!s.substance}>Далее →</Btn>
      </div>
    </Screen>
  );
}

// Step 1: Intention
function StepIntention({ data, onChange, onNext, onBack }) {
  const s = data;
  const f = (k, v) => onChange({ ...s, [k]: v });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>НАМЕРЕНИЕ</SectionTitle>
      </div>
      <Sub>Намерение это вопрос с которым ты входишь. Направление внимания.</Sub>

      <ProgressBar current={1} />

      <div style={{ fontSize:11, color:"#333", marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>🎤 можно диктовать через микрофон на клавиатуре</div>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <Label required>С каким вопросом или запросом я вхожу в этот опыт?</Label>
          <textarea rows={4} placeholder="Что важно прямо сейчас. Зачем ты здесь."
            value={s.intention_main||""} onChange={e => f("intention_main", e.target.value)} />
        </div>
        <div>
          <Label>Что я хочу отпустить?</Label>
          <textarea rows={3} placeholder="что мешает, тяготит, пора оставить"
            value={s.intention_release||""} onChange={e => f("intention_release", e.target.value)} />
        </div>
        <div>
          <Label>Что я хочу понять или увидеть?</Label>
          <textarea rows={3} placeholder="инсайт, понимание, ответ на вопрос"
            value={s.intention_see||""} onChange={e => f("intention_see", e.target.value)} />
        </div>

        <QuoteBox>
          Намерение не управляет опытом. Но оно задаёт контекст. Поставь, и отпусти.
        </QuoteBox>

        <Btn onClick={onNext} disabled={!s.intention_main?.trim()}>Далее →</Btn>
      </div>
    </Screen>
  );
}

// Step 2: After 72h
function StepAfter72({ data, onChange, onNext, onSkip, onBack }) {
  const s = data;
  const f = (k, v) => onChange({ ...s, [k]: v });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>СРАЗУ ПОСЛЕ</SectionTitle>
      </div>
      <Sub>Первые 72 часа, самое свежее и уязвимое время. Пиши как попало: обрывками, образами, словами. Главное, зафикси пока не растворилось.</Sub>

      <ProgressBar current={2} />

      <div style={{ fontSize:11, color:"#333", marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>🎤 можно диктовать через микрофон на клавиатуре</div>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <Label>Что было самым ярким? Образы, ощущения, слова которые пришли?</Label>
          <textarea rows={5} placeholder="без структуры, без редактуры, всё что помнишь"
            value={s.after_vivid||""} onChange={e => f("after_vivid", e.target.value)} />
        </div>
        <div>
          <Label>Что я чувствую прямо сейчас, в теле, в эмоциях?</Label>
          <textarea rows={4} placeholder="тело знает, доверяй ему"
            value={s.after_feeling||""} onChange={e => f("after_feeling", e.target.value)} />
        </div>
        <div>
          <Label>Как опыт откликнулся на моё намерение?</Label>
          <textarea rows={4} placeholder="пришло ли то, что искал, или что-то совсем другое"
            value={s.after_intention||""} onChange={e => f("after_intention", e.target.value)} />
        </div>
        <div>
          <Label>Что осталось непонятным или незавершённым?</Label>
          <textarea rows={4} placeholder="что ещё ищет своего места"
            value={s.after_open||""} onChange={e => f("after_open", e.target.value)} />
        </div>

        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none", borderRadius:12, padding:14 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:T.muted, marginBottom:8 }}>
            Свободная запись
          </div>
          <textarea rows={5} placeholder="символы, образы которые хочется зафиксировать, всё что не вошло выше"
            value={s.after_free||""} onChange={e => f("after_free", e.target.value)} />
        </div>

        <QuoteBox>
          Не торопись с интерпретацией. Трудный опыт не обязан немедленно иметь смысл.
        </QuoteBox>

        <Btn onClick={onNext}>Далее → Сложный опыт</Btn>
        <Btn variant="ghost" onClick={onSkip} style={{ marginTop:10 }}>Пропустить сложный опыт</Btn>
      </div>
    </Screen>
  );
}

// Step 3: Modes
const MODE_SCALES = [
  {
    id: "contemplate_express",
    question: "Как ты предпочитаешь работать с опытом?",
    left: { label: "Созерцание", desc: "думаю внутри, наблюдаю, осмысляю" },
    right: { label: "Выражение", desc: "пишу, говорю\nрисую, пою" },
  },
  {
    id: "inside_outside",
    question: "Куда направлено твоё внимание?",
    left: { label: "Внутрь", desc: "тишина, одиночество\nвнутренний разговор" },
    right: { label: "Наружу", desc: "общение, сообщество\nживые встречи" },
  },
  {
    id: "create_receive",
    question: "Как ты хочешь работать с материалом?",
    left: { label: "Творчество", desc: "рисую, пишу\nделаю руками" },
    right: { label: "Восприятие", desc: "читаю, слушаю\nсмотрю, впитываю" },
  },
  {
    id: "conscious_unconscious",
    question: "С чем ты работаешь?",
    left: { label: "Сознательное", desc: "анализирую, осмысляю\nструктурирую" },
    right: { label: "Бессознательное", desc: "сны, образы\nинтуиция" },
  },
  {
    id: "care_challenge",
    question: "Что тебе нужно прямо сейчас?",
    left: { label: "Забота о себе", desc: "бережно, без давления\nв своём темпе" },
    right: { label: "Вызов себе", desc: "идти глубже\nне избегать сложного" },
  },
  {
    id: "active_rest",
    question: "Как ты лучше интегрируешь?",
    left: { label: "Активность", desc: "движение, практики\nдействия" },
    right: { label: "Покой", desc: "тишина, сон\nпауза" },
  },
];

function ModeSlider({ scale, value, onChange }) {
  const val = value ?? 5;
  return (
    <div style={{ background:"var(--surface)", padding:14,
      boxShadow:"var(--raised)", marginBottom:12 }}>
      <div style={{ fontSize:12, color:T.muted, marginBottom:10, lineHeight:1.5,
        fontFamily:"'Montserrat', sans-serif", fontStyle:"italic" }}>
        {scale.question}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8, gap:4 }}>
        <div style={{ width:"42%" }}>
          <div style={{ fontWeight:700, fontSize:12, color: val <= 4 ? T.accent : T.ink,
            fontFamily:"'Montserrat', sans-serif", marginBottom:2 }}>
            {scale.left.label}
          </div>
          <div style={{ fontSize:10, color:T.muted, lineHeight:1.4,
            fontFamily:"'Montserrat', sans-serif", whiteSpace:"pre-line" }}>
            {scale.left.desc}
          </div>
        </div>
        <div style={{ width:"42%", textAlign:"right" }}>
          <div style={{ fontWeight:700, fontSize:12, color: val >= 7 ? T.accent : T.ink,
            fontFamily:"'Montserrat', sans-serif", marginBottom:2 }}>
            {scale.right.label}
          </div>
          <div style={{ fontSize:10, color:T.muted, lineHeight:1.4,
            fontFamily:"'Montserrat', sans-serif", whiteSpace:"pre-line" }}>
            {scale.right.desc}
          </div>
        </div>
      </div>
      <input type="range" min="1" max="10" step="1" value={val}
        onChange={e => onChange(parseInt(e.target.value))}
        style={{ width:"100%", accentColor:T.accent, cursor:"pointer" }} />
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
        <span style={{ fontSize:9, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>1</span>
        <span style={{ fontSize:10, color:T.accent, fontWeight:700,
          fontFamily:"'Montserrat', sans-serif" }}>{val}</span>
        <span style={{ fontSize:9, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>10</span>
      </div>
    </div>
  );
}

function StepModes({ data, onChange, onNext, onBack }) {
  const s = data;
  const scales = s.mode_scales || {};
  const setScale = (id, val) => onChange({ ...s, mode_scales: { ...scales, [id]: val } });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>МОИ РЕЖИМЫ</SectionTitle>
      </div>
      <ProgressBar current={4} />

      <div style={{ fontSize:13, color:T.mid, marginBottom:16, lineHeight:1.6,
        fontFamily:"'Montserrat', sans-serif" }}>
        Каждый человек интегрирует по-своему. Отметь где ты находишься прямо сейчас на каждой шкале.
      </div>

      {MODE_SCALES.map(scale => (
        <ModeSlider key={scale.id} scale={scale}
          value={scales[scale.id]}
          onChange={val => setScale(scale.id, val)} />
      ))}

      <div style={{ marginTop:8, marginBottom:20 }}>
        <Label>Что это говорит тебе о том, как работать с этими заметками прямо сейчас?</Label>
        <textarea rows={4}
          placeholder="нет правильных ответов, есть те, которые честны для тебя прямо сейчас"
          value={s.modes_reflection||""}
          onChange={e => onChange({ ...s, modes_reflection: e.target.value })} />
      </div>

      <Btn onClick={onNext}>Далее →</Btn>
    </Screen>
  );
}

// Step 4: Facets navigator
function StepFacetsNav({ data, onFacet, onNext, onSkip, onBack }) {
  const facetsDone = data.facets_done || [];

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>ШЕСТЬ ГРАНЕЙ</SectionTitle>
      </div>
      <Sub>Работай со всеми шестью, или с теми которые откликаются прямо сейчас. Нет правильного порядка.</Sub>

      <ProgressBar current={5} />

      <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
        {FACET_ORDER.map(key => {
          const f = T.facets[key] || { color: T.accent, bg: T.light, label: key };
          const done = facetsDone.includes(key);
          const answers = data.facets?.[key] || {};
          const filled = FACET_QUESTIONS[key].filter((_, i) => answers[i]?.trim()).length;
          const total = FACET_QUESTIONS[key].length;
          return (
            <button key={key} onClick={() => onFacet(key)} style={{
              background: "var(--surface)",
              boxShadow: "var(--raised)",
              border: "none", padding:"12px 14px", cursor:"pointer",
              display:"flex", justifyContent:"space-between", alignItems:"center",
              width:"100%", textAlign:"left",
            }}>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, fontWeight:700, fontSize:15, color: done ? f.color : T.ink, fontFamily:"'Montserrat', sans-serif" }}>
                    <Folder open={done} />
                    {f.label}
                  </div>
                  <span style={{ fontSize:18, color: done ? f.color : T.light, marginLeft:8 }}>
                    {done ? "✓" : "›"}
                  </span>
                </div>
                {filled > 0 ? (
                  <div style={{ marginTop:6 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                      <div style={{ fontSize:10, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>
                        {filled} из {total}
                      </div>
                      <div style={{ fontSize:10, color: f.color, fontWeight:600, fontFamily:"'Montserrat', sans-serif" }}>
                        {Math.round(filled/total*100)}%
                      </div>
                    </div>
                    <div style={{ height:6, background:"#fff", boxShadow:"var(--sunken)" }}>
                      <div style={{ height:"100%", width:`${filled/total*100}%`, background:f.color }} />
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize:11, color:T.muted, marginTop:2, fontFamily:"'Montserrat', sans-serif" }}>
                    {total} вопросов
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <Btn onClick={onNext}>Далее →</Btn>
    </Screen>
  );
}

// Step 4b: Single facet
function StepFacet({ facetKey, data, onChange, onDone }) {
  const f = T.facets[facetKey] || { color: T.accent, bg: "#fff0f0", label: facetKey };
  const questions = FACET_QUESTIONS[facetKey] || [];
  const answers = data.facets?.[facetKey] || {};
  const setAnswer = (i, v) => {
    onChange({
      ...data,
      facets: { ...data.facets, [facetKey]: { ...answers, [i]: v } },
      facets_done: [...(data.facets_done||[]).filter(x=>x!==facetKey),
        Object.keys({...answers,[i]:v}).some(k=>({...answers,[i]:v})[k]?.trim()) ? facetKey : undefined
      ].filter(Boolean),
    });
  };

  return (
    <Screen>
      <BackBtn onClick={onDone} />
      <div style={{ marginBottom:8 }}><FacetTag facet={facetKey} /></div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={26} />
        <SectionTitle size={30}>{f.label.toUpperCase()}</SectionTitle>
      </div>
      {FACET_SUBTITLES[facetKey] && (
        <Sub>{FACET_SUBTITLES[facetKey]}</Sub>
      )}
      <FacetProgress facetKey={facetKey} answers={answers} />
      <div style={{ height:8 }} />

      <div style={{ fontSize:11, color:"#333", marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>🎤 можно диктовать через микрофон на клавиатуре</div>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        {questions.map((q, i) => (
          <div key={i}>
            <Label>{q}</Label>
            <textarea rows={4} placeholder="пиши что приходит"
              value={answers[i]||""} onChange={e => setAnswer(i, e.target.value)} />
          </div>
        ))}

        <div style={{ background:"#f8f6f3", border:`1.5px solid ${T.light}`, borderRadius:12, padding:14 }}>
          <Label>Свободная запись</Label>
          <textarea rows={4} placeholder="всё что не вошло в вопросы выше"
            value={answers["free"]||""} onChange={e => setAnswer("free", e.target.value)} />
        </div>

        <Btn onClick={onDone} style={{ background:f.color }}>Сохранить и вернуться</Btn>
      </div>
    </Screen>
  );
}

// Step 5: Difficult
function StepDifficult({ data, onChange, onNext, onBack }) {
  const s = data;
  const f = (k, v) => onChange({ ...s, [k]: v });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={24} />
        <SectionTitle size={28}>СЛОЖНЫЙ ОПЫТ</SectionTitle>
      </div>
      <Sub>Если опыт был тяжёлым, эти страницы для тебя. Если опыт не кажется тебе сложным этот раздел заполнять не нужно.</Sub>

      <ProgressBar current={3} />

      <div style={{ fontSize:11, color:"#333", marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>🎤 можно диктовать через микрофон на клавиатуре</div>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <Label>Что именно было тяжёлым?</Label>
          <textarea rows={4} placeholder="опиши как можешь"
            value={s.diff_what||""} onChange={e => f("diff_what", e.target.value)} />
        </div>
        <div>
          <Label>Что ты чувствуешь сейчас когда вспоминаешь это?</Label>
          <textarea rows={4} placeholder="в теле, в эмоциях"
            value={s.diff_feel||""} onChange={e => f("diff_feel", e.target.value)} />
        </div>
        <div>
          <Label>Есть ли в этом опыте что-то что может иметь ценность, даже если сейчас это неочевидно?</Label>
          <textarea rows={4} placeholder="трудное не значит плохое"
            value={s.diff_value||""} onChange={e => f("diff_value", e.target.value)} />
        </div>
        <div>
          <Label>Что помогает тебе прямо сейчас?</Label>
          <textarea rows={3} placeholder="заземление, тишина, человек рядом..."
            value={s.diff_helps||""} onChange={e => f("diff_helps", e.target.value)} />
        </div>
        <div>
          <Label>Есть ли человек которому ты можешь написать или позвонить прямо сейчас?</Label>
          <input type="text" placeholder="имя или контакт"
            value={s.diff_contact||""} onChange={e => f("diff_contact", e.target.value)} />
        </div>

        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none", borderRadius:14, padding:16 }}>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:15, color:T.accent, letterSpacing:"0.01em", whiteSpace:"nowrap", marginBottom:8 }}>
            ЕСЛИ ПРЯМО СЕЙЧАС ОЧЕНЬ ТЯЖЕЛО
          </div>
          <div style={{ fontSize:13, color:T.mid, lineHeight:1.6, marginBottom:14, fontFamily:"'Montserrat', sans-serif" }}>
            Ты не один в этом. Поддержка рядом.
          </div>
          <a href="https://ayawaskaretreat.com/ru/integration" target="_blank" rel="noopener noreferrer"
            onClick={(e) => {
              const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
              if (tg && tg.openLink) { e.preventDefault(); tg.openLink("https://ayawaskaretreat.com/ru/integration"); }
            }}
            style={{ display:"block", background:"var(--surface)", boxShadow:"var(--raised)",
            color:"#000080", padding:"13px", textDecoration:"none",
            fontWeight:700, fontSize:14, textAlign:"center", fontFamily:"'Montserrat', sans-serif" }}>
            ayawaskaretreat.com → Интеграция
          </a>
        </div>

        <Btn onClick={onNext}>Далее →</Btn>
      </div>
    </Screen>
  );
}

// Step 6: Long-term

// ── Period Accordion ──────────────────────────────────────────────────────────
const PERIODS = [
  ["week",  "Первая неделя",    "Нейропластическое окно открыто, самое продуктивное время."],
  ["month", "Первый месяц",     "Видно что реально изменилось, а что просто казалось."],
  ["three", "Три месяца",       "Паттерны стабилизируются, долгосрочные сдвиги видны."],
  ["year",  "Полгода и дальше", "Глубокие изменения проявляются именно здесь."],
];

const LONGTERM_QUESTIONS = [
  ["q1","Как инсайты из опыта живут в моей жизни прямо сейчас?"],
  ["q2","Что изменилось с момента опыта, в мышлении, в отношениях, в действиях?"],
  ["q3","Что ещё не изменилось, но хочется изменить?"],
  ["q4","Моё новое намерение на следующий период:"],
];

function PeriodAccordion({ entries, onChange, canFinish }) {
  const [open, setOpen] = useState(null);
  const [confirmPid, setConfirmPid] = useState(null);

  function finishPeriod(pid) {
    const ex = entries.find(e => e.period === pid);
    let next;
    if (ex) next = entries.map(e => e.period === pid ? { ...e, done: true } : e);
    else next = [...entries, { period: pid, date: new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" }), q1:"", q2:"", q3:"", q4:"", done: true }];
    onChange(next);
  }

  function setField(pid, key, val) {
    const existing = entries.find(e => e.period === pid);
    if (existing && existing.done) return;
    let next;
    if (existing) {
      next = entries.map(e => e.period === pid ? { ...e, [key]: val } : e);
    } else {
      next = [...entries, {
        period: pid,
        date: new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" }),
        q1:"", q2:"", q3:"", q4:"", [key]: val
      }];
    }
    onChange(next);
  }

  const RAISED = "inset -1px -1px #000, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff";
  const PRESSED = "inset 1px 1px #000, inset -1px -1px #dfdfdf, inset 2px 2px #808080, inset -2px -2px #fff";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {PERIODS.map(([pid, label, hint]) => {
        const entry = entries.find(e => e.period === pid) || {};
        const hasContent = entry.q1||entry.q2||entry.q3||entry.q4;
        const isOpen = open === pid;
        return (
          <div key={pid}>
            {/* Строка-папка */}
            <button onClick={() => setOpen(isOpen ? null : pid)}
              style={{ width:"100%", cursor:"pointer", textAlign:"left",
                padding:"8px 10px", display:"flex", alignItems:"center", gap:10,
                background:"#c0c0c0", color:"#000", border:"none",
                boxShadow: isOpen ? PRESSED : RAISED }}>
              <Folder open={isOpen} size={20} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:14, lineHeight:1.15 }}>{label}</div>
                {!isOpen && (
                  <div style={{ fontSize:11, color:"#555", marginTop:1,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{hint}</div>
                )}
              </div>
              {hasContent && (
                <span style={{ fontSize:11, color:"#107c10", fontWeight:700, flexShrink:0 }}>✓</span>
              )}
              <span style={{ fontWeight:700, fontSize:15, flexShrink:0, width:14, textAlign:"center" }}>{isOpen ? "\u2212" : "+"}</span>
            </button>

            {/* Раскрытие, окно Win95 */}
            {isOpen && (
              <div style={{ marginTop:4, background:"#c0c0c0", boxShadow: RAISED }}>
                <div style={{ display:"flex", alignItems:"center", gap:6,
                  background:"linear-gradient(90deg,#000080,#1084d0)", color:"#fff",
                  padding:"3px 6px", margin:2, fontWeight:700, fontSize:12 }}>
                  <Folder open size={14} />
                  <span style={{ flex:1 }}>{label}</span>
                </div>
                <div style={{ padding:"10px 12px 12px" }}>
                  <div style={{ fontSize:11, color:"#333", marginBottom:12, lineHeight:1.5 }}>{hint}</div>
                  {LONGTERM_QUESTIONS.map(([key, q]) => (
                    <div key={key} style={{ marginBottom:12 }}>
                      <Label>{q}</Label>
                      <textarea rows={3} placeholder="пиши честно"
                        value={entry[key]||""} disabled={entry.done}
                        onChange={e => setField(pid, key, e.target.value)} />
                    </div>
                  ))}
                  {entry.done ? (
                    <div style={{ fontSize:11, color:"#107c10", fontWeight:700, textAlign:"right", marginTop:4 }}>✓ период завершён</div>
                  ) : (canFinish && hasContent) ? (
                    confirmPid === pid ? (
                      <MessageBox title="Завершить период"
                        message="После завершения этот период изменить будет нельзя, и это откроет новый разбор. Завершить?"
                        confirmLabel="Завершить" cancelLabel="Отмена"
                        onConfirm={() => { finishPeriod(pid); setConfirmPid(null); }}
                        onCancel={() => setConfirmPid(null)} />
                    ) : (
                      <Btn onClick={() => setConfirmPid(pid)} style={{ marginTop:4 }}>Завершить период</Btn>
                    )
                  ) : hasContent ? (
                    <div style={{ fontSize:10, color:"#107c10", textAlign:"right", marginTop:4 }}>✓ сохранено</div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepLongterm({ data, onChange, onFinish, onFinishFree, onBack, isPremium, onUpgrade }) {
  const s = data;
  const [confirmFinish, setConfirmFinish] = useState(false);
  const entries = s.longterm || [{ date: new Date().toLocaleDateString("ru-RU"), q1:"", q2:"", q3:"", q4:"" }];
  const setEntry = (i, k, v) => {
    const next = entries.map((e, idx) => idx===i ? { ...e, [k]:v } : e);
    onChange({ ...s, longterm: next });
  };
  const addEntry = () => onChange({ ...s, longterm: [...entries, { date: new Date().toLocaleDateString("ru-RU"), q1:"", q2:"", q3:"", q4:"" }] });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={18} />
        <div style={{ fontSize:18, fontWeight:700, letterSpacing:"0.02em", color:"#000", lineHeight:1.05, whiteSpace:"nowrap" }}>ДОЛГОСРОЧНАЯ ИНТЕГРАЦИЯ</div>
      </div>
      <Sub>Глубокие изменения проявляются со временем. Возвращайся к этим вопросам по расписанию ниже.</Sub>

      <ProgressBar current={7} />

      <PeriodAccordion
        entries={entries}
        onChange={(next) => onChange({ ...s, longterm: next })}
      />


        <div style={{ height:8 }} />
        {confirmFinish ? (
          <MessageBox title="Завершить сессию"
            message="После завершения данные сессии изменить будет нельзя. Дописывать можно будет только в долгосрочную интеграцию по периодам. Завершить?"
            confirmLabel="Завершить" cancelLabel="Отмена"
            onConfirm={onFinishFree} onCancel={() => setConfirmFinish(false)} />
        ) : (
          <Btn onClick={() => setConfirmFinish(true)}>Завершить</Btn>
        )}
    </Screen>
  );
}



// ── Integration Analysis ──────────────────────────────────────────────────────
function IntegrationAnalysis({ data, isPremium, onUpgrade }) {
  const [status, setStatus] = useState(data.integrationAnalysis ? "done" : "idle");
  const [result, setResult] = useState(data.integrationAnalysis || "");

  const hasEntries = data.longterm && data.longterm.some(e =>
    e.q1?.trim() || e.q2?.trim() || e.q3?.trim() || e.q4?.trim()
  );

  if (!hasEntries) return null;

  async function handleAnalyze() {
    if (!isPremium) { onUpgrade(); return; }
    setStatus("loading");
    try {
      const entries = (data.longterm || []).map((e, i) =>
        `[${e.date || "Запись " + (i+1)}]\n` +
        (e.q1 ? `Как живут инсайты: ${e.q1}\n` : "") +
        (e.q2 ? `Что изменилось: ${e.q2}\n` : "") +
        (e.q3 ? `Что не изменилось: ${e.q3}\n` : "") +
        (e.q4 ? `Новое намерение: ${e.q4}\n` : "")
      ).join("\n");

      const prompt = `Ты, инструмент психоделической интеграции. Человек ведёт дневник интеграции после психоделического опыта. Прочитай его записи во времени и напиши короткий анализ (200-300 слов):

– Что меняется со временем, а что остаётся на месте
– Какие паттерны повторяются в разных записях
– Что кажется незавершённым или требует внимания
– Один вопрос для углубления

Будь честным зеркалом, не давай советов. Пиши на русском языке.

ЗАПИСИ ИНТЕГРАЦИИ:
${entries}`;

      const response = await fetchT(`${API_BASE}/analyze`, {
        timeout: 60000,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, initData: tgInitData() }),
      });
      if (!response.ok) throw new Error("API error");
      const json = await response.json();
      const text = json.text || "Не удалось получить анализ.";
      setResult(text);
      data.integrationAnalysis = text;
      setStatus("done");
    } catch (e) {
      setStatus("error");
    }
  }

  return (
    <div style={{ marginTop:8 }}>
      {status === "idle" && (
        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none",
          borderRadius:14, padding:18, textAlign:"center" }}>
          <div style={{ fontSize:24, marginBottom:8 }}>◎</div>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16,
            letterSpacing:"0.06em", color:T.ink, marginBottom:8 }}>
            АНАЛИЗ ИНТЕГРАЦИИ
          </div>
          <div style={{ fontSize:12, color:T.mid, lineHeight:1.6, marginBottom:14,
            fontFamily:"'Montserrat', sans-serif" }}>
            Claude прочитает твои записи интеграции и покажет динамику, что меняется, что застряло, какие паттерны повторяются.
          </div>
          <Btn onClick={handleAnalyze}>
            {isPremium ? "Запросить анализ интеграции" : "Доступно в полной версии"}
          </Btn>
        </div>
      )}

      {status === "loading" && (
        <div style={{ background:"#c0c0c0", boxShadow:"var(--raised)", padding:18, textAlign:"center" }}>
          <HourGlass size={28} />
          <div style={{ fontWeight:700, fontSize:14, color:"#000", marginTop:8 }}>Обработка…</div>
          <div style={{ fontSize:12, color:"#555", marginTop:4 }}>Анализирую динамику твоих записей</div>
        </div>
      )}

      {status === "error" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ fontSize:13, color:T.accent, fontFamily:"'Montserrat', sans-serif",
            textAlign:"center" }}>
            Что-то пошло не так. Попробуй ещё раз.
          </div>
          <Btn onClick={handleAnalyze}>Попробовать снова</Btn>
        </div>
      )}

      {status === "done" && (
        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none",
          borderRadius:14, padding:18 }}>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:14,
            letterSpacing:"0.06em", color:T.accent, marginBottom:12 }}>
            АНАЛИЗ ИНТЕГРАЦИИ
          </div>
          <div style={{ fontSize:13, lineHeight:1.8, color:T.ink, whiteSpace:"pre-wrap",
            fontFamily:"'Montserrat', sans-serif" }}>
            {result}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 8: Self-rating ───────────────────────────────────────────────────────
function StepRating({ data, onChange, onFinish, onBack }) {
  const ratings = data.selfRatings || { mind:5, body:5, spirit:5, relations:5, nature:5, lifestyle:5 };
  const setRating = (k, v) => onChange({ ...data, selfRatings: { ...ratings, [k]: v } });

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        <Folder open size={20} />
        <SectionTitle size={22}>ОЦЕНКА ГРАНЕЙ</SectionTitle>
      </div>
      <Sub>Как ты ощущаешь каждую область жизни после этого опыта? Оцени честно это только для тебя.</Sub>
      <ProgressBar current={6} />

      <div style={{ display:"flex", flexDirection:"column", gap:16, marginBottom:24 }}>
        {FACET_KEYS.map(k => (
          <Card key={k}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <FacetIcon facet={k} size={20} />
                <div style={{ fontWeight:700, fontSize:14, color:T.ink, fontFamily:"'Montserrat', sans-serif" }}>
                  {FACET_LABELS[k]}
                </div>
              </div>
              <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:24,
                color:T.accent, lineHeight:1 }}>
                {ratings[k]}
              </div>
            </div>
            <input type="range" min={1} max={10} value={ratings[k]}
              onChange={e => setRating(k, Number(e.target.value))}
              style={{ width:"100%", accentColor:T.accent }} />
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
              <span style={{ fontSize:10, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>тяжело</span>
              <span style={{ fontSize:10, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>отлично</span>
            </div>
          </Card>
        ))}
      </div>

      <Btn onClick={onFinish}>Далее → Интеграция</Btn>
    </Screen>
  );
}

// ── Radar Chart (SVG) ─────────────────────────────────────────────────────────
function RadarChart({ datasets, size = 220 }) {
  const keys = FACET_KEYS;
  const n = keys.length;
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;

  // angles: start from top, go clockwise
  const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i, val, maxVal = 10) => {
    const a = angle(i);
    const dist = (val / maxVal) * r;
    return { x: cx + dist * Math.cos(a), y: cy + dist * Math.sin(a) };
  };
  const ptOuter = (i) => pt(i, 10);

  // grid circles
  const gridLevels = [2, 4, 6, 8, 10];

  const colors = ["#c0392b", "#1a6a8a", "#1a7a3e", "#6c3483", "#b8520a"];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Grid */}
      {gridLevels.map(lv => {
        const pts = keys.map((_, i) => pt(i, lv));
        const d = pts.map((p, i) => `${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + "Z";
        return <path key={lv} d={d} fill="none" stroke={T.light} strokeWidth={1} />;
      })}

      {/* Axes */}
      {keys.map((_, i) => {
        const o = ptOuter(i);
        return <line key={i} x1={cx} y1={cy} x2={o.x} y2={o.y} stroke={T.light} strokeWidth={1} />;
      })}

      {/* Data polygons */}
      {datasets.map((ds, di) => {
        const pts = keys.map((k, i) => pt(i, ds.ratings[k] || 0));
        const d = pts.map((p, i) => `${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + "Z";
        const col = colors[di % colors.length];
        return (
          <g key={di}>
            <path d={d} fill={col} fillOpacity={0.15} stroke={col} strokeWidth={2} />
            {pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={3} fill={col} />
            ))}
          </g>
        );
      })}

      {/* Labels */}
      {keys.map((k, i) => {
        const a = angle(i);
        const labelR = r + 22;
        const lx = cx + labelR * Math.cos(a);
        const ly = cy + labelR * Math.sin(a);
        return (
          <text key={k} x={lx} y={ly}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={9} fill={T.mid}
            fontFamily="'Montserrat', sans-serif" fontWeight="600">
            {FACET_LABELS[k]}
          </text>
        );
      })}
    </svg>
  );
}

// ── Tracker Page ──────────────────────────────────────────────────────────────
function TrackerPage({ sessions, isPremium, onUpgrade }) {

  // Demo data for preview when no sessions with ratings exist
  const demoSessions = sessions.length === 0 ? [{
    id:"demo", date:"Демо-сессия",
    selfRatings:{ mind:7, body:5, spirit:8, relations:4, nature:6, lifestyle:5 },
    claudeRatings:{ mind:6, body:4, spirit:7, relations:6, nature:5, lifestyle:4 },
  }] : sessions;

  if (!isPremium) return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadHex /><SectionTitle size={28} style={{ marginBottom: 0 }}>ТРЕКЕР ГРАНЕЙ</SectionTitle>
      </div>
      <Sub>Визуализация изменений по 6 областям жизни</Sub>
      <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", padding:24, textAlign:"center", marginTop:20 }}>
        <div style={{ fontSize:40, marginBottom:12 }}>⬡</div>
        <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:20,
          letterSpacing:"0.06em", color:T.ink, marginBottom:12 }}>
          ДОСТУПНО В ПОЛНОЙ ВЕРСИИ
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.6, marginBottom:20,
          fontFamily:"'Montserrat', sans-serif" }}>
          Трекер показывает как меняются твои оценки по 6 областям жизни от сессии к сессии.
          Два радара, твоя оценка и оценка Claude, чтобы увидеть расхождение.
        </div>
        <Btn onClick={onUpgrade}>Открыть полный доступ</Btn>
      </div>
    </Screen>
  );

  const rated = sessions.filter(s => s.selfRatings);
  const analyzed = sessions.filter(s => s.claudeRatings);

  if (rated.length === 0) return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadHex /><SectionTitle size={28} style={{ marginBottom: 0 }}>ТРЕКЕР ГРАНЕЙ</SectionTitle>
      </div>
      <Sub>Пока нет сессий с оценками. Завершите первую сессию чтобы увидеть радар.</Sub>
    </Screen>
  );

  // Show last session comparison + dynamics
  const last = rated[0];
  const selfDS = { label: "Твоя оценка", ratings: last.selfRatings };
  const claudeDS = last.claudeRatings ? { label: "Оценка Claude", ratings: last.claudeRatings } : null;

  return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadHex /><SectionTitle size={28} style={{ marginBottom: 0 }}>ТРЕКЕР ГРАНЕЙ</SectionTitle>
      </div>
      <Sub>Как меняются 6 областей твоей жизни</Sub>

      {/* Last session radar */}
      <Card style={{ alignItems:"center", display:"flex", flexDirection:"column" }}>
        <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:14,
          letterSpacing:"0.06em", color:T.accent, marginBottom:4 }}>
          {last.date}
        </div>

        <RadarChart datasets={claudeDS ? [selfDS, claudeDS] : [selfDS]} size={260} />

        {/* Legend */}
        <div style={{ display:"flex", gap:16, marginTop:8 }}>
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <div style={{ width:12, height:12, borderRadius:2, background:"#c0392b" }} />
            <span style={{ fontSize:11, color:T.mid, fontFamily:"'Montserrat', sans-serif" }}>
              Твоя оценка
            </span>
          </div>
          {claudeDS && (
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <div style={{ width:12, height:12, borderRadius:2, background:"#1a6a8a" }} />
              <span style={{ fontSize:11, color:T.mid, fontFamily:"'Montserrat', sans-serif" }}>
                Оценка Claude
              </span>
            </div>
          )}
        </div>

        {/* Scores table */}
        <div style={{ width:"100%", marginTop:16, display:"flex", flexDirection:"column", gap:6 }}>
          {FACET_KEYS.map(k => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"6px 8px", background:T.bg, borderRadius:8 }}>
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                <FacetIcon facet={k} size={16} />
                <span style={{ fontSize:12, color:T.mid, fontFamily:"'Montserrat', sans-serif" }}>
                  {FACET_LABELS[k]}
                </span>
              </div>
              <div style={{ display:"flex", gap:12 }}>
                <span style={{ fontSize:13, fontWeight:700, color:"#c0392b",
                  fontFamily:"'Montserrat', sans-serif" }}>
                  {last.selfRatings[k]}
                </span>
                {last.claudeRatings && (
                  <span style={{ fontSize:13, fontWeight:700, color:"#1a6a8a",
                    fontFamily:"'Montserrat', sans-serif" }}>
                    {last.claudeRatings[k]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Dynamics: multiple sessions */}
      {rated.length > 1 && (
        <div style={{ marginTop:20 }}>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16,
            letterSpacing:"0.06em", color:T.ink, marginBottom:12 }}>
            ДИНАМИКА
          </div>
          <div style={{ display:"flex", gap:12, overflowX:"auto", paddingBottom:8 }}>
            {rated.slice(0, 5).reverse().map((s, i) => (
              <div key={s.id} style={{ flexShrink:0, textAlign:"center" }}>
                <div style={{ fontSize:9, color:T.muted, marginBottom:4,
                  fontFamily:"'Montserrat', sans-serif" }}>
                  {s.date.split(" ").slice(0,2).join(" ")}
                </div>
                <RadarChart
                  datasets={[{ label:"", ratings: s.selfRatings }]}
                  size={100}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </Screen>
  );
}

// ── Journal: session detail (read) ────────────────────────────────────────────
// ── Claude Analysis ───────────────────────────────────────────────────────────

function buildPrompt(session, lockerThoughts = []) {
  const facetLabels = { mind:"Разум", body:"Тело", spirit:"Дух", relations:"Отношения", nature:"Природа", lifestyle:"Образ жизни" };
  const modeLabels = {
    contemplate_express: "Созерцание ↔ Выражение",
    inside_outside: "Внутрь ↔ Наружу",
    create_receive: "Творчество ↔ Восприятие",
    conscious_unconscious: "Сознательное ↔ Бессознательное",
    care_challenge: "Забота ↔ Вызов",
    alone_together: "Одиночество ↔ Вместе",
  };

  let text = `Ты инструмент психоделической интеграции. Твоя роль быть зеркалом, а не терапевтом, гуру или оракулом. Ты помогаешь человеку осмыслить то, что он сам записал о своём опыте, и не решаешь за него.

Ты опираешься на принципы психоделической интеграции из практики снижения вреда и сопровождения (ICEERS, MAPS, руководства Фадимана):
- Инсайт без интеграции угасает. Твоя задача не пересказать опыт, а помочь перевести его в конкретные, проживаемые изменения.
- Прозрения не стоит понимать буквально. Сильные послания вроде «уйти с работы» или «расстаться» часто не команда к действию, а язык бессознательного, который требует расшифровки. Приглашай вглядеться в смысл, а не торопиться действовать.
- Первые недели после опыта не время для необратимых решений. Исключение только отказ от того, что человеку явно вредит. Это не касается назначенных лекарств и лечения: их не отменяют по итогам опыта, это решает только врач.
- Трудное в опыте несёт ценность. К тяжёлым, пугающим, незавершённым местам стоит повернуться лицом и спросить, чему они учат, но без давления и без принуждения доработать через силу.
- Смысл живёт в теле, а не только в мыслях. Замечай телесные ощущения, дыхание, эмоции, а не одни идеи.
- Интеграция социальна. Важно, кто рядом, кто питает человека, а кто истощает.

Как ты работаешь:
- Говори только о том, что есть в тексте. Никаких домыслов, диагнозов и интерпретаций за пределами написанного.
- Не обещай результатов, не успокаивай дежурными фразами, не говори, что всё хорошо. Не используй клише «трансформация», «исцеление», «путешествие».
- Тон живой, уважительный, конкретный, на «ты». Не заканчивай мотивационными лозунгами.

МЕДИЦИНА, ЛЕКАРСТВА И БЕЗОПАСНОСТЬ. Эти правила важнее глубины разбора.
- Ты не врач и не даёшь медицинских советов. Если в тексте есть вопрос или намерение про лекарства (бросить или изменить приём антидепрессантов, снотворных, любых назначенных препаратов), про сочетание веществ, дозы, взаимодействия, противопоказания, беременность или диагнозы, ты не советуешь, что делать. Прямо скажи, что это медицинский вопрос и решается только с лечащим врачом или психиатром, и не бери ответ на себя.
- Прекращение или изменение приёма препаратов, особенно антидепрессантов, может быть опасным и всегда остаётся решением врача, а не выводом из опыта. Мягко удерживай от резких шагов и направляй к специалисту.
- Не давай инструкций по приёму, сочетанию, дозированию или добыче веществ, даже если просят совет на будущее.
- Если есть признаки острого кризиса, мысли о причинении себе вреда или суициде, ощущение, что человек не справляется или теряет опору в реальности, безопасность важнее разбора. Мягко назови это, не разбирай тяжёлый материал как терапию, не называй никаких способов навредить себе и направь к живой поддержке: близкий, которому можно доверять, кризисная линия, специалист, а в приложении раздел «Кризис».

УЧЁТ ВЕЩЕСТВА. Прими во внимание, какое вещество указано, потому что разные вещества дают разный опыт, и уместное для одного не подходит к другому. Не ставь диагнозов и не делай медицинских утверждений, просто учитывай характер вещества при чтении материала:
- Классические психоделики (псилоцибин, ЛСД, ДМТ, 5-MeO-DMT, мескалин, Сан Педро, аяваска, мухомор): часто перцептивные и смысловые прорывы, архетипический и телесный материал, возможны трудные и пугающие эпизоды. Интеграция про перевод инсайта в проживаемое.
- МДМА: чаще открытость, доверие, сострадание к себе, работа с привязанностью и травматическим материалом. Обращай внимание на отношения и бережность к себе.
- Ибогаин: длительный, интенсивный, часто автобиографический пересмотр жизни, особая опора на профессиональное сопровождение.
- Холотропное дыхание и практики без вещества: насыщенный телесный и эмоциональный материал без фармакологии.
Если вещество не указано или тебе незнакомо, разбирай по общим принципам, ничего не додумывая.

Структура ответа:
1. **Что я вижу.** Два-три абзаца: паттерны, противоречия, что повторяется и бросается в глаза. Только из текста.
2. **Намерение и реальность.** Как намерение, с которым человек заходил, соотносится с тем, что пришло, в том числе если они разошлись.
3. **Тело и трудное.** Что говорит телесный и эмоциональный материал и как бережно обойтись с трудными или незавершёнными местами.
4. **Перевод в жизнь.** Не совет, а приглашение: что из этого опыта просит маленького конкретного шага и где важно не спешить с большими решениями.
5. **Вопросы для углубления.** Три конкретных вопроса, выросших именно из его текста.

---

ДАННЫЕ СЕССИИ:

Вещество: ${session.substance || "не указано"}${session.substance_other ? ` (${session.substance_other})` : ""}
Дата: ${session.date || "не указана"}
`;

  // Step 1: Session setup
  if (session.dose) text += `
Доза: ${session.dose}`;
  if (session.place) text += `
Место: ${session.place}`;
  if (session.companion) text += `
Кто рядом: ${session.companion}`;
  if (session.state_now) text += `
Состояние перед опытом: ${session.state_now}`;
  if (session.fears) text += `
Страхи и беспокойства: ${session.fears}`;

  // Step 2: Intention
  if (session.intention_main) text += `

НАМЕРЕНИЕ: ${session.intention_main}`;
  if (session.intention_release) text += `
Что хотел отпустить: ${session.intention_release}`;
  if (session.intention_see) text += `
Что хотел увидеть: ${session.intention_see}`;

  // Step 3: After 72h
  if (session.after_vivid) text += `

СРАЗУ ПОСЛЕ, самое яркое: ${session.after_vivid}`;
  if (session.after_feeling) text += `
Ощущения в теле и эмоции: ${session.after_feeling}`;
  if (session.after_intention) text += `
Как откликнулось намерение: ${session.after_intention}`;
  if (session.after_open) text += `
Что осталось незавершённым: ${session.after_open}`;
  if (session.after_free) text += `
Свободная запись: ${session.after_free}`;

  // Step 4: Difficult experience
  if (session.diff_what || session.diff_feel || session.diff_value || session.diff_helps || session.diff_contact) {
    text += `

СЛОЖНЫЙ ОПЫТ:`;
    if (session.diff_what) text += `
Что было тяжёлым: ${session.diff_what}`;
    if (session.diff_feel) text += `
Что чувствует сейчас: ${session.diff_feel}`;
    if (session.diff_value) text += `
Возможная ценность трудного: ${session.diff_value}`;
    if (session.diff_helps) text += `
Что помогает: ${session.diff_helps}`;
    if (session.diff_contact) text += `
Есть кому написать или позвонить: ${session.diff_contact}`;
  }

  // Step 5: Modes (scales 1-10)
  const scales = session.mode_scales || {};
  const hasScales = Object.values(scales).some(v => v !== undefined);
  if (hasScales) {
    text += `

РЕЖИМЫ РАБОТЫ С ОПЫТОМ (шкала 1-10):`;
    Object.entries(scales).forEach(([id, val]) => {
      if (val !== undefined && modeLabels[id]) {
        text += `
${modeLabels[id]}: ${val}`;
      }
    });
  }
  if (session.modes_reflection) text += `
Рефлексия о режимах: ${session.modes_reflection}`;

  // Step 6: Facets
  const facets = session.facets || {};
  FACET_ORDER.forEach(key => {
    const answers = facets[key];
    if (!answers) return;
    const hasContent = Object.values(answers).some(v => v?.trim());
    if (!hasContent) return;
    text += `

ГРАНЬ, ${facetLabels[key]}:`;
    FACET_QUESTIONS[key].forEach((q, i) => {
      if (answers[i]?.trim()) text += `
${q}
→ ${answers[i]}`;
    });
    if (answers.free?.trim()) text += `
Свободная запись:
→ ${answers.free}`;
  });

  // Step 7: Self-ratings
  const sr = session.selfRatings;
  if (sr) {
    text += `

САМООЦЕНКА ГРАНЕЙ (1-10 после опыта):`;
    Object.entries(sr).forEach(([k, v]) => {
      if (facetLabels[k]) text += `
${facetLabels[k]}: ${v}`;
    });
  }

  // Step 8: Integration
  if (session.longterm?.length) {
    text += `

ДОЛГОСРОЧНАЯ ИНТЕГРАЦИЯ:`;
    session.longterm.forEach((e) => {
      const period = e.period || "";
      const periodLabel = { week:"Первая неделя", month:"Первый месяц", three:"Три месяца", year:"Полгода и дальше" }[period] || e.date || "";
      if (e.q1) text += `
[${periodLabel}] Как живут инсайты: ${e.q1}`;
      if (e.q2) text += `
Что изменилось: ${e.q2}`;
      if (e.q3) text += `
Что не изменилось: ${e.q3}`;
      if (e.q4) text += `
Новое намерение: ${e.q4}`;
    });
  }

  if (Array.isArray(lockerThoughts) && lockerThoughts.length) {
    text += `\n\nЧЕРНОВИКИ К ЭТОЙ СЕССИИ:`;
    lockerThoughts.forEach(t => { if (t && t.text) text += `\n- ${t.text}`; });
  }

  if (Array.isArray(session.analyses) && session.analyses.length) {
    text += `\n\nПРЕДЫДУЩИЕ РАЗБОРЫ ЭТОЙ СЕССИИ (учитывай их, опирайся на прошлые прочтения и покажи движение во времени):`;
    session.analyses.forEach(a => { if (a && a.text) text += `\n\n[${a.label || "Разбор"}]\n${a.text}`; });
  }

  return text;
}

async function runAnalysis(session, lockerThoughts = []) {
  const response = await fetchT(`${API_BASE}/analyze`, {
    timeout: 60000,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: buildPrompt(session, lockerThoughts), initData: tgInitData() }),
  });
  if (!response.ok) throw new Error("API error");
  const data = await response.json();
  return data.text || "Не удалось получить анализ.";
}


// ── Longterm Editor (editable in SessionDetail) ───────────────────────────────
function LongtermEditor({ session, onUpdateSession, isPremium, onUpgrade }) {
  const uid = () => Math.random().toString(36).slice(2);
  const entries = session.longterm || [];

  function addEntry() {
    const newEntry = {
      id: uid(),
      date: new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" }),
      q1:"", q2:"", q3:"", q4:""
    };
    onUpdateSession({ ...session, longterm: [...entries, newEntry] });
  }

  function updateEntry(i, key, val) {
    const updated = entries.map((e, idx) => idx === i ? { ...e, [key]: val } : e);
    onUpdateSession({ ...session, longterm: updated });
  }

  function deleteEntry(i) {
    const updated = entries.filter((_, idx) => idx !== i);
    onUpdateSession({ ...session, longterm: updated });
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <PeriodAccordion
        entries={entries}
        canFinish={session.status === "done"}
        onChange={(next) => onUpdateSession({ ...session, longterm: next })}
      />
    </div>
  );
}

function AnalysisTab({ session, isPremium, onUpgrade, onSaveAnalysis, locker = [] }) {
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const analyses = session.analyses || [];

  function pendingBasis() {
    const done = new Set(analyses.map(a => a.basis));
    if (session.status === "done" && !done.has("session")) return { basis: "session", label: "Разбор по сессии" };
    for (const [pid, label] of PERIODS) {
      const e = (session.longterm || []).find(x => x.period === pid);
      if (e && e.done && !done.has(pid)) return { basis: pid, label: "Разбор: " + label };
    }
    return null;
  }
  const pending = pendingBasis();

  async function handleAnalyze() {
    if (!pending) return;
    setStatus("loading");
    try {
      const bound = (locker || []).filter(t => String(t.sid) === String(session.id));
      const text = await runAnalysis(session, bound);
      const entry = { basis: pending.basis, label: pending.label, text, at: Date.now() };
      onSaveAnalysis(entry);
      try {
        await fetchT(`${API_BASE}/send-analysis`, {
          timeout: 45000,
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: tgInitData(), text: (entry.label ? entry.label + "\n\n" : "") + text }),
        });
      } catch (e) {}
      setStatus("idle");
    } catch (e) {
      setStatus("error");
    }
  }

  if (!isPremium) return (
    <div style={{ paddingTop:8 }}>
      <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none", borderRadius:14,
        padding:20, textAlign:"center" }}>
        <div style={{ fontSize:32, marginBottom:12 }}>◎</div>
        <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:22, letterSpacing:"0.05em",
          color:T.ink, marginBottom:10 }}>
          АНАЛИЗ ОТ CLAUDE
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, marginBottom:20,
          fontFamily:"'Montserrat', sans-serif" }}>
          Я читаю всё что ты написал и отражаю паттерны которые сложно увидеть изнутри. Противоречия, повторяющиеся темы, расстояние между намерением и тем что пришло.
        </div>
        <div style={{ fontSize:11, color:T.muted, marginBottom:16, fontFamily:"'Montserrat', sans-serif",
          background:T.bg, borderRadius:8, padding:"8px 12px", lineHeight:1.6 }}>
          🔒 Для анализа текст сессии уходит на наш сервер и к Claude, чтобы сгенерировать ответ. На сервере он не сохраняется.
        </div>
        <Btn onClick={onUpgrade}>Открыть полный доступ</Btn>
      </div>
    </div>
  );

  return (
    <div style={{ paddingTop:8 }}>
      {analyses.map((a, i) => (
        <Card key={i} style={{ borderLeft:`3px solid ${T.accent}`, marginBottom:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase",
            letterSpacing:"0.05em", marginBottom:8, fontFamily:"'Montserrat', sans-serif" }}>{a.label || "Разбор"}</div>
          <div style={{ fontSize:14, lineHeight:1.8, color:T.ink, whiteSpace:"pre-wrap",
            fontFamily:"'Montserrat', sans-serif" }}>{a.text}</div>
        </Card>
      ))}

      {status === "loading" && (
        <Card>
          <div style={{ textAlign:"center", padding:"16px 0" }}>
            <HourGlass size={32} />
            <div style={{ fontWeight:700, fontSize:15, color:"#000", marginTop:8 }}>Обработка…</div>
            <div style={{ fontSize:13, color:"#555", marginTop:4 }}>Анализирую паттерны в твоих записях</div>
          </div>
        </Card>
      )}

      {status === "error" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <Card>
            <div style={{ fontSize:13, color:T.accent, fontFamily:"'Montserrat', sans-serif" }}>
              Что-то пошло не так, разбор не получен. Попробуй ещё раз.
            </div>
          </Card>
          <Btn onClick={handleAnalyze}>Попробовать снова</Btn>
        </div>
      )}

      {status === "idle" && pending && (
        <Card>
          <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>
            {analyses.length === 0
              ? "Я прочитаю всё что ты написал в этой сессии и отражу паттерны, противоречия и вопросы для углубления. Это не терапия, это зеркало."
              : "Появился новый материал. Новый разбор учтёт всю историю сессии и прошлые разборы."}
          </div>
          <div style={{ fontSize:11, color:T.muted, lineHeight:1.6, marginBottom:14,
            fontFamily:"'Montserrat', sans-serif", background:T.bg, borderRadius:8, padding:"8px 12px" }}>
            🔒 Для анализа текст сессии уходит на сервер и к Claude только для генерации ответа. На сервере он не сохраняется, заметки остаются в твоём Telegram. Готовый разбор придёт тебе и в личку от бота.
          </div>
          <Btn onClick={handleAnalyze}>Запустить анализ</Btn>
        </Card>
      )}

      {status === "idle" && !pending && (
        <Card>
          <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, textAlign:"center", fontFamily:"'Montserrat', sans-serif" }}>
            {analyses.length === 0
              ? "Заверши сессию, чтобы стал доступен разбор."
              : "Разбор по текущим данным уже сделан. Следующий откроется, когда ты завершишь новый период в долгосрочной интеграции."}
          </div>
        </Card>
      )}
    </div>
  );
}

const LOCKER_COLORS = {
  none:{ bg:"var(--surface)", fg:"#000000" },
  red:{ bg:"#c0392b", fg:"#ffffff" }, orange:{ bg:"#e67e22", fg:"#000000" }, yellow:{ bg:"#f1c40f", fg:"#000000" },
  green:{ bg:"#27ae60", fg:"#ffffff" }, cyan:{ bg:"#5dade2", fg:"#000000" }, blue:{ bg:"#2c5fbf", fg:"#ffffff" }, violet:{ bg:"#8e44ad", fg:"#ffffff" },
};
const LOCKER_ORDER = ["red","orange","yellow","green","cyan","blue","violet"];

function lockerFmt(ts) {
  try {
    const d = new Date(ts);
    const mm = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"][d.getMonth()];
    return d.getDate() + " " + mm;
  } catch { return ""; }
}

function LockerNote({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" style={{ flex:"none" }} aria-hidden="true">
      <rect x="4.5" y="2.5" width="11" height="16" fill="none" stroke="currentColor" />
      <line x1="7" y1="7" x2="13" y2="7" stroke="currentColor" />
      <line x1="7" y1="10" x2="13" y2="10" stroke="currentColor" />
      <line x1="7" y1="13" x2="11" y2="13" stroke="currentColor" />
    </svg>
  );
}

function StackIcon({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ flex:"none" }} aria-hidden="true">
      <rect x="4" y="2" width="8" height="11" fill="#fff" stroke="#000" />
      <rect x="2" y="4" width="9" height="10" fill="#fff" stroke="#000" />
      <line x1="4" y1="7" x2="9" y2="7" stroke="#808080" />
      <line x1="4" y1="9" x2="9" y2="9" stroke="#808080" />
      <line x1="4" y1="11" x2="7" y2="11" stroke="#808080" />
    </svg>
  );
}

function HeadBook() {
  return (
    <svg width={30} height={30} viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ flex:"none" }} aria-hidden="true">
      <rect x="3" y="2" width="9" height="12" fill="#2c5fbf" stroke="#000" />
      <rect x="3" y="2" width="2" height="12" fill="#1b3f8f" />
      <rect x="6" y="6" width="4" height="1" fill="#f1c40f" />
      <rect x="6" y="8" width="3" height="1" fill="#f1c40f" />
      <rect x="10" y="2" width="1" height="4" fill="#c0392b" />
    </svg>
  );
}
function HeadAlert() {
  return (
    <svg width={30} height={30} viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ flex:"none" }} aria-hidden="true">
      <polygon points="8,2 14,13 2,13" fill="#f1c40f" stroke="#000" strokeLinejoin="miter" />
      <rect x="7" y="6" width="2" height="3" fill="#000" />
      <rect x="7" y="10" width="2" height="2" fill="#000" />
    </svg>
  );
}
function HeadHex() {
  return (
    <svg width={30} height={30} viewBox="0 0 16 16" style={{ flex:"none" }} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="#eef6e8" stroke="#000" />
      <circle cx="8" cy="8" r="4" fill="none" stroke="#27ae60" />
      <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="#000" shapeRendering="crispEdges" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="#000" shapeRendering="crispEdges" />
      <line x1="8" y1="8" x2="13" y2="4" stroke="#27ae60" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="1.4" fill="#c0392b" />
    </svg>
  );
}
function HeadMusic() {
  return (
    <svg width={30} height={30} viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ flex:"none" }} aria-hidden="true">
      <rect x="1" y="6" width="3" height="4" fill="#808080" stroke="#000" />
      <polygon points="4,6 4,10 8,13 8,3" fill="#c0c0c0" stroke="#000" />
      <path d="M10 5 Q12 8 10 11" fill="none" stroke="#1084d0" strokeWidth="1" shapeRendering="auto" />
      <path d="M11.5 3 Q14.5 8 11.5 13" fill="none" stroke="#1084d0" strokeWidth="1" shapeRendering="auto" />
    </svg>
  );
}

function LockerScreen({ thoughts = [], onSave, sessions = [], onBack, onSketch }) {
  const [openId, setOpenId] = useState(undefined);
  const [draft, setDraft] = useState({ text:"", color:"none", sid:"" });
  const [selOpen, setSelOpen] = useState(false);
  const pressTimer = useRef(null);

  const attachSessions = sessions || [];
  function labelOf(sn) {
    return (sn.substance || "Сессия") + " · " + (sn.date || "") + (sn.status === "draft" ? " · не завершена" : "");
  }
  function sessionLabel(sid) {
    const sn = attachSessions.find(x => String(x.id) === String(sid));
    return sn ? labelOf(sn) : "Без привязки";
  }

  function openNew() { setDraft({ text:"", color:"none", sid:"" }); setOpenId(null); }
  function openEdit(t) { setDraft({ text:t.text, color:t.color || "none", sid:t.sid || "" }); setOpenId(t.id); }
  function closeModal() { setOpenId(undefined); setSelOpen(false); }

  function save() {
    const text = draft.text.trim();
    if (!text) { closeModal(); return; }
    let next;
    if (openId === null) {
      next = [{ id: Math.random().toString(36).slice(2), text, color:draft.color, sid:draft.sid, createdAt: Date.now() }, ...thoughts];
    } else {
      next = thoughts.map(t => t.id === openId ? { ...t, text, color:draft.color, sid:draft.sid } : t);
    }
    onSave(next);
    closeModal();
  }
  function del() { onSave(thoughts.filter(t => t.id !== openId)); closeModal(); }

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
        <StackIcon size={30} />
        <SectionTitle size={28} style={{ marginBottom: 0 }}>ЧЕРНОВИКИ</SectionTitle>
      </div>
      <Sub>Сюда можно докидывать короткие мысли, которые приходят до, во время или после сессии, в разные дни. Всё хранится в твоём Telegram.</Sub>

      <div style={{ background:"var(--surface)", boxShadow:"var(--raised)", padding:3, marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, background:"var(--titlebar)", color:"#fff",
          fontWeight:700, fontSize:12, padding:"3px 4px", fontFamily:"'Montserrat', sans-serif" }}>
          <StackIcon size={15} />
          <span>Черновики</span>
        </div>
        <div style={{ padding:5, display:"flex", gap:5 }}>
          <button className="tl-btn" onClick={openNew} style={{ flex:1, fontFamily:"'Montserrat', sans-serif" }}>+ Новый черновик</button>
          <button className="tl-btn" onClick={onSketch} style={{ flex:1, fontFamily:"'Montserrat', sans-serif" }}>+ Зарисовка</button>
        </div>
        <div style={{ background:"#fff", boxShadow:"var(--sunken)", margin:"0 5px 5px", padding:10, minHeight:120 }}>
          {thoughts.length === 0 ? (
            <div style={{ fontSize:12, color:T.muted, textAlign:"center", padding:"24px 8px", lineHeight:1.6, fontFamily:"'Montserrat', sans-serif" }}>
              Пока пусто. Добавь первый черновик кнопкой выше.
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
              {thoughts.map(t => {
                const c = LOCKER_COLORS[t.color] || LOCKER_COLORS.none;
                return (
                  <div key={t.id} className="tl-tile"
                    onClick={() => openEdit(t)}
                    onTouchStart={() => { pressTimer.current = setTimeout(() => openEdit(t), 550); }}
                    onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                    onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                    style={{ position:"relative", minHeight:98, padding:"8px 6px 16px", cursor:"pointer",
                      display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", gap:5,
                      background:c.bg, color:c.fg, fontFamily:"'Montserrat', sans-serif" }}>
                    <LockerNote size={22} />
                    <div style={{ fontSize:11, lineHeight:1.35, display:"-webkit-box", WebkitLineClamp:3, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{t.text}</div>
                    <div style={{ position:"absolute", bottom:3, left:0, right:0, fontSize:9, opacity:0.75 }}>{lockerFmt(t.createdAt)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {openId !== undefined && (
        <div onClick={closeModal} style={{ position:"fixed", inset:0, zIndex:3000, background:"rgba(0,0,0,0.45)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:12 }}>
          <div onClick={e => e.stopPropagation()} style={{ width:320, maxWidth:"100%", background:"var(--surface)", boxShadow:"var(--raised)", padding:3 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"var(--titlebar)", color:"#fff",
              fontWeight:700, fontSize:12, padding:"3px 4px", fontFamily:"'Montserrat', sans-serif" }}>
              <span style={{ flex:1 }}>{openId === null ? "Новый черновик" : "Черновик"}</span>
              <button className="tl-btn" onClick={closeModal} aria-label="Закрыть" style={{ width:20, height:18, fontSize:12, padding:0, lineHeight:1 }}>✕</button>
            </div>
            <div style={{ padding:"6px 6px 0" }}>
              <textarea className="tl-ta" value={draft.text} onChange={e => setDraft({ ...draft, text:e.target.value })}
                placeholder="🎤 можно диктовать через микрофон на клавиатуре"
                style={{ minHeight:96, fontSize:12, fontFamily:"'Montserrat', sans-serif" }} />
            </div>
            <div style={{ fontSize:11, color:T.ink, fontWeight:700, margin:"10px 6px 4px", fontFamily:"'Montserrat', sans-serif" }}>Привязать к сессии:</div>
            <div style={{ padding:"0 6px", position:"relative" }}>
              <div onClick={() => setSelOpen(o => !o)}
                style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                  background:"#fff", boxShadow:"var(--sunken)", padding:"7px 4px 7px 8px",
                  fontSize:12, cursor:"pointer", minHeight:32, fontFamily:"'Montserrat', sans-serif" }}>
                <span style={{ overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", color:"#000" }}>
                  {draft.sid ? sessionLabel(draft.sid) : "Без привязки"}
                </span>
                <span style={{ flex:"0 0 auto", marginLeft:6, width:20, height:20,
                  background:"var(--surface)", boxShadow: selOpen ? "var(--sunken)" : "var(--raised)",
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:9 }}>▼</span>
              </div>
              {selOpen && (
                <>
                  <div onClick={() => setSelOpen(false)} style={{ position:"fixed", inset:0, zIndex:3100 }} />
                  <div style={{ position:"absolute", top:"calc(100% + 2px)", left:6, right:6, zIndex:3101,
                    background:"#fff", border:"2px solid #000080", boxShadow:"3px 3px 8px rgba(0,0,0,0.45)",
                    maxHeight:200, overflowY:"auto" }}>
                    {[{ id:"", label:"Без привязки" }].concat(attachSessions.map(sn => ({ id:String(sn.id), label:labelOf(sn) }))).map(opt => {
                      const sel = String(draft.sid) === opt.id;
                      return (
                        <div key={opt.id || "none"} onClick={() => { setDraft(d => ({ ...d, sid:opt.id })); setSelOpen(false); }}
                          style={{ padding:"8px 10px", fontSize:12, cursor:"pointer", lineHeight:1.4,
                            background: sel ? "#000080" : "#fff", color: sel ? "#fff" : "#000",
                            fontFamily:"'Montserrat', sans-serif" }}>
                          {opt.label}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <div style={{ fontSize:11, color:"#333", margin:"5px 6px 0", lineHeight:1.5, fontFamily:"'Montserrat', sans-serif" }}>
              Привяжи мысль к сессии сейчас или позже. Тогда она подтянется к разбору этого опыта. Без привязки мысль останется просто в черновиках.
            </div>
            <div style={{ fontSize:11, color:T.ink, fontWeight:700, margin:"10px 6px 4px", fontFamily:"'Montserrat', sans-serif" }}>Цвет плитки:</div>
            <div style={{ padding:"0 6px" }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4, minmax(0, 1fr))", gap:6, width:"100%" }}>
                {LOCKER_ORDER.map(k => (
                  <button key={k} className={"tl-swb" + (draft.color === k ? " on" : "")} onClick={() => setDraft({ ...draft, color:k })}
                    aria-label={k} style={{ minWidth:0, height:26, boxSizing:"border-box", background:LOCKER_COLORS[k].bg, border:"none" }} />
                ))}
                <button className={"tl-swb" + (draft.color === "none" ? " on" : "")} onClick={() => setDraft({ ...draft, color:"none" })}
                  aria-label="без цвета" style={{ minWidth:0, height:26, boxSizing:"border-box", fontSize:10, color:"#000", border:"none",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    background:"repeating-linear-gradient(45deg,#fff,#fff 3px,#ddd 3px,#ddd 6px)" }}>нет</button>
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", padding:"12px 6px 6px" }}>
              <button className="tl-btn" onClick={del} style={{ visibility: openId === null ? "hidden" : "visible", fontFamily:"'Montserrat', sans-serif" }}>Удалить</button>
              <button className="tl-btn" onClick={save} style={{ fontFamily:"'Montserrat', sans-serif" }}>Готово</button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function SessionDetail({ session, isPremium, onBack, onUpgrade, onSaveAnalysis, onUpdateSession, onDelete, locker }) {
  const [tab, setTab] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tabs = [
    { id:"overview", label:"Обзор" },
    { id:"facets",   label:"Грани" },
    { id:"longterm", label:"Интеграция" },
    { id:"analysis", label:"◎ Анализ" },
  ];

  return (
    <Screen>
      <BackBtn onClick={() => tab ? setTab(null) : onBack()} />
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <FolderIcon size={34} open={true} />
        <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:28, letterSpacing:"0.04em", color:T.ink }}>
          {session.substance || "СЕССИЯ"}
        </div>
      </div>
      <div style={{ fontSize:12, color:T.muted, marginBottom:16, fontFamily:"'Montserrat', sans-serif" }}>
        {session.date}{session.place ? ` · ${session.place}` : ""}
      </div>

      {tab === null && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:4, padding:"4px 0", marginBottom:16 }}>
          {[
            { id:"overview", label:"Обзор" },
            { id:"facets",   label:"Грани" },
            { id:"longterm", label:"Интеграция" },
            { id:"analysis", label:"Анализ", locked: !isPremium },
          ].map(docu => (
            <button key={docu.id} onClick={() => setTab(docu.id)}
              style={{ background:"none", border:"none", cursor:"pointer", padding:"8px 2px",
                display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
              <div style={{ position:"relative" }}>
                <DocIcon size={40} />
                {docu.locked && <div style={{ position:"absolute", bottom:8, right:0 }}><LockBadge size={18} /></div>}
              </div>
              <div style={{ fontSize:11, fontWeight:700, color:T.ink, whiteSpace:"nowrap" }}>{docu.label}</div>
            </button>
          ))}
        </div>
      )}

      {tab==="overview" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {session.intention_main && (
            <Card>
              <Label>Намерение</Label>
              <div style={{ fontSize:14, lineHeight:1.7, color:T.ink, fontFamily:"'Montserrat', sans-serif" }}>
                {session.intention_main}
              </div>
            </Card>
          )}
          {session.after_vivid && (
            <Card>
              <Label>Сразу после, самое яркое</Label>
              <div style={{ fontSize:13, lineHeight:1.7, color:T.ink, whiteSpace:"pre-wrap", fontFamily:"'Montserrat', sans-serif" }}>
                {session.after_vivid}
              </div>
            </Card>
          )}
          {session.after_feeling && (
            <Card>
              <Label>Состояние после</Label>
              <div style={{ fontSize:13, lineHeight:1.7, color:T.ink, whiteSpace:"pre-wrap", fontFamily:"'Montserrat', sans-serif" }}>
                {session.after_feeling}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab==="facets" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {FACET_ORDER.map(key => {
            const f = T.facets[key] || { color: T.accent, bg: T.light, label: key };
            const answers = session.facets?.[key] || {};
            const hasContent = Object.values(answers).some(v => v?.trim());
            if (!hasContent) return (
              <div key={key} style={{ background:"var(--surface)", boxShadow:"var(--raised)", padding:"12px 16px",
                display:"flex", justifyContent:"space-between",
                alignItems:"center" }}>
                <FacetTag facet={key} />
                <span style={{ fontSize:12, color:T.muted, fontFamily:"'Montserrat', sans-serif" }}>не заполнено</span>
              </div>
            );
            return (
              <Card key={key} style={{ borderLeft:`3px solid ${f.color}` }}>
                <div style={{ marginBottom:10 }}><FacetTag facet={key} /></div>
                {FACET_QUESTIONS[key].map((q, i) => answers[i]?.trim() ? (
                  <div key={i} style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:T.muted, fontWeight:600, letterSpacing:"0.04em", marginBottom:4, fontFamily:"'Montserrat', sans-serif" }}>{q}</div>
                    <div style={{ fontSize:13, lineHeight:1.6, color:T.ink, whiteSpace:"pre-wrap", fontFamily:"'Montserrat', sans-serif" }}>{answers[i]}</div>
                  </div>
                ) : null)}
              </Card>
            );
          })}
        </div>
      )}

      {tab==="longterm" && (
        <LongtermEditor session={session} onUpdateSession={onUpdateSession} isPremium={isPremium} onUpgrade={onUpgrade} />
      )}

      {tab==="analysis" && (
        <AnalysisTab session={session} isPremium={isPremium} onUpgrade={onUpgrade} onSaveAnalysis={onSaveAnalysis} locker={locker} />
      )}

      {/* Delete button */}
      <div style={{ marginTop:24, paddingTop:16, borderTop:`1px solid ${T.light}` }}>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} style={{
            background:"none", border:"none", cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center",
            gap:8, width:"100%", padding:"10px 0",
            color:T.muted, fontFamily:"'Montserrat', sans-serif", fontSize:13,
          }}>
            <BinIcon size={18} /> Удалить сессию
          </button>
        ) : (
          <MessageBox title="Удаление"
            message="Удалить сессию? Действие нельзя отменить, все записи этой сессии будут удалены."
            confirmLabel="Удалить" cancelLabel="Отмена"
            onConfirm={onDelete} onCancel={() => setConfirmDelete(false)} />
        )}
      </div>
    </Screen>
  );
}

// ── Privacy page ──────────────────────────────────────────────────────────────
function PrivacyPage({ onBack, onDeleteAll }) {
  const [deleted, setDeleted] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  function handleDelete() {
    setDeleted(true);
    if (onDeleteAll) onDeleteAll();
  }
  const openDoc = (path) => {
    const url = (typeof window !== "undefined" ? window.location.origin : "") + path;
    const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, "_blank");
  };

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
        <span style={{ fontSize:22, lineHeight:1, flex:"none" }}>🔒</span>
        <SectionTitle size={22} style={{ marginBottom:0 }}>КОНФИДЕНЦИАЛЬНОСТЬ</SectionTitle>
      </div>
      <div style={{ height:20 }} />

      <Card style={{ marginBottom:12 }}>
        <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:8, fontFamily:"'Montserrat', sans-serif" }}>
          Твои данные, твои
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, fontFamily:"'Montserrat', sans-serif" }}>
          Всё что ты пишешь в заметках, намерения, записи, ответы, хранится в твоём Telegram (CloudStorage). На наших серверах заметки не лежат.
        </div>
      </Card>

      <Card style={{ marginBottom:12 }}>
        <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:8, fontFamily:"'Montserrat', sans-serif" }}>
          Что хранится на нашем сервере
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, fontFamily:"'Montserrat', sans-serif" }}>
          На сервере хранится только факт оплаты (открыт ли у тебя полный доступ) и факт твоего согласия с условиями. Сами заметки на сервере не хранятся. Когда ты запускаешь анализ, текст сессии уходит на сервер и к Claude только чтобы сгенерировать ответ, и нигде не сохраняется.
        </div>
      </Card>

      <Card style={{ marginBottom:24 }}>
        <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:8, fontFamily:"'Montserrat', sans-serif" }}>
          Как удалить все данные
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>
          Настройки Telegram → Конфиденциальность → Данные Mini App → Заметки психонавта → Удалить.
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.7, fontFamily:"'Montserrat', sans-serif" }}>
          Или прямо здесь:
        </div>
      </Card>

      {deleted ? (
        <div style={{ background:"#e9f7ef", border:`1.5px solid #a9dfbf`, borderRadius:12,
          padding:16, textAlign:"center", fontFamily:"'Montserrat', sans-serif" }}>
          <div style={{ fontSize:20, marginBottom:6 }}>✓</div>
          <div style={{ fontWeight:600, fontSize:14, color:"#1a7a3e" }}>Все данные удалены</div>
        </div>
      ) : (
        <Btn variant="soft" onClick={() => setConfirmAll(true)}>
          Удалить все мои данные
        </Btn>
      )}

      {confirmAll && (
        <MessageBox title="Удаление"
          message="Удалить все данные приложения? Это действие нельзя отменить."
          confirmLabel="Удалить" cancelLabel="Отмена"
          onConfirm={() => { setConfirmAll(false); handleDelete(); }}
          onCancel={() => setConfirmAll(false)} />
      )}

      <Card style={{ marginTop:24, marginBottom:0 }}>
        <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:10, fontFamily:"'Montserrat', sans-serif" }}>
          Полные документы
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <span onClick={() => openDoc("/terms.html")}
            style={{ fontSize:13, color:"#000080", textDecoration:"underline", cursor:"pointer", fontFamily:"'Montserrat', sans-serif" }}>Условия использования</span>
          <span onClick={() => openDoc("/privacy.html")}
            style={{ fontSize:13, color:"#000080", textDecoration:"underline", cursor:"pointer", fontFamily:"'Montserrat', sans-serif" }}>Политика конфиденциальности</span>
        </div>
      </Card>

      <div style={{ marginTop:24, paddingTop:20, borderTop:`1px solid ${T.light}`, fontSize:11, color:T.muted, textAlign:"center",
        lineHeight:1.6, fontFamily:"'Montserrat', sans-serif" }}>
        @dostoevski_fm
      </div>
    </Screen>
  );
}

// ── First launch onboarding ───────────────────────────────────────────────────
function FirstLaunch({ onAccept }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"#008080",
      display:"flex", alignItems:"center", justifyContent:"center", padding:16, zIndex:500 }}>
      <div style={{ width:"100%", maxWidth:360, maxHeight:"90vh", overflowY:"auto",
        background:"var(--surface)", boxShadow:"var(--raised)", padding:3 }}>
        <div style={{ background:"var(--titlebar)", color:"#fff", fontWeight:700, fontSize:13,
          display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"3px 4px 3px 6px", marginBottom:10 }}>
          <span>Конфиденциальность</span>
          <span style={{ width:18, height:15, background:"var(--surface)", boxShadow:"var(--raised)",
            color:"#000", fontSize:10, fontWeight:700, lineHeight:"13px", textAlign:"center" }}>✕</span>
        </div>
        <div style={{ padding:"6px 14px 16px" }}>
          <div style={{ textAlign:"center", marginBottom:14 }}>
            <span style={{ fontSize:40 }}>🔒</span>
          </div>
          <div style={{ fontSize:22, fontWeight:700, letterSpacing:"0.02em",
            color:"#000", textAlign:"center", marginBottom:14 }}>
            ТВОИ ДАННЫЕ, ТВОИ
          </div>
          <div style={{ fontSize:13, color:"#333", lineHeight:1.7, marginBottom:12 }}>
            Всё что ты пишешь в заметках хранится только в твоём Telegram аккаунте. Мы не видим это и не можем прочитать.
          </div>
          <div style={{ fontSize:13, color:"#333", lineHeight:1.7, marginBottom:20 }}>
            На нашем сервере хранится только один факт: оплачен ли у тебя полный доступ. Больше ничего.
          </div>
          <Btn onClick={onAccept}>Понятно, начнём</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Journal list ──────────────────────────────────────────────────────────────
function JournalList({ sessions, isPremium, onNew, onOpen, onResume, onUpgrade, onPrivacy, onLocker }) {
  return (
    <Screen>
      <div style={{ display:"flex", flexDirection:"column", minHeight:"calc(100vh - 148px - max(env(safe-area-inset-bottom, 0px), var(--sab, 0px)))" }}>
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:16, fontWeight:800, color:"#000", textAlign:"center",
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", letterSpacing:"0.2px",
          fontFamily:"'Montserrat', sans-serif" }}>
          Интеграция психоделического опыта
        </div>
        <div style={{ height:0, borderTop:"1px solid #808080", borderBottom:"1px solid #ffffff", margin:"12px 0 14px" }} />
        <div style={{ display:"flex", gap:12 }}>
          <button onClick={onLocker} style={{ flex:1, WebkitAppearance:"none", appearance:"none", borderRadius:0,
            background:"var(--surface)", boxShadow:"var(--raised)", color:"#000", border:"none",
            padding:"10px 12px", fontFamily:"'Montserrat', sans-serif",
            fontWeight:700, fontSize:14, cursor:"pointer" }}>
            Черновики
          </button>
          <button onClick={onNew} style={{ flex:1, WebkitAppearance:"none", appearance:"none", borderRadius:0,
            background:"var(--surface)", boxShadow:"var(--raised)", color:"#000", border:"none",
            padding:"10px 12px", fontFamily:"'Montserrat', sans-serif",
            fontWeight:700, fontSize:14, cursor:"pointer" }}>
            + Сессия
          </button>
        </div>
      </div>

      <div style={{ background:"#ffffe1", boxShadow:"var(--sunken)", padding:14, flex:1 }}>
        {sessions.length === 0 ? (
          <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
            <FolderIcon size={34} />
            <div style={{ fontSize:13, color:"#3a3a1e", lineHeight:1.5, fontFamily:"'Montserrat', sans-serif" }}>
              <b style={{ color:"#000" }}>Здесь будут твои сессии.</b><br />
              Пока пусто. Создай первую кнопкой «+ Сессия», и она появится тут как папка.
            </div>
          </div>
        ) : (
          <div>
            {sessions.map((s, i) => (
              <button key={s.id} onClick={() => s.status === "draft" ? onResume(s) : onOpen(s)}
                style={{ width:"100%", display:"flex", alignItems:"center", gap:10, padding:"10px 4px",
                  WebkitAppearance:"none", appearance:"none", borderRadius:0,
                  background:"none", border:"none", borderTop: i > 0 ? "1px solid #d8d5a0" : "none",
                  cursor:"pointer", textAlign:"left" }}>
                <FolderIcon size={26} />
                <span style={{ fontSize:14, fontWeight:600, color: s.status === "draft" ? "#555" : "#000",
                  fontFamily:"'Montserrat', sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                  {s.substance || "Сессия"}{s.status === "draft" ? " · не завершена" : ""}
                </span>
                <span style={{ marginLeft:"auto", fontSize:11, color:"#6b6b45", flex:"none", paddingLeft:8,
                  fontFamily:"'Montserrat', sans-serif" }}>
                  {s.status === "draft" ? "" : s.date}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!isPremium && sessions.length >= 1 && (
        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", padding:18, marginTop:20, textAlign:"center" }}>
          <div style={{ fontSize:13, fontWeight:700, color:T.ink, marginBottom:4, fontFamily:"'Montserrat', sans-serif" }}>
            1 сессия, бесплатно
          </div>
          <div style={{ fontSize:12, color:T.mid, marginBottom:14, fontFamily:"'Montserrat', sans-serif" }}>
            Открой полный доступ для продолжения работы
          </div>
          <Btn onClick={onUpgrade}>Открыть полный доступ</Btn>
        </div>
      )}
      </div>
    </Screen>
  );
}

// ── Upgrade ───────────────────────────────────────────────────────────────────
function UpgradePage({ onBack, onPurchase }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [stars, setStars] = useState(null);
  const [invoiceLink, setInvoiceLink] = useState("");
  const [error, setError] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  // Счёт выпускает сервер при открытии экрана: получаем ссылку и реальную цену.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await apiCreateInvoice();
      if (cancelled) return;
      if (data && data.invoiceLink) {
        setInvoiceLink(data.invoiceLink);
        setStars(data.stars);
      } else {
        setError("Не удалось получить счёт. Попробуй позже.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function startPayment() {
    if (loading) return;
    const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (!invoiceLink || !tg || !tg.openInvoice) {
      setError("Оплата недоступна. Открой приложение через Telegram.");
      return;
    }
    setError("");
    setLoading(true);
    tg.openInvoice(invoiceLink, async (status) => {
      // Не доверяем клиенту, перепроверяем оплату на сервере.
      if (status === "paid") {
        let ok = false;
        for (let i = 0; i < 5; i++) {
          const st = await apiPremiumStatus();
          if (st && st.premium) { ok = true; if (st.expiresAt) setExpiresAt(st.expiresAt); break; }
          await new Promise(res => setTimeout(res, 1200));
        }
        setLoading(false);
        if (ok) setDone(true);
        else setError("Оплата прошла, но доступ ещё не подтвердился. Перезайди через минуту.");
      } else {
        setLoading(false);
        if (status === "failed") setError("Оплата не прошла. Попробуй ещё раз.");
      }
    });
  }

  const btnLabel = loading
    ? "Открываем оплату…"
    : (stars != null ? `Открыть за ${stars} ⭐` : "Загрузка…");

  if (done) return (
    <Screen>
      <div style={{ textAlign:"center", paddingTop:40 }}>
        <div style={{ fontSize:56, marginBottom:16 }}>⭐</div>
        <SectionTitle size={28}>ПОЛНЫЙ ДОСТУП ОТКРЫТ</SectionTitle>
        <div style={{ color:T.mid, fontSize:13, margin:"16px 0 12px", lineHeight:1.6, fontFamily:"'Montserrat', sans-serif" }}>
          Доступ открыт на год.<br />Все модули доступны.
        </div>
        {expiresAt ? (
          <div style={{ display:"inline-block", background:T.bg, boxShadow:"var(--sunken)",
            padding:"6px 12px", marginBottom:24, fontSize:11, fontWeight:700, color:T.accent,
            fontFamily:"'Montserrat', sans-serif" }}>
            Действует до {fmtDate(expiresAt)}
          </div>
        ) : null}
        <Btn onClick={onPurchase}>Продолжить</Btn>
      </div>
    </Screen>
  );

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <SectionTitle size={28}>ПОЛНЫЙ ДОСТУП</SectionTitle>
      <div style={{ color:T.mid, marginBottom:24, fontSize:13, lineHeight:1.6, marginTop:6,
        fontFamily:"'Montserrat', sans-serif" }}>
        Доступ на год. Неограниченные сессии, анализ опыта и трекер изменений.
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:0, marginBottom:28,
        boxShadow:"var(--sunken)", overflow:"hidden", background:"var(--surface)" }}>
        {[
          ["◎","Неограниченные сессии","Веди столько записей сколько нужно"],
          ["⊕","Анализ от Claude","Паттерны, противоречия и вопросы для углубления по каждой сессии"],
          ["⬡","Трекер граней","Два радара, твоя оценка и оценка Claude, динамика по сессиям"],
        ].map(([icon, title, desc], i, arr) => (
          <div key={title} style={{
            display:"flex", gap:16, padding:"16px",
            borderBottom: i < arr.length - 1 ? `1px solid ${T.light}` : "none",
            alignItems:"center",
          }}>
            <div style={{
              width:40, height:40, background:"var(--surface)", boxShadow:"var(--raised)",
              display:"flex", alignItems:"center",
              justifyContent:"center", flexShrink:0,
              fontSize:20, color:T.accent,
            }}>{icon}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:14, color:T.ink, lineHeight:1.3,
                fontFamily:"'Montserrat', sans-serif", marginBottom:3 }}>{title}</div>
              <div style={{ fontSize:12, color:T.mid, lineHeight:1.5,
                fontFamily:"'Montserrat', sans-serif" }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      <Btn onClick={startPayment} disabled={loading || !invoiceLink}>
        {btnLabel}
      </Btn>
      {error ? (
        <div style={{ fontSize:11, color:T.accent, textAlign:"center", marginTop:10,
          fontFamily:"'Montserrat', sans-serif" }}>{error}</div>
      ) : null}
      <div style={{ fontSize:11, color:T.muted, textAlign:"center", marginTop:10,
        fontFamily:"'Montserrat', sans-serif" }}>
        Telegram Stars · доступ на год
      </div>
    </Screen>
  );
}

// ── Library ───────────────────────────────────────────────────────────────────

const LIBRARY_SECTIONS = [
  // ─────────────────────────────────────────────
  // РАЗДЕЛ 1, ПЕРЕД ОПЫТОМ
  // ─────────────────────────────────────────────
  {
    id: "before",
    label: "Перед опытом",
    articles: [
      {
        emoji: "⚠️",
        title: "Опасные сочетания и противопоказания",
        tag: "Особо опасно",
        text: `Это одна из самых важных статей здесь, потому что цена ошибки тут не испорченный опыт, а здоровье. Большинство тяжёлых случаев происходит не от самого вещества, а от того, что человек не сказал о своих лекарствах или диагнозах. Поэтому главный принцип простой: если ты принимаешь любые препараты или у тебя есть хронические либо психиатрические диагнозы, отнесись к этому с особой осторожностью и обязательно обсуди это заранее со своим лечащим врачом и с теми, кто проводит церемонию, с центром или ведущим. Не молчи об этом ради того, чтобы тебя допустили.

Аяуаска и серотонин. Аяуаска работает как ИМАО, ингибитор моноаминоксидазы. Это значит, что в связке с антидепрессантами и другими серотонинергическими веществами она может вызвать серотониновый синдром, опасное для жизни состояние. Сюда входят SSRI и SNRI, трициклики, триптофан, МДМА, декстрометорфан, а также серотонинергические обезболивающие и опиоиды вроде трамадола, мепередина и метадона. Эти сочетания бывают тяжёлыми: даже обычная доза мепередина на фоне ИМАО иногда вызывала тяжёлые, порой смертельные реакции. Если ты на антидепрессанте, его нельзя просто бросить накануне. Отмену ведёт только врач, и она занимает время: большинству SSRI нужно около двух недель, чтобы выйти, а флуоксетину не меньше пяти недель, иногда дольше. Резкая самостоятельная отмена опасна сама по себе.

Литий и классические психоделики. Литий это не примесь и не вещество, которое можно встретить случайно. Это рецептурный стабилизатор настроения, который назначают в первую очередь при биполярном расстройстве, то есть человек принимает его как прописанное лекарство. И это одно из самых ясно очерченных опасных сочетаний: в разборе реальных случаев приёма лития с ЛСД или псилоцибином судороги встречались почти в половине отчётов, а значительная часть требовала медицинской помощи. Сигнал настолько устойчивый, что литий стал жёстким критерием исключения во всех клинических исследованиях. Важно и то, что само биполярное расстройство, которое лечат литием, тоже относится к противопоказаниям. Если ты на литии, классические психоделики не для самостоятельной практики.

Ибогаин и сердце. Ибогаин стоит особняком: он удлиняет интервал QT и может вызывать смертельно опасные аритмии сердца, в том числе torsades de pointes. Такое случалось даже на терапевтических дозах и у людей без болезней сердца, и с ибогаином связан ряд смертей. Его нельзя сочетать с другими препаратами, которые тоже удлиняют QT, это часть антидепрессантов, нейролептиков, антиаритмиков и метадон. Работа с ибогаином требует сердечного скрининга и медицинского наблюдения, это не домашняя практика.

Стимуляторы и давление. Кокаин, амфетамины, МДМА, а также препараты от СДВГ вроде аддерала и риталина в связке с аяуаской резко поднимают пульс и давление вплоть до гипертонического криза. Если ты принимаешь что-то стимулирующее, это отдельный повод для осторожности и разговора с врачом.

Не смешивай вещества. Совмещать два психоделика сразу или психоделик с МДМА это не усиление пользы, а рост непредсказуемости и серотонинергической нагрузки. Чем больше всего намешано, тем труднее понять, что именно происходит с телом, и тем выше риск.

Противопоказания по здоровью. Психиатрические: личная или семейная история психоза, шизофрении или биполярного расстройства, тут возможен только клинический контекст под наблюдением, а не самостоятельный опыт, потому что есть риск спровоцировать психоз или манию. Сердечно-сосудистые: неконтролируемая гипертония, болезни сердца и аритмии, ведь психоделики и так поднимают давление и пульс. Печень, особенно для аяуаски. Эпилепсия и склонность к судорогам. Беременность и грудное вскармливание.

Этот список не исчерпывающий. Лекарств и состояний, которые могут опасно сочетаться, гораздо больше, и взаимодействия бывают неочевидными. Поэтому при любых препаратах или диагнозах не решай в одиночку: проверь свою ситуацию с врачом, который разбирается в теме, и с теми, кто проводит церемонию. Если во время опыта стало по-настоящему плохо физически, это повод не терпеть, а обращаться за помощью, смотри вкладку «Сложный опыт».`,
      },
      {
        emoji: "🧭",
        title: "Как понять, готов ли ты",
        tag: "Общее",
        text: `Решение об участии в опыте всегда должно приниматься самостоятельно. Давление со стороны других людей, само по себе противопоказание.

Не стоит идти в опыт если:
– Ты не знаком с веществом, его эффектами и рисками
– Ты делаешь это под давлением или чтобы кому-то понравиться
– Ты не доверяешь человеку который предлагает или ведёт
– Ты переживаешь острый психологический кризис, тяжёлую депрессию или недавнюю потерю, не потому что это невозможно, а потому что нужна дополнительная поддержка
– Ты принимаешь антидепрессанты или психотропные препараты, обязательна консультация с врачом
– Ты беременна или кормишь грудью

Психологические противопоказания: биполярное расстройство, шизофрения, пограничное расстройство личности, история психотических эпизодов. С этими состояниями работа возможна, но только в клиническом контексте с подготовленным специалистом.

Аяуаска, псилоцибин и другие классические психоделики, не панацея и не кратчайший путь. Это инструменты. При ненадлежащем использовании они могут усугубить проблемы или породить новые.`,
      },
      {
        emoji: "⚙️",
        title: "Сет и сеттинг, шесть факторов опыта",
        tag: "Общее",
        text: `На природу и ценность любого психоделического опыта влияют шесть факторов. Именно о них нужно позаботиться заранее.

1. Настрой (set), твоё внутреннее состояние, намерения, страхи, ожидания
2. Обстановка (setting), физическое пространство и его атмосфера
3. Вещество и доза, что именно и сколько
4. Проводник / сопровождающий, кто рядом
5. Сессия, структура самого опыта
6. Ситуация, какая поддержка доступна после

Настрой и обстановка долгое время игнорировались в медицинских исследованиях. Но большая часть наших реакций на любой стимул зависит от контекста и того, как мы его воспринимаем.

Идеально готовиться к путешествию как к трёхдневному процессу: день до, спокойствие, рефлексия, природа. День сессии, полностью под опыт. День после, осмысление, записи, интеграция.`,
      },
      {
        emoji: "🎯",
        title: "Как работать с намерением",
        tag: "Общее",
        text: `Намерение это не задание для вещества и не список требований к опыту. Это вопрос с которым ты входишь. Внутренний компас, а не маршрутный лист.

Запиши намерение заранее. Опытные проводники замечали: заранее поставленные вопросы помогают путешественнику направлять своё путешествие. Поделись намерением с проводником это помогает быть на одной волне.

Цели могут быть разными. Духовные, получить опыт единства, преодолеть убеждения которые больше не служат. Психологические, разобраться в паттернах, травмах, непрожитых чувствах. Социальные, улучшить отношения, понять как ты присутствуешь рядом с людьми.

Уменьши ожидания. Нереалистичные ожидания встречаются часто и мешают опыту. Аяуаска, псилоцибин и другие вещества покажут то что нужно, не обязательно то что хочется увидеть.

Оставайся открытым любым возникающим опытам, даже если они не отвечают на твой вопрос напрямую.`,
      },
      {
        emoji: "🍽️",
        title: "Подготовка тела, питание и состояние",
        tag: "Общее",
        text: `Физическая подготовка начинается за несколько дней до сессии, а не в день её проведения.

Питание. Питайся легко и здорово за несколько дней до опыта. Последний приём пищи, примерно за 6 часов до начала. Утром в день сессии допустим лёгкий завтрак из фруктов или тоста. Пей достаточно воды, приезжай отдохнувшим.

Вещества. Избегай алкоголя, стимуляторов, опиатов и других психоактивных веществ за несколько недель до опыта.

Лекарства. Если ты принимаешь любые лекарства, включая растительные препараты, обязательно сообщи об этом ведущему заранее и проконсультируйся с врачом. Некоторые сочетания опасны.

Состояние. Если состояние здоровья не позволяет тебе кататься на американских горках, скорее всего, тебе не стоит принимать психоделики. Это практическое правило, а не метафора.`,
      },
      {
        emoji: "👁️",
        title: "Зачем нужен проводник",
        tag: "Общее",
        text: `Для большинства людей основное чувство во время путешествия, не открытие чего-то нового и чуждого, а ощущение возвращения домой: воспоминание и объединение с тем, что и так было спящим в сознании.

Невозможно переоценить важность проводника. Во время расширения сознания бесценно находиться рядом с человеком которому доверяешь. Хорошим проводником делают не знания, а эмпатия и интуиция. Его задача, удерживать пространство, а не ставить цели.

Присутствие проводника влияет на направление, содержание и общее качество переживаний. Исследования Тимоти Лири и Рам Дасса показали: в большинстве случаев путешественник испытывает беспокойство именно тогда, когда проводник взволнован или не уверен.

Если у тебя нет психотерапевтической подготовки, не берись за роль проводника когда человек хочет глубоко погрузиться в страдание или природу зла. В таких случаях предложи работу с психотерапевтом.`,
      },
      {
        emoji: "🏠",
        title: "Как создать безопасное пространство",
        tag: "Общее",
        text: `Всё что необходимо для безопасного путешествия, уютная комната с диваном или кроватью, удобное кресло для проводника и доступ в туалет.

Важные элементы:
– Мягкие подушки и одеяла под рукой
– Музыкальная система, колонка лучше наушников: и ты, и проводник слышите музыку, при этом можно свободно перемещаться
– Изоляция от посторонних звуков
– Телефоны отключены или в беззвучном режиме
– Цветы, свечи, благовония, по желанию
– Маска для сна, усиливает внутреннее переживание

Твоя цель, создать простую обстановку, поддерживающую внутреннюю тишину. Если сомневаешься что комната достаточно простая, упрости её ещё.

Альберт Хофманн, создатель ЛСД: «Где бы вы его не принимали, всегда делайте это на природе». Идеальный баланс, интенсивные части сессии в помещении, возможность выйти на улицу позже.`,
      },
      {
        emoji: "🌡️",
        title: "Тело и чувствительность",
        tag: "Перед опытом",
        text: `В опыт идёт не только психика, но и тело. У психоделиков есть телесная сторона, и иногда она яркая. Если знать заранее, что считается нормой, телесные ощущения не будут пугать и отвлекать.

Что нормально для тела. На подъёме и в первый час часто бывает тошнота, ощущение тяжести и волн по телу, покалывание и мурашки, лёгкая дрожь. Зрачки расширяются, немного растут пульс и температура, бывает потливость. Жар и пульсация в теле на входе это тоже норма: так работает возбуждение нервной системы вместе с обычным волнением перед опытом. Почти всё это временное и проходит за несколько часов. Часто это просто тело отпускает напряжение, а не сигнал, что что-то сломалось.

Тебя может знобить. Во время опыта тело хуже держит температуру, и его бросает то в жар, то в холод, причём нередко именно знобит, даже если в комнате тепло. Поэтому держи под рукой что-то тёплое: плед, тёплые носки, кофту слоями, которые легко надеть и снять. Тёплое тело это базовый комфорт, на котором проще расслабиться и отпустить.

Сними с себя лишнее. Перед началом сними то, что давит и отвлекает: кольца, часы, тесные браслеты, по возможности контактные линзы. В опыте чувствительность тела повышается, и то, что обычно незаметно, может начать стягивать или раздражать. Свободная удобная одежда, маска на глаза по желанию, приглушённый свет и вода рядом делают всю разницу.

Если ты высокочувствительный. Высокая чувствительность это не выдумка и не слабость, а врождённая черта примерно у каждого пятого: нервная система реагирует на свет, звук, ткани, запахи и чужие настроения сильнее и глубже. Если ты в обычной жизни остро всё это ловишь, скорее всего и опыт зайдёт сильнее. Та же доза, что у других, может ощущаться интенсивнее, и дело не в том, что ты «не справляешься», а в более низком сенсорном пороге. Что с этим делать: разумно начать с меньшей дозы, тщательнее настроить среду по свету, звуку и тканям, заложить себе больше времени на восстановление и выбрать спокойное окружение и людей, которым доверяешь. При бережной настройке чувствительность не помеха, а то, что делает опыт особенно богатым.

Большинство телесных ощущений временные и безобидные. Но если становится по-настоящему плохо физически, резкая боль в груди, очень сильное сердцебиение, дурнота вплоть до потери сознания, это уже не про «процесс»: смотри статью «Опасные сочетания и противопоказания» и вкладку «Сложный опыт».`,
      },
      {
        emoji: "🌿",
        title: "Перед опытом с аяуаской",
        tag: "Аяуаска",
        text: `Аяуаска требует особой подготовки из-за серьёзных фармакологических взаимодействий.

Строгие противопоказания по препаратам. Нельзя принимать с антидепрессантами (особенно СИОЗС и ИМАО), психотропными препаратами, амфетаминами, МДМА, кокаином. Это может вызвать гипертонический криз или серотониновый синдром, потенциально смертельные состояния. Период отмены зависит от конкретного препарата, уточни у врача.

Диета. Традиционно рекомендуется диета за несколько дней до церемонии: исключить свинину, алкоголь, острое, ферментированные продукты с высоким содержанием тирамина.

Психологическая подготовка. Не принимать при биполярном расстройстве, шизофрении, пограничном расстройстве личности без специального сопровождения. При истории тяжёлой депрессии или попытках суицида, только с психологическим сопровождением.

Качество церемонии критически важно. Число случаев злоупотреблений со стороны организаторов растёт. Узнай о формате церемоний, количестве участников и помощников, опыте и рекомендациях ведущего.`,
      },
      {
        emoji: "🍄",
        title: "Перед опытом с псилоцибиновыми грибами",
        tag: "Грибы",
        text: `Псилоцибиновые грибы, один из наиболее изученных психоделиков с хорошим профилем безопасности. Но подготовка всё равно важна.

Идентификация. Если ты собираешь грибы самостоятельно, обязательна точная идентификация. Некоторые виды рода Galerina и Pholiota смертельно ядовиты и внешне похожи на псилоцибиновые виды. При малейшем сомнении, не употреблять.

Доза. Начинай с низкой дозы особенно при первом опыте. Потенциал варьируется от вида, условий роста и возраста грибов. Первые эффекты через 30 минут, не повторяй дозу раньше.

Психологическая подготовка. В период острого стресса или тяжёлых жизненных трудностей лучше повременить: грибы усиливают то, что уже есть внутри. Депрессия это не повод для запрета, псилоцибин официально изучается и применяется при депрессии, но работать с ней стоит не в одиночку, а под наблюдением специалиста. Людям с историей психоза или биполярного расстройства только в клиническом контексте.

Тихая обстановка, доверенные люди рядом, заранее выбранная музыка, всё это существенно влияет на качество опыта.`,
      },
      {
        emoji: "🌵",
        title: "Перед опытом с пейотом и сан-педро",
        tag: "Мескалин",
        text: `Оба кактуса содержат мескалин, опыт длится 10–14 часов. Это требует серьёзной подготовки времени и пространства.

Дозировка непредсказуема. Концентрация мескалина в пейоте и сан-педро сильно варьируется в зависимости от экземпляра. Эффекты появляются через 2–3 часа, не повторяй дозу раньше времени. Ошибка в дозировке, одна из самых частых причин трудных опытов.

Тошнота и рвота, нормальная часть опыта. Традиционно воспринимается как очищение. Будь готов к этому физически и психологически.

Не сочетать со стимуляторами, мескалин сам по себе имеет лёгкий стимулирующий эффект.

Пейот, охраняемый вид. Его сбор в дикой природе нанёс серьёзный ущерб популяции. Уважай это.

Те же психологические противопоказания что и для других классических психоделиков: психоз, биполярное расстройство, суицидальные мысли, только в клиническом контексте.`,
      },
      {
        emoji: "🌳",
        title: "Перед опытом с ибогой",
        tag: "Ибога",
        text: `Ибога требует наиболее строгой медицинской подготовки из всех психоделиков. Это не преувеличение, есть задокументированные смерти.

Обязательные медицинские обследования. Электрокардиограмма, абсолютный минимум. Лучше, нагрузочный тест и суточный мониторинг с холтером. Ибогаин замедляет сердечный ритм и удлиняет интервал QT это опасно при скрытых сердечных патологиях.

Абсолютные противопоказания: болезни сердца, аритмия, инфаркт в анамнезе, пороки сердца, тяжёлое ожирение, тромбозы, заболевания печени и почек.

Опасные взаимодействия. Ибогаин метаболизируется ферментом CYP2D6, многие препараты конкурируют за этот фермент. Нельзя принимать сразу после длительных перелётов, риск тромбоэмболии лёгких.

Только в контролируемых условиях. Ибогаин, не для самостоятельного использования. Необходимо присутствие медицинского персонала с кардиологической подготовкой на протяжении всей сессии (7–12 часов острой фазы).

Психологические противопоказания: шизофрения, история психозов, биполярное расстройство.`,
      },
      {
        emoji: "🐸",
        title: "Перед опытом с Буфо альвариус",
        tag: "5-MeO-DMT",
        text: `Буфо альвариус, один из наиболее интенсивных опытов из известных. Требует особой подготовки именно потому что он очень короткий, и именно поэтому к нему легко относятся легкомысленно.

Опасные сочетания. Нельзя сочетать с аяуаской, ждать минимум 24 часа между веществами. Нельзя сочетать с ИМАО, документированные смерти от гипертермии. Нельзя при приёме антидепрессантов.

Обязательное сопровождение. Во время опыта человек полностью теряет контроль над телом, непроизвольные движения, возможны падения. Присутствие трезвого и подготовленного человека обязательно.

Психологическая готовность. Опыт включает полное растворение эго и ощущение смерти. Это не метафора, многие описывают это именно так. Важно осознанно согласиться с этой возможностью до начала, а не в процессе.

Экологический вопрос. Массовый спрос на церемонии с жабой нанёс серьёзный ущерб популяции Incilius alvarius. Синтетический 5-MeO-DMT, этичная альтернатива без вреда для животного.`,
      },
      {
        emoji: "💊",
        title: "Перед опытом с МДМА",
        tag: "МДМА",
        text: `МДМА в терапевтическом контексте это не таблетка на вечеринке. Речь о структурированной работе с травмой в сопровождении подготовленного специалиста.

Медицинские противопоказания: болезни сердца, неконтролируемая гипертония, эпилепсия, болезни печени, глаукома. Нельзя при приёме ИМАО, лития, многих антидепрессантов, опасные взаимодействия.

Психологические особенности. МДМА временно снижает активность миндалины это позволяет работать с травматическим материалом без захлёстывающего страха. Но это же означает что защитные механизмы психики временно ослаблены. Важно иметь план того что делать с тем что поднимется.

Температурный риск. Гипертермия, основной физический риск. Особенно при физической активности. Поддерживай умеренную температуру, пей воду, но не избыточно (гипонатриемия тоже опасна, 200–400 мл в час при активности).

Частота. Рекомендуемый интервал между приёмами, минимум 3 месяца. При более частом использовании, риск нейротоксичности.`,
      },
    ],
  },

  // ─────────────────────────────────────────────
  // РАЗДЕЛ 2, ВО ВРЕМЯ ОПЫТА
  // ─────────────────────────────────────────────
  {
    id: "during",
    label: "Во время опыта",
    articles: [
      {
        emoji: "🌊",
        title: "Фазы сессии",
        tag: "Ориентация",
        text: `Любой психоделический опыт проходит через несколько фаз. Знание этого помогает не паниковать когда что-то меняется.

Начало (20–60 минут). Вещество начинает действовать. Некоторым хочется двигаться и разговаривать это нормально. Постепенно направляй внимание внутрь. Ляг, начни слушать музыку, наблюдай за дыханием. Может появляться ощущение «входа и выхода» это начало путешествия.

Открытие (2–4 часа). Самая интенсивная часть. Изменения восприятия, образы, эмоции. Именно здесь многие соприкасаются с ощущением единства или встречают трудный материал. Доверяй процессу, сопротивление обычно усиливает дискомфорт.

Плато (1–2 часа). После пика интенсивность снижается. Можно сесть, поговорить с проводником, продолжить слушать музыку.

Завершение (2–4 часа). Постепенное возвращение. Время для личностной работы, ты уже в контакте со своей идентичностью, но свободнее от привычных паттернов. Не торопись возвращаться во внешний мир.

Длительность зависит от вещества: псилоцибин, 4–6 часов, аяуаска, 4–6 часов, ЛСД, 8–12 часов, пейот/сан-педро, 10–14 часов.`,
      },
      {
        emoji: "👥",
        title: "Групповые сессии",
        tag: "В группе",
        text: `Групповой формат это традиционный способ работы с аяуаской и частый формат ретритов. В группе тебя держит общий контейнер: ведущий и команда задают и удерживают обстановку, музыку и ритм, а вокруг люди, которые проходят свой путь рядом с тобой. У этого есть своя сила и свои особенности, которые стоит понимать заранее.

Сила группы. Общее переживание реально работает. Исследования показывают, что чувство общности в групповой сессии и ощущение эмоциональной поддержки связаны с устойчивым улучшением самочувствия и чувства связи с людьми, а вклад в это вносят личная открытость и хорошие отношения с теми, кто ведёт. Проще говоря, в группе ты не один, и это часть того, что лечит.

Чужие процессы рядом. В группе ты будешь слышать и видеть, как другие проходят своё: кто-то очищается через рвоту, кто-то плачет или кричит. Это нормальная часть процесса, очищение в традиции не считается сбоем. Но будь готов, что чужие состояния могут тебя задевать и поднимать твоё собственное: в эти часы ты восприимчивее обычного. Это не повод пугаться, просто знай об этом и возвращайся к своему дыханию и своему опыту.

Оставайся в своём. Не вмешивайся в чужой опыт: не трогай, не пытайся спасать и не заговаривай с другим участником в процессе. Это работа команды, и хорошая практика прямо предполагает, что участника ограждают от вмешательства других. Возможно, тебе захочется сдерживать себя, чтобы не мешать соседям: не плакать, не издавать звуков, не двигаться. Сдерживаться не нужно. Пространство и команда как раз для того и устроены, чтобы можно было проживать своё открыто. И помни про конфиденциальность: то, что происходило и звучало в группе, остаётся в группе.

Как понять, что группа безопасная. Хорошая группа это не про количество людей, а про команду и правила. На что смотреть: есть предварительный скрининг, собеседование и анкета о здоровье, и людей с противопоказаниями не допускают; помощников достаточно на число участников, чтобы каждому хватало поддержки и места; команда никогда не оставляет участников одних и ограждает их друг от друга; есть чёткий этический протокол, в первую очередь полный запрет на любой сексуальный контакт до, во время и после, и ясные границы между ведущими, ассистентами и участниками; конфиденциальность и безопасность группы защищены.

Физическая безопасность и помощь. В норме участников просят оставаться на месте, не перемещаться и не водить, сидеть, а не лежать, а если лежать, то на боку, и кто-то из команды остаётся доступен ещё несколько часов после. Если тебе в процессе станет тяжело, проси помощь, для этого и есть команда: хорошие ведущие поддерживают простыми, нелекарственными приёмами и не отходят, пока ты не скажешь, что стабилен. Подробнее про тяжёлые моменты смотри вкладку «Сложный опыт».`,
      },
      {
        emoji: "😰",
        title: "Как работать со страхом",
        tag: "Трудный опыт",
        text: `Страх во время психоделического опыта, нормальная реакция. Это часто естественный ответ на встречу с запутанным клубком воспоминаний, желаний и неразрешённых проблем. Страх не значит что что-то идёт не так.

Что помогает:
– Дыши медленно и глубоко от диафрагмы. Поверхностное дыхание, признак сопротивления. Глубокое, признак отпускания
– Концентрируйся на музыке
– Отдайся эффектам, сопротивление обычно усиливает дискомфорт
– Попроси проводника просто подержать тебя за руку
– Напомни себе: ты сам выбрал пережить этот опыт

Майкл Поллан: «Доверяйте, отпускайте и будьте открытыми. Всегда двигайтесь к чему-то, а не пытайтесь убежать. Спросите: кто ты, и что ты делаешь в моём сознании?»

Переживание умирания, одно из самых частых и пугающих. Но это внутреннее переживание. С твоим телом всё в порядке. Это может быть первой реакцией личности на осознание того что ты больше чем твоя личность.

Советовать дышать лучше в форме напоминания, «Дыхание», а не указания, «Дыши». В изменённом состоянии сознания директивы воспринимаются тяжелее.`,
      },
      {
        emoji: "🌌",
        title: "Смерть эго",
        tag: "Феномен опыта",
        text: `Смерть эго, полная временная потеря ощущения себя как отдельной личности. Человек бодрствует и функционирует, но не может вспомнить своё имя, пол, историю, кто он такой. Граница между «я» и окружающим миром растворяется.

Уильям Джеймс в XIX веке называл это «самоотдачей», юнгианская психология, «психической смертью». В суфизме это фана, растворение себя в божественном единстве. В дзен-буддизме, анатта, осознание иллюзорности эго как источника страдания.

Психоделики, наиболее изученный путь к этому состоянию. Мозговая сеть пассивного режима работы (DMN) отвечает за формирование эго и самоидентичности. Психоделики временно подавляют её активность, отсюда ощущение растворения границ «я».

Клинические исследования псилоцибина показали: глубина мистического опыта и растворения эго во время сессии предсказывает эффективность лечения депрессии. В исследовании терапевтически резистентной депрессии (Roseman et al., 2018) со снижением симптомов через пять недель коррелировала именно интенсивность этих переживаний, а не сила сенсорных эффектов.

Опыт может быть двояким. Одни описывают его как лёгкость, будто груз биографического «я» снят с тела. Для других, дезориентирующий и пугающий: ты в комнате и не знаешь как сюда попал и сколько это продлится.

Смерть эго, не цель и не достижение. Это возможное измерение опыта. Насколько глубоко ты войдёшь и что с этим сделаешь, вопрос подготовки, контекста и интеграции.`,
      },
      {
        emoji: "🎵",
        title: "Музыка как инструмент",
        tag: "Практика",
        text: `В большинстве культур использующих растения для исцеления музыка помогает переходить с одного уровня осознания на другой. Во время сессии она превращается в многослойное звуковое полотно, большинству людей кажется что она исходит из собственного тела.

Рекомендации по выбору:
– Первый час: инструментальная, без слов, спокойная
– Классика которая работает: Реквием Брамса, Адажио Барбера, Третья симфония Горецкого
– Специально созданные плейлисты: East Forest, Music for Mushrooms (Spotify), плейлист Уильяма Ричардса из Johns Hopkins
– После первого часа: избегай музыки с узнаваемыми словами, они отвлекают и уводят в конкретные образы
– Вторая половина: можно любую, включая любимую музыку путешественника

Слушай с закрытыми глазами это усиливает воздействие. Маска для сна помогает.

Даже в глубоких состояниях когда человек может не слышать звуки, музыка всё равно поддерживает и страхует, как сетка для воздушной гимнастики.`,
      },
      {
        emoji: "🪞",
        title: "Осторожно с интерпретацией в моменте",
        tag: "Важно",
        text: `Один из менее очевидных рисков, опасная интерпретация того что пришло в опыте.

Люди могут чувствовать что вещество «сказало им» уйти с работы, расстаться с партнёром, что они подверглись насилию, или что они должны стать шаманами. Иногда эти послания, не буквальная истина, а выражение бессознательного. Прежде чем действовать, исследуй их с опытным человеком.

Поощряй путешественника просто быть с опытом, оставляя обсуждение на период после сессии. Не стоит в моменте пытаться понять происходящее это задача интеграции.

Хорошая реакция проводника на любое переживание путешественника: мягкое приглашение пойти дальше, «Всё хорошо. Хочешь узнать больше?». Когда путешественник чувствует себя в безопасности, ему легче достичь расширенного состояния и запомнить опыт.

Если путешественник попал в «луп», повторяет один и тот же вопрос или фразу, помогает совет «вернуться к музыке». Но не настаивай, в изменённом состоянии настойчивость может восприниматься как отвержение.`,
      },
      {
        emoji: "🛡️",
        title: "Роль проводника во время сессии",
        tag: "Для проводников",
        text: `Сопровождение в психоделическом путешествии, священная работа. Твоя задача, удерживать пространство, а не направлять содержание опыта.

Главные принципы:
– Не принимай вещества изменяющие сознание до или во время сессии
– Не предпринимай действий сексуального характера даже если тебя об этом попросят, человек под воздействием психоделика не способен на осознанное согласие
– Не высказывай своё мнение о личных отношениях или решениях путешественника
– Не навязывай духовные интерпретации, у каждого свой способ встретиться с тем что важно

Будь уравновешенным. Чем более ты сфокусирован, тем более эффективным проводником будешь. Исследования показали: в большинстве случаев путешественник испытывает беспокойство именно тогда, когда проводник взволнован.

Если нужно выйти в туалет, скажи об этом. Не терпи долго, путешественник почувствует твоё напряжение. Когда вернёшься, скажи что тебя не было всего несколько минут, для него могло пройти много внутреннего времени.

Контактный кайф. Проводник может испытывать яркие воспоминания о собственном опыте или ощущения близкие к расширенным состояниям. Это нормально, и не должно мешать твоей роли.`,
      },
    ],
  },

  // ─────────────────────────────────────────────
  // РАЗДЕЛ 3, ПОСЛЕ ОПЫТА
  // ─────────────────────────────────────────────
  {
    id: "after",
    label: "После опыта",
    articles: [
      {
        emoji: "🆘",
        title: "Если стало плохо",
        tag: "Неотложное",
        text: `Сначала отличи два разных «плохо». Бывает тяжело психологически: страх, паника, ощущение, что это никогда не кончится. А бывает плохо физически, и это уже про тело. Психологическое почти всегда проходит с поддержкой. Физическое может быть неотложным.

Если тяжело психологически. В большинстве случаев это временно и отступает, когда вещество перестаёт действовать. Не борись и не убегай. Смени обстановку на спокойную: тише звук, мягче свет, меньше людей, можно выйти на воздух. Дыши медленно. Напомни себе: ты принял вещество, это его действие, ты в безопасности, это пройдёт. Если рядом тот, кому плохо, просто будь рядом, можно подержать за руку, не спорь с тем, что человек видит, мягко возвращай его в «здесь и сейчас». Лучше сидеть или лежать на боку, чтобы при рвоте не подавиться. Не добавляй ещё вещества и не «сглаживай» алкоголем.

Когда тяжёлое не проходит. Обычно острое состояние отступает за несколько часов. Но не всегда. Если спустя сутки и дольше человек не приходит в себя, теряет связь с реальностью, появляются бред или паранойя, это уже не «само пройдёт», а повод обратиться к психиатру. Такое бывает нечасто и чаще у тех, кто склонен к психическим расстройствам или мешал вещества.

Про HPPD коротко. Иногда после психоделика какое-то время остаются зрительные следы: ореолы вокруг предметов, вспышки, шлейфы за движением, «визуальный снег». Это называют HPPD. В отличие от психоза, человек понимает, что эти образы нереальны. Чаще всё проходит само, но если тянется и мешает жить, это не лечится терпением, стоит показаться специалисту.

Когда это уже скорая. Звони в неотложку, не раздумывая, если есть хоть что-то из этого: судороги; боль в груди, очень частый или сбивчивый пульс, обморок; высокая температура с сильной мышечной скованностью и спутанностью; трудно дышать или потеря сознания; рвота, которая не прекращается; реальная угроза, что человек навредит себе или другим. Не тяни из страха последствий: помощь важнее.

Что сказать медикам. Честно скажи, что было принято: какое вещество, примерно сколько, когда и с чем сочеталось, особенно антидепрессанты, литий, стимуляторы. Это не «сдать» человека. Именно от этого зависит, как его будут лечить, и иногда это спасает жизнь.

Большинство тяжёлых моментов психологические и проходят с поддержкой. Но если состояние тянется дольше суток или дело в теле, нужен специалист. Подробнее про сочетания смотри «Опасные сочетания и противопоказания», а спокойные техники для трудного момента на вкладке «Сложный опыт».`,
      },
      {
        emoji: "⚡",
        title: "Нейропластическое окно, первые 72 часа",
        tag: "Нейронаука",
        text: `Психоделики временно возвращают мозгу повышенную пластичность, способность формировать новые связи и перестраивать старые. Это не метафора это задокументированный нейробиологический процесс.

Ключевой белок, BDNF, нейротрофический фактор мозга. Его называют «удобрением для нейронов», он стимулирует рост новых клеток и укрепляет связи. Психоделики повышают его уровень. Депрессия снижает.

Временная шкала:
– Первые 72 часа: период наибольшей пластичности. Важны отдых и записи, не решения
– Первая неделя: самое продуктивное время для работы с тем что поднялось
– Первый месяц: инсайты оседают, рефлексия особенно важна
– До года: для стабилизации глубоких личностных изменений требуется время

Вот почему интеграция в первые дни так важна. Мозг буквально открыт к изменениям, используй это осознанно. Не заполняй это время лишними стимулами, встречами, алкоголем. Дай опыту осесть.

Информационная и социальная гигиена. В это открытое окно мозг сильнее обычного чувствителен не только к твоим инсайтам, но и к среде вокруг. Чужие мнения, оценки, споры и то, что ты читаешь и смотришь, в эти дни заходят глубже и сильнее формируют тебя. Поэтому береги своё пространство: выбирай, с кем делиться, отложи разборки и чужие оценки, сбавь поток новостей и ленты. Дай опыту осесть в тишине, прежде чем впускать в него чужие голоса.`,
      },
      {
        emoji: "◎",
        title: "Что такое интеграция",
        tag: "Основа",
        text: `Слово «интеграция» происходит от латинского integer, целый, полный. Интеграция психоделического опыта это процесс возвращения к целостности. Не анализ. Не интерпретация. Встраивание того что произошло в живую ткань жизни.

После сессии человек часто возвращается с новыми перспективами и желанием перемен. Без интеграции эти откровения и озарения исчезают очень быстро.

Что помогает:
– Записать то что возникло во время опыта это позволяет удержать и заякорить содержание
– Поговорить о пережитом с опытным человеком
– Не торопиться с выводами и жизненными решениями

Откровения психоделического опыта часто нельзя понимать буквально, им нужна расшифровка. Но смысл ты находишь сам. Хороший специалист помогает не тем, что выдаёт готовое толкование, а тем, что поддерживает процесс и твою психику.

Если опыт поднял тяжёлое, тревогу или старую травму, или ты застрял, имеет смысл обратиться к психологу. Его задача психологическая работа и поддержка, а не толкование твоих инсайтов: их значение остаётся твоим.

Один трип может изменить всё. Интеграция это то что делает изменение реальным и устойчивым.`,
      },
      {
        emoji: "⏳",
        title: "Не торопись с выводами",
        tag: "Важно",
        text: `В первые несколько недель после путешествия не принимай меняющих жизнь решений.

Некоторые люди преждевременно переоценивают отношения с романтическим партнёром. Другие решают бросить работу, переехать, стать шаманом. Иногда эти решения правильные, но принятые в период нейропластической открытости они могут быть продиктованы волной а не глубиной.

Исключение, немедленный отказ от вредящего тебе поведения: чрезмерного употребления алкоголя, наркотиков. Здесь откладывать не нужно.

Дай себе время. Настоящие инсайты никуда не денутся. Если через месяц ты всё ещё чувствуешь что нужно что-то изменить это уже не импульс. Это понимание.

После опыта ты можешь лучше чем когда-либо осознать, кто в твоей жизни даёт тебе энергию, а кто забирает. Как с едой, будь с теми кто тебя питает.`,
      },
      {
        emoji: "🕳️",
        title: "Духовный байпас",
        tag: "Ловушка",
        text: `Духовный байпас это когда психоделический опыт используется как способ избежать реальной психологической работы.

Вместо того чтобы встретиться с болью, тревогой, непроработанной травмой, человек прячется за инсайтом. «Я всё понял на церемонии», «я уже через это прошёл», и реальная работа не делается. Это выглядит как интеграция. Но ею не является.

Признаки духовного байпаса:
– Ощущение что ты «выше» проблем обычной жизни
– Избегание терапии с помощью духовных объяснений
– Постоянный поиск новых опытов вместо проработки старых
– Раздражение когда кто-то указывает на реальные проблемы которые не исчезли

Инсайт это не работа. Инсайт это приглашение к работе. Разница важна.`,
      },
      {
        emoji: "🔄",
        title: "Как часто повторять опыт",
        tag: "Важно",
        text: `Гильдия проводников рекомендует минимум полгода между опытами. Исследования Международного фонда перспективных исследований (6 лет, Менло-Парк) показали: для стабилизации глубоких личностных изменений требуется как минимум год.

Это про глубокую самостоятельную работу. В клинике интервалы короче, но там это лечение под структурированным сопровождением, а не самостоятельная практика: например, в исследованиях псилоцибина при депрессии две дозы давали с интервалом в три недели, в работе по резистентной депрессии с разницей в семь дней, а в протоколе по ПТСР сессии шли примерно через каждые две недели. Отдельно есть чистая фармакология: к классическим психоделикам быстро растёт толерантность, она перекрёстная между ЛСД, грибами и мескалином, и чувствительность восстанавливается примерно за одну-две недели, поэтому повторять «через день» бессмысленно, эффект будет слабее.

Гнаться за повторением вспышки почти никогда не срабатывает. Это как снимать новую фотографию поверх другой на том же кадре плёнки, изображение будет замутнено.

Если ты чувствуешь что «должен» как можно скорее снова принять психоделик, скорее всего тебе нужно посмотреть в лицо проблеме которую избегаешь. Это чувство не является приказом от твоего высшего «Я» принять психоделик.

Помни: твой опыт, не просто эффект вещества. Ему способствовало сочетание препарата, намерения, обстановки и поддержки. Пренебрежение любой из этих переменных снизит ценность любого последующего опыта.`,
      },
      {
        emoji: "🤝",
        title: "Когда нужна помощь специалиста",
        tag: "Поддержка",
        text: `Если процесс с психоделиком заставляет задуматься о серьёзных изменениях в жизни или начать работу над серьёзными личными проблемами, лучше всего делать это при поддержке специалиста.

Обратись за помощью если:
– Трудный опыт не отпускает спустя несколько недель
– Появились симптомы острого стресса или диссоциации которые не проходят
– Опыт поднял травматический материал с которым сложно справиться самостоятельно
– Ты чувствуешь желание повторять опыт слишком часто
– Ты принимаешь важные жизненные решения в состоянии эйфории после опыта

Редко но реально: после трудного опыта с грибами или аяуаской могут появиться симптомы которые требуют специализированной психологической помощи. Это не значит что что-то сломалось это значит что нужна поддержка.

Психотерапевтические интеграционные сессии помогают обработать психологический материал опыта надлежащим образом.`,
      },
    ],
  },

  // ─────────────────────────────────────────────
  // РАЗДЕЛ 4, КОНТЕКСТ И ЭТИКА
  // ─────────────────────────────────────────────
  {
    id: "context",
    label: "Контекст и этика",
    articles: [
      {
        emoji: "🌍",
        title: "Коренные народы и их мудрость",
        tag: "Корни",
        text: `Всё о чём мы говорим, психоделические церемонии, работа с намерением, интеграция через сообщество это не современные изобретения. Это тысячелетние традиции коренных народов.

Аяуаска используется как духовная медицина коренными сообществами Амазонии на протяжении веков. Пейот, более 3500 лет народами Мексики и юго-запада США. Псилоцибиновые грибы, тысячи лет мазатеками и другими мезоамериканскими культурами.

Очевидно что коренным общинам с давней историей использования этих растений не нужны подобные руководства. Аяуаска, пейот, грибы, часть их культурно-духовной системы, включающей безопасные способы работы с ними и методы интеграции опыта в повседневную жизнь общины.

Психоделический ренессанс на Западе многим обязан этим традициям. И у нас есть ответственность, помнить об этом. Не романтизировать, не присваивать, а уважать. Признавать источники. Поддерживать права коренных народов на их собственные традиции и знания.`,
      },
      {
        emoji: "⚖️",
        title: "Биопиратство",
        tag: "Этика",
        text: `Биопиратство это присвоение знаний, практик и биологических ресурсов коренных народов без их согласия и без справедливого вознаграждения.

В психоделическом пространстве это выражается по-разному. Западные компании патентуют производные аяуаски. Церемониальные практики копируются и продаются без понимания их контекста. Популяция пейотного кактуса истощается из-за психоделического туризма. Популяция жабы Bufo alvarius под угрозой из-за массовых церемоний.

Рост популярности камбо на Западе поднял острый вопрос о правах племён Катукина, Яваnаhua и других на свои знания. Бразильское правительство запретило коммерциализацию камбо в 2004 году именно после жалоб традиционных сообществ.

Что можно делать:
– Узнавать о происхождении практики которую ты используешь
– Поддерживать организации защищающие права коренных народов
– Выбирать ретриты и организаторов которые работают с коренными сообществами а не вопреки им`,
      },
      {
        emoji: "💊",
        title: "Психоделический ренессанс, кому он служит",
        tag: "Критический взгляд",
        text: `Мы живём в период беспрецедентного интереса к психоделикам со стороны науки, медицины и бизнеса. Это хорошая новость, и одновременно повод для внимательности.

Хорошее. Клинические исследования псилоцибина, МДМА и кетамина показывают реальные результаты в лечении депрессии, ПТСР, зависимостей. Это меняет психиатрию.

Тревожное. Корпоратизация психоделической медицины создаёт риск что терапия станет доступной только для состоятельных людей. Венчурный капитал входит в пространство которое десятилетиями развивалось сообществами, активистами и коренными народами.

Биопиратство масштабируется, компании патентуют производные растений которые использовались тысячелетиями без какой-либо компенсации коренным сообществам.

Доступность. Если психоделическая терапия станет легальной но останется доступной только за тысячи долларов за сессию, ренессанс обслужит рынок, а не людей.

Психоделический ренессанс должен служить людям, а не фармрынку. Это не данность это то за что нужно работать.`,
      },
      {
        emoji: "📚",
        title: "Что почитать и посмотреть",
        tag: "Подборка",
        text: `Несколько книг и один фильм, которые дают опору в теме: классика психонавтики, взгляд первооткрывателей и трезвая наука. Без эзотерики и без хайпа. Идут по порядку, от самых ранних к свежим.

Олдос Хаксли, «Двери восприятия» (1954). Короткое эссе, с которого во многом начался весь психоделический язык XX века: опыт с мескалином и идея мозга как «редуцирующего клапана». Фундамент, на который опирались и шестидесятые, и сегодняшние разговоры о сознании.

Тимоти Лири, Ральф Метцнер, Ричард Альперт, «Психоделический опыт» (1964). Манифест эпохи: трое будущих икон движения переписывают «Тибетскую книгу мёртвых» как руководство по сессии. Ценно не как инструкция, а как документ, по которому видно, как думали и на что надеялись пионеры.

Рам Дасс (Ричард Альперт), «Будь здесь и сейчас» (1971). Тот же Альперт, но после: гарвардский психолог уходит от психоделиков к духовному поиску и пишет культовую книгу. Хорошо показывает, куда людей вело дальше, к вопросу, что делать с опытом после самих веществ.

Альберт Хофманн, «ЛСД, мой трудный ребёнок» (1979). От первооткрывателя ЛСД: как вещество родилось в лаборатории, стало надеждой психиатрии и потом «трудным ребёнком». Трезвый взгляд изнутри, без романтизации.

Станислав Гроф, «За пределами мозга» (1985). Отец трансперсональной психологии обобщает огромный опыт ЛСД-психотерапии и предлагает свою карту глубин психики. Плотная, но важная книга для тех, кто хочет понять психонавтскую сторону опыта изнутри.

Теренс Маккенна, «Пища богов» (1992). Самый яркий рассказчик психоделической культуры со своей теорией о роли грибов в эволюции человека. Читать стоит как мощную и спорную идею и образец этого типа мышления, помня, что часть его гипотез наука не подтверждает.

Рик Страссман, «ДМТ, молекула духа» (2001). Первое за десятилетия официальное клиническое исследование DMT на людях. Видно, как устроена строгая научная работа с психоделиком и чем она отличается от самостоятельных трипов.

Майкл Поллан, «Как изменить своё сознание» (2018, рус. «Мир иной»). Лучшая отправная точка: журналист спокойно и по фактам проходит историю, науку и собственный опыт, от расцвета психоделиков до запрета и нынешнего возвращения. Лечит сразу и от страшилок, и от восторженного хайпа.

И фильм. «How to Change Your Mind» (Netflix, 2022), четырёхсерийный документальный мини-сериал по книге Поллана, с ним самим в роли ведущего. По серии на каждое вещество, LSD, псилоцибин, МДМА и мескалин: история, наука и нынешний ренессанс. На русском есть дубляж. Хороший вход для тех, кому легче смотреть, чем читать.`,
      },
      {
        emoji: "🔬",
        title: "Как следить за исследованиями",
        tag: "Контекст",
        text: `Психоделическая наука сейчас движется быстро, и заголовки часто бегут впереди фактов. Чтобы не вестись на хайп, полезно понимать, как читать исследования.

Кое-что уже стало знаковым. Псилоцибин при тревоге и депрессии у людей с угрожающим жизни раком давал заметное и стойкое улучшение, это показали в Университете Джонса Хопкинса и в Нью-Йоркском университете в 2016 году. Терапия с МДМА при тяжёлом ПТСР дошла до третьей фазы клинических испытаний. Это серьёзные сигналы. Но всё это только начинается. Не зря нынешний этап называют психоделическим ренессансом: тему по-настоящему начали изучать совсем недавно, выборки часто небольшие, и многое ещё предстоит подтвердить в больших независимых исследованиях.

Что важно различать. Маленькое раннее исследование или опрос это не то же самое, что большое контролируемое испытание. «Прорыв на мышах» ещё не лекарство для людей: путь от животных к клинике долгий и часто обрывается. Один случай или серия случаев показывают, что так бывает, но не доказывают правило.

Почему в клинике эффект сильнее, чем в жизни. В исследованиях отбирают подходящих людей, готовят их, ведут под наблюдением и сопровождают интеграцией. В самостоятельной практике всего этого нет, поэтому переносить клинические цифры прямо на себя не стоит.

На что ещё смотреть. Кто оплатил работу и нет ли конфликта интересов, сколько было участников, с чем сравнивали, повторили ли результат другие команды. Одна громкая статья это повод заинтересоваться, а не готовый вывод.

За свежими исследованиями, а заодно за наркополитикой и вообще темой веществ, удобно следить в нашем Telegram-канале «независимый портал»: t.me/nezavisimiy_portal. Там новое выходит по мере появления, а здесь, в Базе знаний, собрано то, что меняется редко.`,
      },
    ],
  },

  // ─────────────────────────────────────────────
  // РАЗДЕЛ 5, РАСТЕНИЯ, ВЕЩЕСТВА И ПРАКТИКИ
  // ─────────────────────────────────────────────
  {
    id: "substances",
    label: "Вещества и практики",
    articles: [
      {
        emoji: "🍄‍🟫",
        title: "Псилоцибиновые грибы",
        tag: "Классический психоделик",
        text: `Более 180 видов грибов содержат псилоцибин и псилоцин. В языке ацтеков назывались «теонанакатль», плоть богов. Используются мазатеками и другими мезоамериканскими культурами тысячи лет.

Псилоцибин был выделен Альбертом Хофманном в 1958 году из мексиканских грибов. В организме превращается в псилоцин, психоактивное вещество действующее на серотониновые 5-HT2A рецепторы.

Эффекты начинаются через 30 минут и длятся 4–6 часов. Интенсивные изменения восприятия, настроения и сознания. Возможны яркие визуальные образы с закрытыми глазами, растворение границ эго, мистические переживания. По данным Global Drug Survey, вещество с наименьшим количеством обращений за экстренной медицинской помощью среди всех психоделиков.

Дозировка (сухие грибы Psilocybe cubensis): микродоза, до 0,25 г, низкая, 0,25–1 г, средняя, 1–2,5 г, высокая, 2,5–5 г, очень высокая, более 5 г.

Снижение рисков. Главное это сет и сеттинг. В период сильного стресса лучше повременить. Депрессия это не запрет: псилоцибин изучается и применяется при депрессии, но работать с ней стоит под наблюдением специалиста, а не в одиночку. При сборе в природе обязательна точная идентификация: некоторые виды рода Galerina смертельно ядовиты. Людям с историей психоза или биполярного расстройства только в клиническом контексте.

Правовой статус. Псилоцибин и псилоцин, Список I Венской конвенции 1971 года. В большинстве стран незаконны.`,
      },
      {
        emoji: "🌿",
        title: "Аяуаска",
        tag: "Растительный отвар",
        text: `«Аяуаска» на языке кечуа, «верёвка мёртвых» или «лиана мёртвых». Отвар из лианы Banisteriopsis caapi и листьев Psychotria viridis, источника ДМТ. Бета-карболины лианы ингибируют МАО, позволяя ДМТ действовать орально. Используется коренными народами Амазонии на протяжении веков.

Первое документальное упоминание, иезуитские миссионеры в 1737 году. В последние десятилетия распространилась по всему миру через церкви Санто-Дайми, Уняо до Вежетал и неошаманические практики.

Эффекты длятся 4–6 часов: интенсивные видения, глубокая интроспекция, встречи с сущностями, тошнота и рвота, традиционно воспринимается как очищение. Исследования показывают антидепрессивный и противотревожный потенциал при длительном использовании.

Снижение рисков. Строгие противопоказания по препаратам: антидепрессанты (особенно СИОЗС), ИМАО, амфетамины, МДМА, опасные сочетания, возможен гипертонический криз. Нельзя сочетать с Буфо альвариус, ждать минимум 24 часа. Психологические противопоказания: шизофрения, биполярное расстройство, пограничное расстройство личности. Качество церемонии и надёжность ведущего критически важны.

Правовой статус. ДМТ, вещество Списка I. Сам отвар не находится под международным контролем, но правовой статус варьируется по странам. В России, незаконна.`,
      },
      {
        emoji: "🌵",
        title: "Пейот",
        tag: "Священный кактус",
        text: `Lophophora williamsii, безколючковый кактус пустынь северной Мексики и юго-запада США. Растёт очень медленно, до 15–20 лет до зрелости. Основное психоактивное вещество, мескалин. Древнейшие образцы найдены в пещере в Техасе, возраст 3780–3660 до н.э., содержали 2% мескалина.

Среди народов Wixarika (Уичоль) пейот занимает центральное место в духовной жизни. Ежегодное паломничество в Wirikuta, священнейший акт их календаря. Сегодня около 250 000 членов Нативной американской церкви используют пейот как религиозное таинство.

Эффекты начинаются через 2–3 часа и длятся 10–14 часов. Яркие видения, глубокие изменения восприятия, духовные переживания. Тошнота и рвота, частые спутники. Мескалин немного более стимулирующий чем псилоцибин.

Дозировка мескалина: пороговая, 100 мг, низкая, 100–200 мг, средняя, 200–300 мг, высокая, 300–500 мг.

Снижение рисков. Эффекты появляются медленно, не повторять дозу. Не сочетать со стимуляторами. Пейот, охраняемый вид под угрозой исчезновения из-за чрезмерного сбора.

Правовой статус. Мескалин, Список I. В США использование разрешено только членам Нативной американской церкви.`,
      },
      {
        emoji: "🌵",
        title: "Сан-Педро",
        tag: "Андский кактус",
        text: `Echinopsis pachanoi, колонновидный кактус Южной Америки с историей использования более 8000 лет. Ископаемые остатки датируются 6800–6200 до н.э., один из древнейших известных психоактивных растений. Традиционный ритуал, «меса». В андской медицине используется целителями Yachakkuna для диагностики болезней и очищения.

Содержит мескалин, эффекты аналогичны пейоту, длительность 10–14 часов. Горький вкус, часто вызывает тошноту. Концентрация мескалина варьируется от 0,053% до 4,7%, дозировка непредсказуема.

Дозировка мескалина та же что для пейота: средняя, 200–300 мг. Традиционные дозы обычно ниже психоактивного порога.

Снижение рисков. Те же правила что для пейота. Эффекты появляются через 2 часа, не торопиться с повторной дозой. Не сочетать со стимуляторами. В отличие от пейота сан-педро растёт быстро и не находится под угрозой исчезновения.

Правовой статус. Мескалин, Список I. Кактус как растение в большинстве стран не контролируется, но приготовление отвара для употребления может быть незаконным.`,
      },
      {
        emoji: "🌳",
        title: "Ибога",
        tag: "Африканский кустарник",
        text: `Tabernanthe iboga, кустарник тропической Западной Африки. Центральное место в ритуалах инициации культуры Бвити в Габоне. Ритуал длится пять дней и символизирует смерть и перерождение, человека бережно ведут через него всем сообществом. Основной алкалоид, ибогаин.

В 1962 году Говард Лотсоф обнаружил антиаддиктивные свойства: шесть из семи его друзей с героиновой зависимостью после однократного приёма прекратили употребление без синдрома отмены. Сегодня клиники ибогаина работают в Бразилии, Мексике, Таиланде, ЮАР.

Опыт описывают как глубоко психотерапевтический, «онейрофренический»: состояние бодрствующего сна с интенсивной визуальной интроспекцией длиной 7–12 часов. Ибогаин особенно эффективен при опиоидной зависимости через уникальный механизм нейропластичности (GDNF).

Снижение рисков. Серьёзные кардиологические риски, обязательны ЭКГ и медицинский контроль. Противопоказан при болезнях сердца, аритмии. Опасные взаимодействия с многими препаратами. Только в контролируемых условиях с медицинским персоналом.

Правовой статус. Не входит в списки ООН, но незаконен в США, Австралии, Бельгии, Франции, Швейцарии и ряде других стран.`,
      },
      {
        emoji: "🌀",
        title: "Сальвия дивинорум",
        tag: "Диссоциатив · Особый механизм",
        text: `Многолетнее растение из гор Сьерра-Мадре в Мексике. Используется масатеками для гадания и лечения. По словам Марии Сабины, применялась когда не хватало грибов. Активное вещество, сальвинорин А: наиболее мощное природное психоактивное вещество из известных, в 10 раз сильнее псилоцибина. Действует на каппа-опиоидные рецепторы, принципиально другой механизм чем классические психоделики.

Традиционный ритуал: ночью, в тишине и темноте, жевание листьев парами. Сок не глотают, держат во рту для всасывания через слизистую.

При курении эффекты наступают за секунды, пик, 2–20 минут, общая длительность около 30 минут. Возможны: глубокие диссоциативные состояния, ощущение слияния с предметами, внетелесные переживания. Около половины людей не повторяют опыт после первого раза.

Снижение рисков. Высокий риск неприятных опытов особенно при курении экстрактов. На высоких дозах человек не осознаёт окружающей обстановки, реальный риск падений. Обязательно присутствие трезвого сопровождающего. Тихая, безопасная обстановка без посторонних стимулов.

Правовой статус. Не входит в списки ООН. Контролируется в Австралии, Японии, ряде штатов США и европейских стран.`,
      },
      {
        emoji: "🍄",
        title: "Мухомор (Amanita muscaria)",
        tag: "Особый механизм · Высокий риск",
        text: `Красная шляпка с белыми точками, один из самых узнаваемых грибов в мире. Используется в шаманских практиках народов Сибири тысячи лет. Первые свидетельства, лингвистический анализ североазиатских языков 4000 лет до н.э. Активные вещества, иботеновая кислота и мусцимол. Механизм действия принципиально отличается от псилоцибина, не серотониновая система.

Сухой гриб сильнее свежего: при сушке иботеновая кислота превращается в более активный мусцимол.

Эффекты наступают через 2–3 часа и длятся 6–8 часов. Три фазы: стимуляция и энергия → сонливость и покой → психоделические эффекты. Возможны потеря равновесия, мышечные спазмы, макропсия/микропсия, тошнота.

Снижение рисков. Концентрация алкалоидов крайне вариабельна, дозировка практически непредсказуема. Критически важна точная идентификация: Amanita phalloides (бледная поганка) внешне похожа и смертельно ядовита. \n\nКрасный (Amanita muscaria) и пантерный (Amanita pantherina) мухоморы это близкие виды. У красного шляпка красная с белыми хлопьями, у пантерного бурая с белыми бородавками. Действующие вещества у них одни и те же, иботеновая кислота и мусцимол, и отравление протекает похоже, его так и называют синдромом пантерина-мускария. Главная опасность не в том, что один «сильнее» другого, а в том, что количество токсинов сильно колеблется от гриба к грибу, и пороговая доза может оказаться даже в одном экземпляре. Поэтому доза непредсказуема. Тяжёлое отравление даёт спутанность, чередование возбуждения и оглушения, мышечные судороги, иногда конвульсии, и специфического антидота нет. Смертельные исходы крайне редки, но именно непредсказуемость дозы и риск тяжёлого делирия делают эти грибы неподходящими для новичков.

Правовой статус. Не контролируется в большинстве стран. Запрещена в Нидерландах, Великобритании и Румынии.`,
      },
      {
        emoji: "🌾",
        title: "Рапе",
        tag: "Священная смесь",
        text: `Рапе (произносится «ра-пэ»), сакральная смесь тонко измельчённого табака и золы различных растений, используемая коренными народами Амазонии. Состав варьируется в зависимости от племени и назначения, именно зола различных растений определяет «сорт» рапе и его свойства. Традиция использования насчитывает сотни лет среди народов Катукина, Яваnаhua, Хуни Куин, Матсес и других.

Рапе не вдыхают, его вдувают через специальные трубки. Курипа (или куриппа), V-образная трубка для самостоятельного применения. Тепи, прямая трубка когда один человек вдувает другому. Порошок наносится поочерёдно в каждую ноздрю.

Традиционно применяется для очищения, центрирования, открытия церемонии, усиления концентрации и охотничьих практик. Не является психоделиком в классическом смысле, не вызывает галлюцинаций.

Снижение рисков. Табак в составе, никотиновая нагрузка, не подходит людям с сердечно-сосудистыми заболеваниями. Качество и состав рапе сильно варьируются в зависимости от источника. Важно знать происхождение и состав используемой смеси.

Дозировка. Действующее вещество в рапэ это никотин, причём табак часто Nicotiana rustica, где никотина в разы больше, чем в сигаретном. Стандартной дозы нет: по химическому анализу содержание никотина в разных рапэ колеблется примерно от 6 до 48 мг на грамм, а у ручных церемониальных смесей со щелочной золой никотин всасывается быстрее и бьёт сильнее. Поэтому одинаковая на вид щепотка из разных смесей может действовать совершенно по-разному.

Чувствительным людям, некурящим и тем, кто легче по весу, осторожнее вдвойне: обычная церемониальная доза может ударить заметно сильнее. Начинай с очень маленького количества, сиди, а не стой, и пусть рядом будет опытный человек. Не добавляй ещё потому что «пока не зацепило»: эффект приходит быстро. В традиции сильную телесную реакцию, слёзы, слюну, испарину, тошноту, часто понимают как очищение, и это нормальная часть практики. Но есть грань: если накрывает резкая слабость, холодный пот, частое или сбивчивое сердцебиение, сильная дурнота, это уже похоже на никотиновую передозировку, и тут нужно остановиться, сесть или лечь и не принимать больше.

Этический вопрос. Как и с другими практиками коренных народов, важно понимать источник и уважать контекст традиции.`,
      },
      {
        emoji: "🐸",
        title: "Буфо альвариус",
        tag: "5-MeO-DMT",
        text: `Incilius alvarius, жаба из пустыни Сонора (Мексика и юго-запад США). Кожные железы содержат 5-MeO-DMT, одно из самых мощных известных психоактивных веществ. Одна жаба производит до 75 мг этого вещества.

Эффекты при вдыхании паров наступают в течение нескольких секунд, пик, менее 1 минуты, общая продолжительность, 15–20 минут. Описывается как полное растворение эго, ощущение космического единства, опыт смерти и перерождения. Нет визуального контента как у классических психоделиков, только чистое переживание. Очень высокая интенсивность: возможны непроизвольные движения, крики, плач без осознания.

Снижение рисков. Нельзя сочетать с аяуаской, ждать минимум 24 часа. Нельзя сочетать с ИМАО, задокументированные смерти. Обязательно присутствие трезвого сопровождающего, во время опыта человек теряет контроль над телом.

Экологический вопрос. Массовый психоделический туризм нанёс серьёзный ущерб популяции жабы. Синтетический 5-MeO-DMT, этичная альтернатива без вреда для животного.

Правовой статус. 5-MeO-DMT не входит в списки ООН, но контролируется в США (Список I) и Великобритании.`,
      },
      {
        emoji: "🐸",
        title: "Камбо",
        tag: "Очищение · Не психоделик",
        text: `Камбо, секрет кожи лягушки Phyllomedusa bicolor из амазонских лесов. Используется племенами Катукина, Яваnаhua, Кашинауа и Матсес. Традиционно применяется для очищения тела и духа, лечения «панамы» (неудачи на охоте) и укрепления силы. Лягушка не убивается, после извлечения секрета отпускается обратно в лес.

Камбо не является психоделиком и не вызывает галлюцинаций. Содержит биоактивные пептиды воздействующие на сердечно-сосудистую и желудочно-кишечную системы. Наносится на небольшие ожоги на коже. Острые эффекты: учащение пульса до 190 уд/мин, изменение давления, потоотделение, тошнота, рвота, диарея, длятся 5–20 минут. После, ощущение ясности и силы.

Снижение рисков. Противопоказан при болезнях сердца и высоком давлении. Зафиксированы случаи гепатита и как минимум один случай внезапной смерти. Гипонатриемия, реальный риск при избыточном питье воды (6–10 литров опасны). Нет клинических исследований.

Биопиратство. Рост популярности камбо на Западе поднял острый вопрос о правах коренных народов. В Бразилии запрещена коммерциализация с 2004 года после жалоб традиционных сообществ.

Правовой статус. Не регулируется в большинстве стран.`,
      },
      {
        emoji: "⚗️",
        title: "ДМТ",
        tag: "Синтетическое · Эндогенное",
        text: `N,N-диметилтриптамин присутствует в десятках растений и, по имеющимся данным, вырабатывается в самом организме человека, обнаружен в крови, моче и спинномозговой жидкости. В аяуаске активируется орально благодаря ИМАО. В чистом виде неактивен орально, используется в форме курения или вдыхания.

Опыт при курении длится 10–20 минут но субъективно воспринимается как значительно дольше. Немедленное и тотальное изменение реальности. Характерны встречи с сущностями, геометрические гиперпространства, ощущение контакта с иными измерениями. Многие описывают как наиболее интенсивный опыт в своей жизни.

Снижение рисков. Нельзя сочетать с ИМАО без специальной подготовки, опасное взаимодействие. Обязательно сидячее или лежачее положение, полная потеря двигательного контроля. Присутствие сопровождающего. Опыт может быть психологически тяжёлым, не подходит при нестабильном психическом состоянии.

Правовой статус. Список I в большинстве стран.`,
      },
      {
        emoji: "💊",
        title: "МДМА",
        tag: "Синтетическое · Терапевтический контекст",
        text: `3,4-метилендиоксиметамфетамин. Синтезирован в 1912 году. В 1970–80-х использовался психотерапевтами до запрета. Не классический психоделик, эмпатоген/энтакторен. Механизм: массивный выброс серотонина, дофамина и норадреналина.

Терапевтический потенциал. MAPS провела Фазу 3 клинических испытаний МДМА-ассистированной терапии ПТСР. Результаты: 67% участников больше не соответствовали критериям ПТСР после трёх сессий. Механизм, временное снижение активности миндалины позволяет работать с травматическим материалом без захлёстывающего страха.

Эффекты длятся 3–5 часов: эйфория, эмпатия, открытость, снижение страха и самокритики.

Снижение рисков. Гипертермия, главный физический риск при активности. Нельзя сочетать с ИМАО, литием, многими антидепрессантами. Нейротоксичность при частом использовании. Рекомендуемый интервал, минимум 3 месяца. Противопоказан при болезнях сердца, гипертонии, биполярном расстройстве.

Правовой статус. Список I в большинстве стран. В терапевтических протоколах, под медицинским контролем.`,
      },
      {
        emoji: "🔬",
        title: "ЛСД",
        tag: "Синтетическое · Полувековая история",
        text: `Диэтиламид лизергиновой кислоты. Синтезирован Альбертом Хофманном в 1938 году, психоактивные свойства обнаружены случайно в 1943-м. Производное спорыньи, паразитического гриба ржи. Действует на серотониновые 5-HT2A рецепторы, тот же механизм что псилоцибин и мескалин, но с более длительным эффектом.

Хофманн о первом опыте: «Привычная реальность и эго которое её переживало, растворились. И незнакомое эго испытало иную, незнакомую реальность».

Эффекты длятся 8–12 часов, иногда до 14. Классические психоделические эффекты с особым акцентом на визуальные изменения, усиление цветов, движение поверхностей, синестезия. Более стимулирующий чем псилоцибин.

Дозировка: низкая, 50–75 мкг, средняя, 100–150 мкг, высокая, 200–400 мкг.

Снижение рисков. Длительность требует особой подготовки пространства и времени, минимум 12 свободных часов. На чёрном рынке часто подделывается другими веществами, тест-полоски обязательны. HPPD (персистирующее расстройство восприятия), редкий но реальный риск.

Правовой статус. Список I практически везде.`,
      },
      {
        emoji: "🌬️",
        title: "Холотропное дыхание",
        tag: "Практика · Без вещества",
        text: `Разработано Станиславом Грофом и Кристиной Гроф в 1970-х как немедикаментозный метод доступа к расширенным состояниям сознания. Гроф создал его после запрета ЛСД, как легальную альтернативу для психотерапевтической работы.

Метод сочетает три элемента: учащённое дыхание (гипервентиляция по специальной схеме), специально подобранную музыку и работу с телом при необходимости. Сессия длится 2–3 часа, после, интеграция через рисование мандалы и вербальное обсуждение. Работа всегда в парах: дышащий и ситтер (сопровождающий).

Состояния могут быть очень интенсивными и сопоставимы с психоделическими опытами: встречи с архетипическими образами, проживание перинатальных матриц (по Грофу), телесные катарсисы, мистические переживания.

Снижение рисков. Противопоказано при сердечно-сосудистых заболеваниях, эпилепсии, глаукоме, беременности, острых психотических состояниях. Гипервентиляция вызывает физиологические изменения, обязательно медицинское собеседование перед участием. Требует подготовленного фасилитатора, не подходит для самостоятельной практики.

Холотропное дыхание показывает: доступ к глубинным слоям психики возможен не только через химию.`,
      },
    ],
  },
];

function LibraryPage() {
  const [openSection, setOpenSection] = useState(null);
  const [openArticle, setOpenArticle] = useState(null);
  const articleRefs = useRef({});
  const sectionRefs = useRef({});
  useEffect(() => {
    if (!openArticle) return;
    const el = articleRefs.current[openArticle];
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        const y = el.getBoundingClientRect().top + window.scrollY - 56;
        window.scrollTo({ top: y < 0 ? 0 : y, behavior: "smooth" });
      } catch (e) {}
    });
  }, [openArticle]);

  useEffect(() => {
    if (openSection === null) return;
    const el = sectionRefs.current[openSection];
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        const y = el.getBoundingClientRect().top + window.scrollY - 56;
        window.scrollTo({ top: y < 0 ? 0 : y, behavior: "smooth" });
      } catch (e) {}
    });
  }, [openSection]);

  return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadBook /><SectionTitle size={28} style={{ marginBottom: 0 }}>БАЗА ЗНАНИЙ</SectionTitle>
      </div>
      <Sub>Подготовка · Интеграция · Вещества и растения</Sub>

      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        {LIBRARY_SECTIONS.map((section, si) => (
          <div key={section.id} ref={el => { if (el) sectionRefs.current[si] = el; }}>
            {/* Section header */}
            <button onClick={() => {
              setOpenSection(openSection === si ? null : si);
              setOpenArticle(null);
            }} style={{
              width:"100%", background:"var(--surface)",
              boxShadow: openSection===si ? "var(--sunken)" : "var(--raised)",
              border:"none", borderRadius:0,
              padding:"14px 16px", cursor:"pointer",
              display:"flex", justifyContent:"space-between", alignItems:"center",
            }}>
              <FolderIcon size={26} open={openSection===si} />
              <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16,
                letterSpacing:"0.06em", textAlign:"left",
                color: T.ink,
                flex:1, paddingLeft:10, paddingRight:8 }}>
                {section.label.toUpperCase()}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:11, color: T.muted,
                  fontFamily:"'Montserrat', sans-serif" }}>
                  {section.articles.length} статьи
                </span>
                <span style={{ fontSize:16, color: T.muted }}>
                  {openSection===si ? "↑" : "↓"}
                </span>
              </div>
            </button>

            {/* Articles */}
            {openSection === si && (
              <div style={{ border:`1.5px solid ${T.accent}`, borderTop:"none",
                borderRadius:"0 0 12px 12px", overflow:"hidden" }}>
                {section.articles.map((article, ai) => (
                  <div key={ai} ref={el => { if (el) articleRefs.current[`${si}-${ai}`] = el; }}>
                    <button onClick={() => setOpenArticle(openArticle === `${si}-${ai}` ? null : `${si}-${ai}`)}
                      style={{
                        width:"100%", background: T.white,
                        border:"none", borderTop: ai > 0 ? `1px solid ${T.light}` : "none",
                        padding:"14px 16px", cursor:"pointer",
                        display:"flex", justifyContent:"space-between", alignItems:"center",
                        textAlign:"left",
                      }}>
                      <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                        <Emoji char={article.emoji} size={18} />
                        <div>
                          <div style={{ fontWeight:700, fontSize:13, color:T.ink,
                            fontFamily:"'Montserrat', sans-serif" }}>
                            {article.title}
                          </div>
                          <div style={{ fontSize:10, color:T.muted, marginTop:1,
                            fontFamily:"'Montserrat', sans-serif", textTransform:"uppercase",
                            letterSpacing:"0.06em" }}>
                            {article.tag}
                          </div>
                        </div>
                      </div>
                      <span style={{ color:T.muted, fontSize:14, flexShrink:0, marginLeft:8 }}>
                        {openArticle===`${si}-${ai}` ? "↑" : "↓"}
                      </span>
                    </button>

                    {openArticle === `${si}-${ai}` && (
                      <div style={{ background:"#fff", borderTop:`1px solid ${T.light}`,
                        padding:"16px", fontSize:13, color:T.ink, lineHeight:1.8,
                        fontFamily:"'Montserrat', sans-serif", whiteSpace:"pre-line" }}>
                        {linkify(article.text)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop:20, background:"var(--surface)", boxShadow:"var(--sunken)", padding:16, textAlign:"center" }}>
        <div style={{ fontSize:12, color:T.mid, lineHeight:1.6, marginBottom:12,
          fontFamily:"'Montserrat', sans-serif" }}>
          Нужна поддержка специалиста по интеграции?
        </div>
        <a href="https://ayawaskaretreat.com/ru/integration" style={{
          display:"block", background:"var(--surface)", boxShadow:"var(--raised)", color:"#000080",
          padding:"12px", borderRadius:10, textDecoration:"none",
          fontWeight:600, fontSize:13, fontFamily:"'Montserrat', sans-serif",
        }}>
          ayawaskaretreat.com → Интеграция
        </a>
      </div>
    </Screen>
  );
}

// ── Crisis ────────────────────────────────────────────────────────────────────
function BoxBreathing() {
  const [phase, setPhase] = useState(0);
  const [count, setCount] = useState(4);
  const [active, setActive] = useState(false);
  const PHASES = ["Вдох", "Задержка", "Выдох", "Задержка"];
  const HINTS  = ["медленно, через нос", "не дыши", "медленно, через рот", "не дыши"];
  const COLORS = [T.accent, "#6c3483", "#1a6a8a", "#1a7a3e"];

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setCount(c => {
        if (c <= 1) { setPhase(p => (p + 1) % 4); return 4; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  const color = active ? COLORS[phase] : T.light;
  const size = 130;
  const s = 4; // stroke width

  // Четыре стороны как отдельные линии
  // Фаза 0 = верх, 1 = право, 2 = низ, 3 = лево
  const sides = [
    { x1: s, y1: s, x2: size-s, y2: s },           // top
    { x1: size-s, y1: s, x2: size-s, y2: size-s },  // right
    { x1: size-s, y1: size-s, x2: s, y2: size-s },  // bottom
    { x1: s, y1: size-s, x2: s, y2: s },             // left
  ];

  return (
    <Card style={{ textAlign:"center", marginBottom:12 }}>
      <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
        color:T.muted, marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>
        Дыхание · Box Breathing
      </div>

      {/* Square */}
      <div style={{ position:"relative", width:size, height:size, margin:"0 auto 14px" }}>
        <svg width={size} height={size}>
          {sides.map((side, i) => (
            <line key={i} {...side}
              stroke={T.light}
              strokeWidth={s} strokeLinecap="square"
            />
          ))}
          {active && (
            <line {...sides[phase]}
              stroke={COLORS[phase]}
              strokeWidth={s} strokeLinecap="square"
              style={{ transition:"stroke 0.3s" }}
            />
          )}
        </svg>
        {/* Center */}
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:48,
            color: active ? color : T.muted, lineHeight:1, transition:"color 0.3s" }}>
            {count}
          </div>
          <div style={{ fontSize:11, fontWeight:700, color: active ? color : T.muted,
            fontFamily:"'Montserrat', sans-serif", transition:"color 0.3s",
            textTransform:"uppercase", letterSpacing:"0.06em" }}>
            {active ? PHASES[phase] : ""}
          </div>
        </div>
      </div>

      <div style={{ fontSize:12, color:T.mid, marginBottom:14, minHeight:18,
        fontFamily:"'Montserrat', sans-serif" }}>
        {active ? HINTS[phase] : "Вдох · Задержка · Выдох · Задержка"}
      </div>

      {/* Phase dots */}
      <div style={{ display:"flex", justifyContent:"center", gap:8, marginBottom:16 }}>
        {PHASES.map((p, i) => (
          <div key={i} style={{ textAlign:"center" }}>
            <div style={{ width:28, height:3, borderRadius:2, margin:"0 auto 4px",
              background: active && i === phase ? COLORS[i] : T.light,
              transition:"background 0.3s" }} />
            <div style={{ fontSize:9, color: active && i === phase ? COLORS[i] : T.muted,
              fontFamily:"'Montserrat', sans-serif", fontWeight:600,
              textTransform:"uppercase", letterSpacing:"0.04em",
              transition:"color 0.3s" }}>
              {p}
            </div>
          </div>
        ))}
      </div>

      <Btn onClick={() => { setActive(a => !a); setPhase(0); setCount(4); }}
        variant={active ? "ghost" : "primary"} style={{ maxWidth:200, margin:"0 auto" }}>
        {active ? "Остановить" : "Начать"}
      </Btn>
    </Card>
  );
}

function Grounding521() {
  const [step, setStep] = useState(0);
  const steps = [
    { n:"5", label:"Вижу", q:"Назови вслух 5 вещей которые видишь прямо сейчас" },
    { n:"4", label:"Слышу", q:"Назови 4 звука которые слышишь" },
    { n:"3", label:"Ощущаю", q:"Назови 3 ощущения в теле прямо сейчас" },
    { n:"2", label:"Чувствую кожей", q:"Назови 2 вещи которые чувствуешь кожей" },
    { n:"1", label:"Чувствую вкус", q:"Назови 1 вкус который ощущаешь" },
  ];
  const done = step >= steps.length;

  return (
    <Card style={{ marginBottom:12 }}>
      <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
        color:T.muted, marginBottom:12, fontFamily:"'Montserrat', sans-serif" }}>
        Заземление 5-4-3-2-1
      </div>
      {done ? (
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:28, marginBottom:8 }}>✓</div>
          <div style={{ fontSize:13, color:T.mid, fontFamily:"'Montserrat', sans-serif", marginBottom:12 }}>
            Хорошо. Ты здесь. Ты в настоящем.
          </div>
          <Btn variant="ghost" onClick={() => setStep(0)} style={{ maxWidth:180, margin:"0 auto" }}>
            Повторить
          </Btn>
        </div>
      ) : (
        <div>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ flex:1, height:4, borderRadius:2,
                background: i < step ? T.accent : i === step ? T.accent : T.light,
                opacity: i < step ? 0.4 : 1 }} />
            ))}
          </div>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:42, color:T.accent,
            textAlign:"center", lineHeight:1, marginBottom:4 }}>
            {steps[step].n}
          </div>
          <div style={{ fontWeight:700, fontSize:14, color:T.ink, textAlign:"center",
            marginBottom:8, fontFamily:"'Montserrat', sans-serif" }}>
            {steps[step].label}
          </div>
          <div style={{ fontSize:13, color:T.mid, textAlign:"center", lineHeight:1.6,
            marginBottom:16, fontFamily:"'Montserrat', sans-serif" }}>
            {steps[step].q}
          </div>
          <Btn onClick={() => setStep(s => s + 1)}>
            Готово →
          </Btn>
        </div>
      )}
    </Card>
  );
}

function EmergencyNumbers() {
  const [open, setOpen] = useState(false);
  const numbers = [
    { country:"Россия и СНГ", number:"103" },
    { country:"Европа", number:"112" },
    { country:"Таиланд", number:"1669" },
    { country:"Индия", number:"102" },
    { country:"США / Канада", number:"911" },
    { country:"Израиль", number:"101" },
    { country:"Другая страна", number:"112" },
  ];

  return (
    <div style={{ marginBottom:12 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width:"100%", background:"var(--surface)", boxShadow:"var(--sunken)", border:"none",
        borderRadius:14, padding:"14px 16px", cursor:"pointer", textAlign:"left",
        display:"flex", justifyContent:"space-between", alignItems:"center",
      }}>
        <div>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16,
            letterSpacing:"0.06em", color:T.accent }}>
            НУЖНА ПОМОЩЬ ПРЯМО СЕЙЧАС
          </div>
          <div style={{ fontSize:12, color:T.mid, marginTop:2,
            fontFamily:"'Montserrat', sans-serif" }}>
            Экстренные номера по странам
          </div>
        </div>
        <span style={{ fontSize:18, color:T.accent }}>{open ? "↑" : "↓"}</span>
      </button>

      {open && (
        <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none",
          borderTop:"none", borderRadius:"0 0 14px 14px", padding:"0 16px 16px" }}>
          <div style={{ fontSize:13, color:T.ink, lineHeight:1.7, marginBottom:14,
            fontFamily:"'Montserrat', sans-serif", paddingTop:12,
            borderTop:`1px solid #ffd0cc` }}>
            Скажи диспетчеру:<br/>
            <strong>«Мне плохо физически, нужна помощь»</strong><br/>
            Назови адрес где ты находишься.
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {numbers.map(({ country, number }) => (
              <div key={country} style={{ display:"flex", justifyContent:"space-between",
                alignItems:"center", padding:"8px 0",
                borderBottom:`1px solid rgba(192,57,43,0.1)` }}>
                <span style={{ fontSize:13, color:T.mid, fontFamily:"'Montserrat', sans-serif" }}>
                  {country}
                </span>
                <a href={`tel:${number}`} style={{
                  fontFamily:"'Bebas Neue', sans-serif", fontSize:22,
                  color:T.accent, textDecoration:"none", letterSpacing:"0.05em",
                }}>
                  {number}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const DIFFICULT_TOPICS = [
  {
    emoji: "🌑",
    title: "Тёмная ночь души",
    tag: "Что это",
    text: `Термин пришёл от испанского мистика XVI века Иоанна Креста. В психологию его ввели Станислав и Кристина Гроф, они разграничили духовные переживания от психотических эпизодов.

Тёмная ночь это состояние глубокой дезориентации. Ощущение что всё прежнее рухнуло, привычные опоры исчезли. Это не психоз.

Ключевое отличие: человек в состоянии духовного кризиса сохраняет нить осознанности. Он знает что с ним происходит что-то необычное. Он пугается, но не теряет связь с реальностью полностью.

Если ты прошёл через это, ты не сломан. Ты проходишь через трансформацию. Это не конец. Это, возможно, начало.`,
  },
  {
    emoji: "🪞",
    title: "Духовный байпас",
    tag: "Ловушка",
    text: `Духовный байпас это когда психоделический или духовный опыт используется как способ избежать реальной психологической работы.

Вместо того чтобы встретиться с болью, тревогой, непроработанной травмой, человек прячется за инсайтом. «Я всё понял на церемонии», «я уже через это прошёл», и реальная работа не делается.

Это выглядит как интеграция. Но ею не является.

Признаки: ощущение что ты «выше» проблем обычной жизни, избегание терапии с помощью духовных объяснений, постоянный поиск новых опытов вместо проработки старых.

Инсайт это не работа. Инсайт это приглашение к работе.`,
  },
  {
    emoji: "🧭",
    title: "Как работать с трудным опытом",
    tag: "Практика",
    text: `Если опыт был тяжёлым, первое что нужно это признать. Просто признать: да, это было тяжело.

Заземление. Вернись в тело. Почувствуй ноги на полу. Выпей воды. Физический контакт с реальностью помогает нервной системе успокоиться.

Не торопись с интерпретацией. Трудный опыт не обязан немедленно иметь смысл. Позволь себе не знать.

Говори. Найди человека которому можно рассказать. Проговаривание само по себе является частью интеграции.

Работай с телом. Трудные опыты часто оседают в теле. Мягкое движение, дыхательные практики, йога помогают высвободить это.

Дай время. Некоторые опыты интегрируются месяцами. Не требуй от себя быстрого восстановления.`,
  },
];

function CrisisPage() {
  const [mode, setMode] = useState(null); // null | "now" | "difficult"
  const [openTopic, setOpenTopic] = useState(null);

  if (mode === null) return (
    <Screen>
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadAlert /><SectionTitle size={28} style={{ marginBottom: 0 }}>КРИЗИС</SectionTitle>
      </div>
      <Sub>Выбери что тебе нужно прямо сейчас</Sub>

      <div style={{ display:"flex", flexDirection:"column", gap:12, marginTop:8 }}>
        <button onClick={() => setMode("now")} style={{
          background:"var(--surface)", boxShadow:"var(--raised)", border:"none",
          padding:"18px 16px", cursor:"pointer", textAlign:"left",
          display:"flex", alignItems:"center", gap:12,
        }}>
          <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center",
            width:26, height:26, background:"#c0392b", color:"#fff", fontWeight:700, fontSize:17, flexShrink:0 }}>!</span>
          <span style={{ display:"block" }}>
            <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:20,
              letterSpacing:"0.04em", color:"#c0392b", marginBottom:6 }}>
              МНЕ ПЛОХО ПРЯМО СЕЙЧАС
            </div>
            <div style={{ fontSize:13, color:T.mid, lineHeight:1.5,
              fontFamily:"'Montserrat', sans-serif" }}>
              Острое состояние. Нужна помощь здесь и сейчас.
            </div>
          </span>
        </button>

        <button onClick={() => setMode("difficult")} style={{
          background:"var(--surface)", boxShadow:"var(--raised)", border:"none",
          padding:"18px 16px", cursor:"pointer", textAlign:"left",
        }}>
          <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:18,
            letterSpacing:"0.04em", color:T.ink, marginBottom:6, whiteSpace:"nowrap" }}>
            У МЕНЯ БЫЛ СЛОЖНЫЙ ОПЫТ
          </div>
          <div style={{ fontSize:13, color:T.mid, lineHeight:1.5,
            fontFamily:"'Montserrat', sans-serif" }}>
            Хочу разобраться в том что произошло.
          </div>
        </button>
      </div>
    </Screen>
  );

  if (mode === "now") return (
    <Screen>
      <BackBtn onClick={() => setMode(null)} />

      <div style={{ background:"var(--surface)", boxShadow:"var(--sunken)", border:"none",
        borderRadius:14, padding:"16px", textAlign:"center", marginBottom:16 }}>
        <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:22,
          letterSpacing:"0.06em", color:T.accent, marginBottom:6 }}>
          ТЫ В БЕЗОПАСНОСТИ
        </div>
        <div style={{ fontSize:13, color:T.mid, lineHeight:1.6,
          fontFamily:"'Montserrat', sans-serif" }}>
          Это временное состояние. Оно пройдёт.
        </div>
      </div>

      <BoxBreathing />
      <Grounding521 />
      <EmergencyNumbers />

      <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:4 }}>
        <a href="https://ayawaskaretreat.com/ru/integration" target="_blank" rel="noopener noreferrer"
          onClick={(e) => {
            const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
            if (tg && tg.openLink) { e.preventDefault(); tg.openLink("https://ayawaskaretreat.com/ru/integration"); }
          }}
          style={{
          display:"block", background:"var(--surface)", boxShadow:"var(--raised)", color:"#000080",
          padding:"14px", textDecoration:"none",
          fontWeight:700, fontSize:14, textAlign:"center",
          fontFamily:"'Montserrat', sans-serif",
        }}>
          ayawaskaretreat.com → Интеграция
        </a>
      </div>
    </Screen>
  );

  if (mode === "difficult") return (
    <Screen>
      <BackBtn onClick={() => setMode(null)} />
      <SectionTitle size={28}>СЛОЖНЫЙ ОПЫТ</SectionTitle>
      <Sub>Никто не говорит об этом достаточно честно. Психоделические путешествия бывают тяжёлыми. Иногда очень. Это не значит что что-то пошло не так.</Sub>

      <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
        {DIFFICULT_TOPICS.map((topic, i) => (
          <div key={i}>
            <button onClick={() => setOpenTopic(openTopic === i ? null : i)} style={{
              width:"100%", background: T.white,
              border:`1.5px solid ${openTopic===i ? T.accent : T.light}`,
              borderRadius: openTopic===i ? "14px 14px 0 0" : 14,
              padding:"14px 16px", cursor:"pointer", textAlign:"left",
              display:"flex", justifyContent:"space-between", alignItems:"center",
            }}>
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                <Emoji char={topic.emoji} size={20} />
                <div>
                  <div style={{ fontWeight:700, fontSize:14, color: openTopic===i ? T.accent : T.ink,
                    fontFamily:"'Montserrat', sans-serif" }}>{topic.title}</div>
                  <div style={{ fontSize:10, color:T.muted, marginTop:1,
                    fontFamily:"'Montserrat', sans-serif", textTransform:"uppercase",
                    letterSpacing:"0.06em" }}>{topic.tag}</div>
                </div>
              </div>
              <span style={{ color: openTopic===i ? T.accent : T.muted, fontSize:16 }}>
                {openTopic===i ? "↑" : "↓"}
              </span>
            </button>
            {openTopic === i && (
              <div style={{ background:"#fff8f8", border:`1.5px solid ${T.accent}`,
                borderTop:"none", borderRadius:"0 0 14px 14px",
                padding:"16px", fontSize:13, color:T.ink, lineHeight:1.8,
                fontFamily:"'Montserrat', sans-serif", whiteSpace:"pre-line" }}>
                {topic.text}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        <a href="https://ayawaskaretreat.com/ru/integration" target="_blank" rel="noopener noreferrer"
          onClick={(e) => {
            const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
            if (tg && tg.openLink) { e.preventDefault(); tg.openLink("https://ayawaskaretreat.com/ru/integration"); }
          }}
          style={{
          display:"block", background:"var(--surface)", boxShadow:"var(--raised)", color:"#000080",
          padding:"14px", textDecoration:"none",
          fontWeight:700, fontSize:14, textAlign:"center",
          fontFamily:"'Montserrat', sans-serif",
        }}>
          ayawaskaretreat.com → Интеграция
        </a>
      </div>
    </Screen>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
let nextId = 1;
const uid = () => ++nextId;



const CURATED_MUSIC = [
  { title:"East Forest, Music for Mushrooms", note:"Цельное пятичасовое полотно на всю сессию. Написано специально под псилоцибиновый опыт.", url:"https://open.spotify.com/album/2LFyfGcBrrsvF8tECUs5gK" },
  { title:"Johns Hopkins, плейлист Уильяма Ричардса", note:"Классика и сакральная музыка под всю дугу сессии, от захода до возвращения. Из исследований псилоцибина.", url:"https://open.spotify.com/playlist/7aVExA8Lb72NFNbRBZfJLJ" },
  { title:"Jon Hopkins, Music for Psychedelic Therapy", note:"Спокойный эмбиент, хорош для подготовки, захода и заземления.", url:"https://open.spotify.com/album/2zY5p176SfmupXceLKT6bH" },
  { title:"Marconi Union, Weightless (10 часов)", note:"Медленный эмбиент без ритма и резких переходов, создан вместе с терапевтами звука для снижения тревоги. Не для пика, а для заземления, выхода и сна после опыта.", url:"https://music.apple.com/br/album/weightless-10-hour-version/1325524252?i=1325524269&l=en-GB" },
];

function openMusicLink(u) {
  const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  if (tg && tg.openLink) tg.openLink(u);
  else window.open(u, "_blank");
}

function MusicPage({ onBack }) {
  const [items, setItems] = useState([]);
  const [adding, setAdding] = useState(false);
  const [mtitle, setMtitle] = useState("");
  const [murl, setMurl] = useState("");
  const [openMusic, setOpenMusic] = useState(null);
  const musicRefs = useRef({});

  useEffect(() => {
    (async () => {
      try {
        const raw = await storeGet(MUSIC_KEY);
        if (raw) { try { setItems(JSON.parse(raw) || []); } catch {} }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!openMusic) return;
    const el = musicRefs.current[openMusic];
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        const y = el.getBoundingClientRect().top + window.scrollY - 56;
        window.scrollTo({ top: y < 0 ? 0 : y, behavior: "smooth" });
      } catch (e) {}
    });
  }, [openMusic]);

  function persist(next) {
    setItems(next);
    storeSet(MUSIC_KEY, JSON.stringify(next));
  }
  function add() {
    let u = murl.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    persist([...items, { id: Math.random().toString(36).slice(2), title: mtitle.trim() || u, url: u }]);
    setMtitle(""); setMurl(""); setAdding(false);
  }
  function remove(id) { persist(items.filter(x => x.id !== id)); }

  const heading = { fontWeight:700, fontSize:13, color:T.ink, fontFamily:"'Montserrat', sans-serif",
    textTransform:"uppercase", letterSpacing:"0.06em" };
  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"9px 10px", marginBottom:8,
    background:"#fff", boxShadow:"var(--sunken)", border:"none", fontSize:13,
    fontFamily:"'Montserrat', sans-serif", color:"#000" };
  const ghostBtn = { background:"var(--surface)", boxShadow:"var(--raised)", border:"none", cursor:"pointer",
    padding:"0 14px", fontSize:13, fontWeight:700, color:T.muted, fontFamily:"'Montserrat', sans-serif" };
  const secBtn = (open) => ({ width:"100%", WebkitAppearance:"none", appearance:"none", borderRadius:0,
    background:"var(--surface)", boxShadow: open ? "var(--sunken)" : "var(--raised)", border:"none",
    padding:"13px 34px", cursor:"pointer", position:"relative",
    fontFamily:"'Montserrat', sans-serif", fontWeight:700, fontSize:13, color:T.ink,
    textTransform:"uppercase", letterSpacing:"0.06em", textAlign:"center" });
  const secArrow = { position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", fontSize:11, color:T.mid };

  return (
    <Screen>
      <BackBtn onClick={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:10, color:"#000", marginBottom:6 }}>
        <HeadMusic /><SectionTitle size={28} style={{ marginBottom: 0 }}>МУЗЫКА</SectionTitle>
      </div>
      <Sub>Музыка ничего не весит: мы храним только ссылки, подборки открываются в твоём Spotify или другом приложении. Личные ссылки сохраняются в твоём Telegram.</Sub>

      <div ref={el => { if (el) musicRefs.current["curated"] = el; }}>
        <button onClick={() => setOpenMusic(openMusic === "curated" ? null : "curated")} style={secBtn(openMusic === "curated")}>
          Подборка от приложения
          <span style={secArrow}>{openMusic === "curated" ? "▲" : "▼"}</span>
        </button>
      </div>
      {openMusic === "curated" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginTop:10 }}>
          {CURATED_MUSIC.map((m, i) => (
            <Card key={i}>
              <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:4, fontFamily:"'Montserrat', sans-serif" }}>{m.title}</div>
              <div style={{ fontSize:12, color:T.mid, lineHeight:1.6, marginBottom:10, fontFamily:"'Montserrat', sans-serif" }}>{m.note}</div>
              <Btn onClick={() => openMusicLink(m.url)}>Слушать</Btn>
            </Card>
          ))}
        </div>
      )}

      <div ref={el => { if (el) musicRefs.current["library"] = el; }} style={{ marginTop:12 }}>
        <button onClick={() => setOpenMusic(openMusic === "library" ? null : "library")} style={secBtn(openMusic === "library")}>
          Личная библиотека
          <span style={secArrow}>{openMusic === "library" ? "▲" : "▼"}</span>
        </button>
      </div>
      {openMusic === "library" && (
        <div style={{ marginTop:10 }}>
          {items.length === 0 && !adding && (
            <Sub>Здесь пусто. Добавь ссылку на свой плейлист или альбом, и он сохранится у тебя.</Sub>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {items.map(m => (
              <Card key={m.id}>
                <div style={{ fontWeight:700, fontSize:14, color:T.ink, marginBottom:10, fontFamily:"'Montserrat', sans-serif", wordBreak:"break-word" }}>{m.title}</div>
                <div style={{ display:"flex", gap:8 }}>
                  <div style={{ flex:1 }}><Btn onClick={() => openMusicLink(m.url)}>Слушать</Btn></div>
                  <button onClick={() => remove(m.id)} style={ghostBtn}>Убрать</button>
                </div>
              </Card>
            ))}
          </div>
          {adding ? (
            <Card style={{ marginTop:10 }}>
              <input value={mtitle} onChange={e => setMtitle(e.target.value)} placeholder="Название (необязательно)" style={inputStyle} />
              <input value={murl} onChange={e => setMurl(e.target.value)} placeholder="Ссылка (Spotify, YouTube...)" style={inputStyle} />
              <div style={{ display:"flex", gap:8 }}>
                <div style={{ flex:1 }}><Btn onClick={add} disabled={!murl.trim()}>Сохранить</Btn></div>
                <button onClick={() => { setAdding(false); setMtitle(""); setMurl(""); }} style={ghostBtn}>Отмена</button>
              </div>
            </Card>
          ) : (
            <div style={{ marginTop:12 }}>
              <Btn onClick={() => setAdding(true)}>+ Добавить свою музыку</Btn>
            </div>
          )}
        </div>
      )}
    </Screen>
  );
}

function AccessGate({ state, onRetry }) {
  const openSupport = () => {
    const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (tg && tg.openTelegramLink) tg.openTelegramLink("https://t.me/psychonaut_support_bot");
    else window.open("https://t.me/psychonaut_support_bot", "_blank");
  };
  return (
    <div style={{ minHeight:"100vh", background:"#008080", display:"flex", alignItems:"center",
      justifyContent:"center", padding:20, fontFamily:"'Montserrat', sans-serif" }}>
      <div style={{ width:"100%", maxWidth:320, background:"var(--surface)", boxShadow:"var(--raised)" }}>
        <div style={{ background:"#000080", color:"#fff", display:"flex", alignItems:"center", gap:6,
          padding:"4px 6px", fontSize:12, fontWeight:700 }}>
          <span>🔒</span><span>Доступ ограничен</span>
        </div>
        <div style={{ padding:"18px 16px", color:"#000" }}>
          {state === "checking" ? (
            <div style={{ fontSize:13, color:"#222", padding:"12px 0", textAlign:"center" }}>Проверяем доступ…</div>
          ) : state === "error" ? (
            <>
              <div style={{ fontSize:22, fontWeight:700, marginBottom:12 }}>НЕТ СВЯЗИ</div>
              <div style={{ fontSize:13, lineHeight:1.6, color:"#222", marginBottom:18 }}>
                Не удалось проверить доступ. Проверь соединение и попробуй снова.
              </div>
              <Btn onClick={onRetry}>Проверить снова</Btn>
            </>
          ) : (
            <>
              <div style={{ fontSize:22, fontWeight:700, letterSpacing:".02em", marginBottom:12 }}>ЗАКРЫТЫЙ ТЕСТ</div>
              <div style={{ fontSize:13, lineHeight:1.6, color:"#222", marginBottom:12 }}>
                Идёт закрытое бета-тестирование. Вход в приложение сейчас только по приглашению.
              </div>
              <div style={{ fontSize:12, lineHeight:1.6, color:"#444", marginBottom:16 }}>
                Если ты в составе тестировщиков, напиши нам.
              </div>
              <div style={{ marginBottom:10 }}>
                <Btn onClick={openSupport}>Связаться: @psychonaut_support_bot</Btn>
              </div>
              <Btn onClick={onRetry}>Проверить снова</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsentScreen({ onDone }) {
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ready = adult && terms && !saving;
  const boxStyle = {
    width:16, height:16, flexShrink:0, background:"#fff", boxShadow:"var(--sunken)",
    color:"#000", fontSize:12, fontWeight:700, lineHeight:"14px", textAlign:"center",
  };
  const openDoc = (path) => {
    const url = (typeof window !== "undefined" ? window.location.origin : "") + path;
    const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, "_blank");
  };
  async function submit() {
    if (!ready) return;
    setSaving(true); setError("");
    const ok = await apiConsentAccept();
    setSaving(false);
    if (ok) onDone();
    else setError("Не удалось сохранить. Проверь соединение и попробуй ещё раз.");
  }
  return (
    <div style={{ minHeight:"100vh", background:"#008080", display:"flex", alignItems:"center",
      justifyContent:"center", padding:16, fontFamily:"'Montserrat', sans-serif" }}>
      <div style={{ width:"100%", maxWidth:360, maxHeight:"92vh", overflowY:"auto",
        background:"var(--surface)", boxShadow:"var(--raised)" }}>
        <div style={{ background:"var(--titlebar)", color:"#fff", padding:"4px 6px", fontSize:12, fontWeight:700 }}>Согласие</div>
        <div style={{ padding:"16px 16px 18px", color:"#000" }}>
          <div style={{ fontSize:20, fontWeight:700, letterSpacing:".02em", marginBottom:14 }}>ПЕРЕД НАЧАЛОМ</div>
          <div onClick={() => setAdult(v => !v)} style={{ display:"flex", gap:10, alignItems:"flex-start", marginBottom:12, cursor:"pointer" }}>
            <div style={boxStyle}>{adult ? "✓" : ""}</div>
            <div style={{ fontSize:13, lineHeight:1.5 }}>Мне есть 18 лет.</div>
          </div>
          <div onClick={() => setTerms(v => !v)} style={{ display:"flex", gap:10, alignItems:"flex-start", marginBottom:10, cursor:"pointer" }}>
            <div style={boxStyle}>{terms ? "✓" : ""}</div>
            <div style={{ fontSize:13, lineHeight:1.5 }}>Я прочитал и согласен с условиями ниже.</div>
          </div>
          <div style={{ display:"flex", gap:16, marginBottom:14, paddingLeft:26, flexWrap:"wrap" }}>
            <span onClick={(e) => { e.stopPropagation(); openDoc("/terms.html"); }}
              style={{ fontSize:12, color:"#000080", textDecoration:"underline", cursor:"pointer" }}>Условия использования</span>
            <span onClick={(e) => { e.stopPropagation(); openDoc("/privacy.html"); }}
              style={{ fontSize:12, color:"#000080", textDecoration:"underline", cursor:"pointer" }}>Политика конфиденциальности</span>
          </div>
          <div style={{ background:"#fff", boxShadow:"var(--sunken)", padding:"10px 12px", fontSize:12, lineHeight:1.6, color:"#222", marginBottom:16 }}>
            Заметки психонавта это инструмент для записи и осмысления собственного опыта. Приложение не предоставляет психоактивные вещества, не организует их приём и не побуждает кого-либо их принимать. Все решения о своём опыте вы принимаете самостоятельно и несёте за них полную ответственность. Приложение не является медицинской услугой и не заменяет консультацию врача или психотерапевта.
          </div>
          <Btn onClick={submit} disabled={!ready}>{saving ? "Сохраняем…" : "Продолжить"}</Btn>
          {error ? (<div style={{ fontSize:11, color:T.accent, textAlign:"center", marginTop:10, fontFamily:"'Montserrat', sans-serif" }}>{error}</div>) : null}
        </div>
      </div>
    </div>
  );
}

// ── SketchPad (зарисовка, рисование пальцем, сохранение только в телефон) ─────
const SKETCH_PALETTE = ["#000000","#7f7f7f","#880015","#ed1c24","#ff7f27","#fff200","#22b14c","#00a2e8","#3f48cc","#a349a4",
  "#ffffff","#c3c3c3","#b97a57","#ffaec9","#ffc90e","#e6e0a8","#b5e61d","#99d9ea","#7092be","#008080"];

function sketchStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function SketchPad({ onClose }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const dprRef = useRef(1);
  const drawing = useRef(false);
  const last = useRef(null);
  const start = useRef(null);
  const snap = useRef(null);
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(6);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [vh, setVh] = useState(null);
  const [, setHist] = useState(0);

  useEffect(() => {
    const c = canvasRef.current, box = wrapRef.current;
    if (!c || !box) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    dprRef.current = dpr;
    const r = box.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);

  useEffect(() => {
    let tg = null;
    try { tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null; } catch (e) {}
    try { if (tg && tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}
    try { if (tg && tg.lockOrientation) tg.lockOrientation(); } catch (e) {}
    try { if (tg && tg.expand) tg.expand(); } catch (e) {}
    const applyVh = () => {
      try {
        const h = (tg && tg.viewportStableHeight) ? tg.viewportStableHeight : window.innerHeight;
        if (h) setVh(h);
      } catch (e) { try { setVh(window.innerHeight); } catch (e2) {} }
    };
    applyVh();
    try { if (tg && tg.onEvent) tg.onEvent("viewportChanged", applyVh); } catch (e) {}
    window.addEventListener("resize", applyVh);
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = "none";
    return () => {
      try { if (tg && tg.enableVerticalSwipes) tg.enableVerticalSwipes(); } catch (e) {}
      try { if (tg && tg.unlockOrientation) tg.unlockOrientation(); } catch (e) {}
      try { if (tg && tg.offEvent) tg.offEvent("viewportChanged", applyVh); } catch (e) {}
      window.removeEventListener("resize", applyVh);
      document.body.style.overscrollBehavior = prev;
    };
  }, []);

  function ctx() { return canvasRef.current.getContext("2d"); }
  function pos(e) {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * (c.width / r.width)), y: Math.round((e.clientY - r.top) * (c.height / r.height)) };
  }
  function pushUndo() {
    try {
      const u = undoStack.current;
      u.push(canvasRef.current.toDataURL("image/png"));
      if (u.length > 12) u.shift();
      redoStack.current = [];
      setHist(h => h + 1);
    } catch (e) {}
  }
  function restore(url) {
    const c = canvasRef.current, g = ctx();
    const img = new Image();
    img.onload = () => { g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); };
    img.src = url;
  }
  function undo() {
    const u = undoStack.current;
    if (!u.length) return;
    try { redoStack.current.push(canvasRef.current.toDataURL("image/png")); if (redoStack.current.length > 12) redoStack.current.shift(); } catch (e) {}
    restore(u.pop());
    setDirty(true);
    setHist(h => h + 1);
  }
  function redo() {
    const r = redoStack.current;
    if (!r.length) return;
    try { undoStack.current.push(canvasRef.current.toDataURL("image/png")); if (undoStack.current.length > 12) undoStack.current.shift(); } catch (e) {}
    restore(r.pop());
    setDirty(true);
    setHist(h => h + 1);
  }
  function clearAll() {
    pushUndo();
    const c = canvasRef.current, g = ctx();
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    setDirty(true);
  }

  function hexRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function floodFill(x, y, hex) {
    const c = canvasRef.current, g = ctx();
    const w = c.width, ht = c.height;
    if (x < 0 || y < 0 || x >= w || y >= ht) return;
    const img = g.getImageData(0, 0, w, ht), d = img.data;
    const at = (px, py) => (py * w + px) * 4;
    const s = at(x, y);
    const tr = d[s], tg = d[s + 1], tb = d[s + 2], ta = d[s + 3];
    const [fr, fg, fb] = hexRgb(hex);
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8 && ta === 255) return;
    const tol = 48;
    const match = i => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) + Math.abs(d[i + 3] - ta) <= tol;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy0] = stack.pop();
      let cy = cy0;
      while (cy >= 0 && match(at(cx, cy))) cy--;
      cy++;
      let left = false, right = false;
      while (cy < ht && match(at(cx, cy))) {
        const i = at(cx, cy);
        d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
        if (cx > 0) { if (match(at(cx - 1, cy))) { if (!left) { stack.push([cx - 1, cy]); left = true; } } else left = false; }
        if (cx < w - 1) { if (match(at(cx + 1, cy))) { if (!right) { stack.push([cx + 1, cy]); right = true; } } else right = false; }
        cy++;
      }
    }
    g.putImageData(img, 0, 0);
  }
  function spray(p) {
    const g = ctx(), dpr = dprRef.current, rad = size * dpr * 1.6, n = Math.round(size * 1.4) + 6;
    g.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * rad;
      g.fillRect(Math.round(p.x + Math.cos(a) * rr), Math.round(p.y + Math.sin(a) * rr), dpr, dpr);
    }
  }
  function dot(p, col) {
    const g = ctx();
    g.fillStyle = col;
    g.beginPath();
    g.arc(p.x, p.y, Math.max(0.5, size * dprRef.current / 2), 0, Math.PI * 2);
    g.fill();
  }
  function strokeTo(a, b, col) {
    const g = ctx();
    g.strokeStyle = col; g.lineWidth = size * dprRef.current; g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  function drawShape(a, b) {
    const g = ctx();
    g.strokeStyle = color; g.lineWidth = size * dprRef.current; g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath();
    if (tool === "line") { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
    else if (tool === "rect") { g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
    else if (tool === "ellipse") { g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); }
    else if (tool === "triangle") { const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y); g.moveTo((x1 + x2) / 2, y1); g.lineTo(x2, y2); g.lineTo(x1, y2); g.closePath(); }
    g.stroke();
  }

  function down(e) {
    e.preventDefault();
    const p = pos(e);
    pushUndo();
    setDirty(true);
    if (tool === "fill") { floodFill(p.x, p.y, color); return; }
    drawing.current = true; start.current = p; last.current = p;
    if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "triangle") {
      snap.current = ctx().getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
    } else if (tool === "spray") {
      spray(p);
    } else {
      dot(p, tool === "eraser" ? "#ffffff" : color);
    }
  }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const p = pos(e);
    if (tool === "pen" || tool === "brush" || tool === "eraser") { strokeTo(last.current, p, tool === "eraser" ? "#ffffff" : color); last.current = p; }
    else if (tool === "spray") { spray(p); }
    else if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "triangle") { ctx().putImageData(snap.current, 0, 0); drawShape(start.current, p); }
  }
  function up() { drawing.current = false; last.current = null; snap.current = null; }

  function save() {
    const c = canvasRef.current, dpr = dprRef.current;
    const fp = Math.max(2, Math.round(3 * dpr)), bh = Math.round(30 * dpr), band = bh + fp * 2;
    const out = document.createElement("canvas");
    out.width = c.width; out.height = c.height + band;
    const o = out.getContext("2d");
    o.fillStyle = "#ffffff"; o.fillRect(0, 0, out.width, out.height);
    o.drawImage(c, 0, band);
    const edge = Math.max(1, Math.round(dpr));
    o.fillStyle = "#c0c0c0"; o.fillRect(0, 0, out.width, band);
    o.fillStyle = "#ffffff"; o.fillRect(0, 0, out.width, edge); o.fillRect(0, 0, edge, band);
    o.fillStyle = "#808080"; o.fillRect(0, band - edge, out.width, edge); o.fillRect(out.width - edge, 0, edge, band);
    const bx = fp, by = fp, bw = out.width - fp * 2;
    const grad = o.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, "#000080"); grad.addColorStop(1, "#1084d0");
    o.fillStyle = grad; o.fillRect(bx, by, bw, bh);
    o.textBaseline = "middle";
    const cy = by + bh / 2, title = "Заметки психонавта", dt = sketchStamp();
    const fsT = Math.round(14 * dpr), fsD = Math.round(12 * dpr), ic = Math.round(16 * dpr), gap = Math.round(8 * dpr);
    o.font = "700 " + fsT + "px Tahoma, sans-serif"; const wT = o.measureText(title).width;
    o.font = fsD + "px Tahoma, sans-serif"; const wD = o.measureText(dt).width;
    let x = Math.round((out.width - (ic + gap + wT + gap + wD)) / 2);
    o.fillStyle = "#c0c0c0"; o.fillRect(x, cy - ic / 2, ic, ic);
    o.fillStyle = "#000000"; o.fillRect(x, cy - ic / 2, ic, edge); o.fillRect(x, cy - ic / 2, edge, ic);
    x += ic + gap;
    o.textAlign = "left"; o.fillStyle = "#ffffff"; o.font = "700 " + fsT + "px Tahoma, sans-serif";
    o.fillText(title, x, cy);
    x += wT + gap;
    o.fillStyle = "#cfe0f5"; o.font = fsD + "px Tahoma, sans-serif";
    o.fillText(dt, x, cy + Math.round(1 * dpr));
    let dataUrl = "";
    try { dataUrl = out.toDataURL("image/png"); } catch (e) { return; }
    setSaveStatus("sending");
    (async () => {
      try {
        const r = await fetchT(`${API_BASE}/send-sketch`, {
          timeout: 45000,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: tgInitData(), image: dataUrl }),
        });
        if (r.ok) { setSaveStatus("sent"); setDirty(false); }
        else if (r.status === 429) setSaveStatus("limit");
        else setSaveStatus("error");
      } catch (e) { setSaveStatus("error"); }
    })();
  }

  function tryClose() { if (dirty) setConfirmClose(true); else onClose(); }

  const tools = [
    { id: "pen", label: "Ручка" }, { id: "brush", label: "Кисть" }, { id: "spray", label: "Баллончик" },
    { id: "fill", label: "Заливка" }, { id: "eraser", label: "Ластик" },
    { id: "line", label: "Линия" }, { id: "rect", label: "Прямоугольник" }, { id: "ellipse", label: "Овал" }, { id: "triangle", label: "Треугольник" },
  ];
  const toolBtn = (active) => ({ width: 34, height: 34, minWidth: 34, maxWidth: 34, minHeight: 34, maxHeight: 34, flex: "none", flexShrink: 0, flexGrow: 0, padding: 0, lineHeight: 0, boxSizing: "border-box", WebkitAppearance: "none", appearance: "none", borderRadius: 0,
    background: "#c0c0c0", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: active ? "inset 1px 1px #000, inset -1px -1px #fff, inset 2px 2px #808080" : "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" });
  const actBtn = { WebkitAppearance: "none", appearance: "none", borderRadius: 0, background: "#c0c0c0", border: "none", cursor: "pointer",
    fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 13, color: "#000", padding: "9px 8px", flex: 1,
    boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" };

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: vh ? vh : "100%", maxHeight: "100%", overflow: "hidden",
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)", boxSizing: "border-box",
      zIndex: 10000, background: "#c0c0c0", display: "flex", flexDirection: "column",
      boxShadow: "inset -1px -1px #000, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff" }}>
      <div style={{ background: "linear-gradient(90deg,#000080,#1084d0)", color: "#fff", fontWeight: 700, fontSize: 13,
        padding: "5px 6px", display: "flex", alignItems: "center", gap: 6, fontFamily: "'Montserrat', sans-serif" }}>
        <span style={{ width: 16, height: 14, background: "#c0c0c0", boxShadow: "inset -1px -1px #000, inset 1px 1px #fff", flex: "none" }} />
        <span>Зарисовка · Заметки психонавта</span>
        <button onClick={tryClose} style={{ marginLeft: "auto", WebkitAppearance: "none", appearance: "none", borderRadius: 0,
          width: 26, height: 22, background: "#c0c0c0", color: "#000", border: "none", fontWeight: 700, fontSize: 13, cursor: "pointer",
          boxShadow: "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" }}>✕</button>
      </div>

      <div style={{ display: "flex", gap: 2, padding: 3, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flex: "none",
          background: "#c0c0c0", padding: 2, boxShadow: "inset -1px -1px #fff, inset 1px 1px #808080" }}>
          {tools.map(t => (
            <button key={t.id} title={t.label} onClick={() => setTool(t.id)} style={toolBtn(tool === t.id)}>
              <ToolIcon id={t.id} />
            </button>
          ))}
          <div style={{ flex: "none", height: 0, alignSelf: "stretch", margin: "3px 2px", borderTop: "1px solid #808080", borderBottom: "1px solid #ffffff" }} />
          <button title="Отмена" onClick={undo} style={{ ...toolBtn(false), opacity: undoStack.current.length ? 1 : 0.35 }}><ToolIcon id="undo" /></button>
          <button title="Вернуть" onClick={redo} style={{ ...toolBtn(false), opacity: redoStack.current.length ? 1 : 0.35 }}><ToolIcon id="redo" /></button>
          <div style={{ flex: "none", height: 0, alignSelf: "stretch", margin: "3px 2px", borderTop: "1px solid #808080", borderBottom: "1px solid #ffffff" }} />
          <button title="Очистить" onClick={clearAll} style={toolBtn(false)}><ToolIcon id="clear" /></button>
        </div>

        <div ref={wrapRef} style={{ flex: 1, minWidth: 0, background: "#fff", position: "relative",
          boxShadow: "inset -1px -1px #fff, inset 1px 1px #808080, inset -2px -2px #dfdfdf, inset 2px 2px #000" }}>
          <canvas ref={canvasRef}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
            style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
        </div>
      </div>

      <div style={{ margin: "3px 3px 0", padding: 5, background: "#c0c0c0", boxShadow: "inset -1px -1px #fff, inset 1px 1px #808080" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(0, 1fr))", gap: 3, marginBottom: 3 }}>
          {[3, 6, 12].map(sz => (
            <button key={sz} onClick={() => setSize(sz)} style={{ gridColumn: "span 2", WebkitAppearance: "none", appearance: "none", borderRadius: 0,
              height: 30, minWidth: 0, padding: 0, boxSizing: "border-box", background: "#c0c0c0", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: size === sz ? "inset 1px 1px #000, inset -1px -1px #fff, inset 2px 2px #808080" : "inset -1px -1px #000, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf" }}>
              <span style={{ width: sz + 2, height: sz + 2, borderRadius: "50%", background: "#000" }} />
            </button>
          ))}
          <span style={{ gridColumn: "span 4", height: 30, minWidth: 0, background: color,
            boxShadow: "inset -1px -1px #fff, inset 1px 1px #808080, inset -2px -2px #dfdfdf, inset 2px 2px #000" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(0, 1fr))", gap: 3 }}>
          {SKETCH_PALETTE.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ WebkitAppearance: "none", appearance: "none", borderRadius: 0,
              aspectRatio: "1", minWidth: 0, minHeight: 20, padding: 0, boxSizing: "border-box", border: "none", cursor: "pointer", background: c,
              boxShadow: color === c ? "inset 0 0 0 2px #000, 0 0 0 1px #fff" : "inset -1px -1px #fff, inset 1px 1px #808080" }} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, padding: 6 }}>
        <button onClick={save} style={actBtn}>Сохранить в телефон</button>
        <button onClick={tryClose} style={actBtn}>Закрыть</button>
      </div>

      {confirmClose && (
        <MessageBox title="Закрыть зарисовку"
          message="Рисунок нигде не сохранён. Закрыть без сохранения?"
          confirmLabel="Закрыть" cancelLabel="Остаться"
          onConfirm={() => { setConfirmClose(false); onClose(); }}
          onCancel={() => setConfirmClose(false)} />
      )}

      {saveStatus === "sending" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#c0c0c0", padding: "14px 22px", fontFamily: "'Montserrat', sans-serif", fontSize: 13, color: "#000",
            boxShadow: "inset -1px -1px #000, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff" }}>
            Отправляю рисунок...
          </div>
        </div>
      )}
      {saveStatus === "sent" && (
        <MessageBox title="Готово"
          message="Рисунок отправлен тебе в личку от бота «Заметки психонавта». Открой чат, нажми на фото и сохрани его в галерею."
          confirmLabel="Понятно" onConfirm={() => setSaveStatus(null)} />
      )}
      {saveStatus === "error" && (
        <MessageBox title="Не удалось"
          message="Не получилось отправить рисунок. Проверь связь и попробуй ещё раз."
          confirmLabel="Закрыть" onConfirm={() => setSaveStatus(null)} />
      )}
      {saveStatus === "limit" && (
        <MessageBox title="Лимит на сегодня"
          message="Можно сохранять до десяти рисунков в сутки. На сегодня максимум исчерпан, попробуй завтра."
          confirmLabel="Понятно" onConfirm={() => setSaveStatus(null)} />
      )}
    </div>
  );
}

function ToolIcon({ id }) {
  const p = { width: 18, height: 18, viewBox: "0 0 20 20", style: { display: "block", flex: "none", shapeRendering: "crispEdges" } };
  if (id === "pen") return (<svg {...p}><rect x="10" y="2" width="5" height="8" fill="#2c5fbf" stroke="#000" transform="rotate(45 12.5 6)" /><rect x="7" y="9" width="4" height="4" fill="#ffd66e" stroke="#000" transform="rotate(45 9 11)" /><path d="M3 17 L6 14 L7.5 15.5 L4.5 18 Z" fill="#000" /></svg>);
  if (id === "brush") return (<svg {...p}><rect x="12" y="3" width="4" height="7" fill="#a0673a" stroke="#000" transform="rotate(45 14 6)" /><rect x="5" y="10" width="6" height="4" fill="#c0c0c0" stroke="#000" transform="rotate(45 8 12)" /><path d="M3 17 L6 14 L8 16 L5 19 Z" fill="#000" /></svg>);
  if (id === "eraser") return (<svg {...p}><rect x="3" y="9" width="10" height="6" fill="#f8c8d0" stroke="#000" transform="rotate(-28 8 12)" /><rect x="10" y="5" width="5" height="6" fill="#7ec0ee" stroke="#000" transform="rotate(-28 12 8)" /></svg>);
  if (id === "spray") return (<svg {...p}><rect x="7" y="7" width="6" height="10" fill="#b0b0b0" stroke="#000" /><rect x="8" y="3" width="4" height="4" fill="#808080" stroke="#000" /><circle cx="15" cy="3" r="0.8" fill="#000" /><circle cx="16" cy="6" r="0.8" fill="#000" /><circle cx="14" cy="6" r="0.8" fill="#000" /><circle cx="17" cy="4" r="0.7" fill="#000" /></svg>);
  if (id === "fill") return (<svg {...p}><polygon points="3,10 10,3 16,9 9,16" fill="#c0c0c0" stroke="#000" /><rect x="13" y="10" width="2" height="4" fill="#008080" /><path d="M14 14 q2 2 0 3.5" fill="#008080" /></svg>);
  if (id === "line") return (<svg {...p}><line x1="3" y1="17" x2="17" y2="3" stroke="#000" strokeWidth="2" /></svg>);
  if (id === "rect") return (<svg {...p}><rect x="3" y="6" width="14" height="9" fill="none" stroke="#000" strokeWidth="2" /></svg>);
  if (id === "ellipse") return (<svg {...p}><ellipse cx="10" cy="10" rx="7" ry="6" fill="none" stroke="#000" strokeWidth="2" /></svg>);
  if (id === "triangle") return (<svg {...p}><polygon points="10,4 16,16 4,16" fill="none" stroke="#000" strokeWidth="2" /></svg>);
  if (id === "undo") return (<svg {...p}><path d="M6 6 H12 a4 4 0 1 1 0 8 H8" fill="none" stroke="#000" strokeWidth="2" /><polygon points="7,2 7,9 2,5.5" fill="#000" /></svg>);
  if (id === "redo") return (<svg {...p}><path d="M14 6 H8 a4 4 0 1 0 0 8 H12" fill="none" stroke="#000" strokeWidth="2" /><polygon points="13,2 13,9 18,5.5" fill="#000" /></svg>);
  if (id === "clear") return (<svg {...p}><rect x="4" y="6" width="12" height="11" fill="#c0c0c0" stroke="#000" /><line x1="4" y1="6" x2="16" y2="6" stroke="#000" strokeWidth="2" /><rect x="8" y="3" width="4" height="3" fill="#c0c0c0" stroke="#000" /><line x1="8" y1="9" x2="8" y2="15" stroke="#808080" /><line x1="12" y1="9" x2="12" y2="15" stroke="#808080" /></svg>);
  return null;
}


export default function App() {
  const hasSavedFlow = (() => {
    try { const d = sessionStorage.getItem("flowData"); return d && d !== "{}"; } catch { return false; }
  })();

  const [tab, setTab] = useState("journal");
  const [journalView, setJournalView] = useState("list");
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [locker, setLocker] = useState([]);
  const [sketchOpen, setSketchOpen] = useState(false);
  function saveLocker(next) { setLocker(next); storeSet(LOCKER_KEY, JSON.stringify(next)); }
  const [trackerUpgrade, setTrackerUpgrade] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // New session flow, persisted in sessionStorage to survive tab switches
  const [flowStep, setFlowStep] = useState(() => {
    try { return parseInt(sessionStorage.getItem("flowStep") || "0"); } catch { return 0; }
  });
  const [flowData, setFlowData] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("flowData") || "{}"); } catch { return {}; }
  });
  const [activeFacet, setActiveFacet] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const persistedRef = useRef({});
  // Черновик: рефы и автосейв в постоянное хранилище (CloudStorage), не только во временную память
  const flowDataRef = useRef(flowData);
  const flowStepRef = useRef(flowStep);
  const draftIdRef = useRef(null);
  const draftSaveTimer = useRef(null);
  function persistDraftNow() {
    const id = draftIdRef.current;
    if (!id) return;
    setSessions(prev => prev.map(s =>
      s.id === id ? { ...s, ...flowDataRef.current, status:"draft", _step: flowStepRef.current } : s
    ));
  }
  function scheduleDraftSave() {
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(persistDraftNow, 700);
  }
  function resumeDraft(d) {
    const step = d._step || 0;
    flowDataRef.current = d;
    flowStepRef.current = step;
    draftIdRef.current = d.id;
    setFlowData(d);
    setFlowStep(step);
    setDraftId(d.id);
    setJournalView("new");
  }

  // Гейт закрытого теста: статус доступа проверяется на сервере по белому списку.
  const [access, setAccess] = useState("checking");
  const [consent, setConsent] = useState("checking");
  async function runGates() {
    setAccess("checking");
    const a = await apiAccessCheck();
    if (a !== true) { setAccess(a === false ? "denied" : "error"); return; }
    setAccess("ok");
    const c = await apiConsentStatus();
    setConsent(c === true ? "ok" : c === false ? "needed" : "error");
  }
  useEffect(() => {
    try {
      const tg = (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
      if (tg) {
        if (tg.ready) tg.ready();
        if (tg.expand) tg.expand();
        const applySafe = () => {
          try {
            const a = (tg.safeAreaInset && tg.safeAreaInset.bottom) || 0;
            const b = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.bottom) || 0;
            document.documentElement.style.setProperty("--sab", Math.max(a, b) + "px");
          } catch (e) {}
        };
        applySafe();
        try { if (tg.onEvent) { tg.onEvent("safeAreaChanged", applySafe); tg.onEvent("contentSafeAreaChanged", applySafe); tg.onEvent("viewportChanged", applySafe); } } catch (e) {}
      }
    } catch (e) {}
  }, []);
  useEffect(() => { runGates(); }, []);
  function recheckAccess() { runGates(); }

  // Загрузка сессий и факта оплаты из хранилища при старте
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idxRaw = await storeGet(INDEX_KEY);
        let ids = [];
        if (idxRaw) { try { ids = JSON.parse(idxRaw) || []; } catch { ids = []; } }
        const arr = [];
        for (const id of ids) {
          const raw = await storeGetBig(NOTE_PREFIX + id);
          if (raw) {
            try {
              const sn = JSON.parse(raw);
              if (sn && sn.analysis && !(Array.isArray(sn.analyses) && sn.analyses.length)) {
                sn.analyses = [{ basis: "session", label: "Разбор по сессии", text: sn.analysis, at: sn.id || Date.now() }];
              }
              arr.push(sn); persistedRef.current[String(sn.id)] = raw;
            }
            catch {}
          }
        }
        if (!cancelled) {
          if (arr.length) setSessions(arr);
          // Сдвигаем счётчик id за максимальный сохранённый, чтобы не затирать старые сессии
          const maxId = arr.reduce((m, sn) => (typeof sn.id === "number" && sn.id > m ? sn.id : m), nextId);
          nextId = maxId;
          const lockRaw = await storeGet(LOCKER_KEY);
          if (lockRaw) { try { setLocker(JSON.parse(lockRaw) || []); } catch {} }
          const prem = await storeGet(PREMIUM_KEY);
          if (prem === "1") setIsPremium(true);
          // Сервер, источник истины: подтягиваем реальный статус премиума.
          const serverPrem = await apiPremiumStatus();
          if (!cancelled && serverPrem) setIsPremium(!!serverPrem.premium);
        }
      } catch {}
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Сохранение сессий при любом изменении (только после загрузки)
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      const ids = sessions.map(s => s.id);
      await storeSet(INDEX_KEY, JSON.stringify(ids));
      for (const s of sessions) {
        const json = JSON.stringify(s);
        if (persistedRef.current[String(s.id)] !== json) {
          const ok = await storeSetBig(NOTE_PREFIX + s.id, json);
          if (ok) persistedRef.current[String(s.id)] = json;
        }
      }
      const idStrs = ids.map(String);
      const keys = await storeKeys();
      for (const k of keys) {
        if (k.indexOf(NOTE_PREFIX) === 0) {
          const kid = k.slice(NOTE_PREFIX.length).split("__c")[0];
          if (!idStrs.includes(kid)) { await storeRemove(k); delete persistedRef.current[kid]; }
        }
      }
    })();
  }, [sessions, loaded]);

  // Сохранение факта оплаты
  useEffect(() => {
    if (!loaded) return;
    storeSet(PREMIUM_KEY, isPremium ? "1" : "");
  }, [isPremium, loaded]);

  // Simple flow data save, just updates React state and sessionStorage
  const saveFlowData = (data) => {
    flowDataRef.current = data;
    setFlowData(data);
    try { sessionStorage.setItem("flowData", JSON.stringify(data)); } catch {}
    scheduleDraftSave();
  };

  const saveFlowStep = (step) => {
    flowStepRef.current = step;
    setFlowStep(step);
    try { sessionStorage.setItem("flowStep", String(step)); } catch {}
    persistDraftNow();
  };

  // Update draft in sessions list, called explicitly, not on every keystroke
  const updateDraftInList = (id, data, step) => {
    setSessions(prev => prev.map(s =>
      s.id === id ? { ...s, ...data, status:"draft", _step: step } : s
    ));
  };

  function startNew() {
    // Count only completed sessions for premium check
    const completedCount = sessions.filter(s => s.status !== "draft").length;
    if (!isPremium && completedCount >= 1) { setJournalView("upgrade"); return; }

    // Check if resuming existing draft
    const existingDraft = sessions.find(s => s.status === "draft");
    if (existingDraft) {
      resumeDraft(existingDraft);
      return;
    }

    // Create new draft
    const id = uid();
    const date = new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" });
    const draft = { id, date, status:"draft", _step:0 };
    setSessions(prev => [draft, ...prev]);
    flowDataRef.current = {};
    flowStepRef.current = 0;
    draftIdRef.current = id;
    setDraftId(id);
    setFlowData({});
    setFlowStep(0);
    setJournalView("new");
  }

  function finishSessionWithUpgrade() {
    if (!isPremium) { setJournalView("upgrade_from_flow"); return; }
    finishSession();
  }

  async function finishSession(premiumOverride) {
    draftIdRef.current = null;
    if (draftSaveTimer.current) { clearTimeout(draftSaveTimer.current); draftSaveTimer.current = null; }
    const existingId = draftId || uid();
    const s = { id: existingId, date: new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" }), ...flowData, status:"done" };
    const hasPremium = premiumOverride || isPremium;
    // Request Claude ratings only for premium users
    if (!hasPremium) {
      setSessions(prev => prev.find(x => x.id === s.id)
        ? prev.map(x => x.id === s.id ? s : x)
        : [s, ...prev]);
      setDraftId(null);
      try { sessionStorage.removeItem("flowData"); sessionStorage.removeItem("flowStep"); } catch {}
      setJournalView("list");
      return;
    }
    try {
      const facetTexts = FACET_KEYS.map(k => {
        const facetData = flowData.facets?.[k] || {};
        const answers = Object.values(facetData).filter(Boolean).join(" ");
        return `${FACET_LABELS[k]}: ${answers}`;
      }).join("\n\n");
      const prompt = `Ты, инструмент психоделической интеграции. Прочитай записи человека по 6 областям жизни после психоделического опыта и оцени каждую область по шкале от 1 до 10, где 1, очень тяжело/закрыто, 10, очень хорошо/открыто.

Записи:
${facetTexts}

Ответь ТОЛЬКО валидным JSON без пояснений и markdown:
{"mind":N,"body":N,"spirit":N,"relations":N,"nature":N,"lifestyle":N}

Где N, целое число от 1 до 10. Если по какой-то области записей нет, поставь 5.`;

      const res = await fetchT(`${API_BASE}/ratings`, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ prompt, initData: tgInitData() })
      });
      const data = await res.json();
      const claudeRatings = data.ratings || data;
      s.claudeRatings = claudeRatings;
    } catch(e) { /* silent fail, no Claude ratings */ }

    setSessions(prev => prev.find(x => x.id === s.id)
      ? prev.map(x => x.id === s.id ? s : x)
      : [s, ...prev]);
    setDraftId(null);
    try {
      sessionStorage.removeItem("flowData");
      sessionStorage.removeItem("flowStep");
    } catch {}
    setJournalView("list");
  }

  function handleDeleteAll() {
    setSessions([]);
    setJournalView("list");
  }

  // Гейт закрытого теста имеет приоритет: не из списка, внутрь не пускаем.
  if (access !== "ok") {
    return (
      <div style={{ maxWidth:480, margin:"0 auto", minHeight:"100vh", position:"relative", overflowX:"hidden" }}>
        <Style />
        <AccessGate state={access} onRetry={recheckAccess} />
      </div>
    );
  }

  // Экран согласия (одноразовый, правда в базе на сервере). Заменяет старый попап.
  if (consent !== "ok") {
    return (
      <div style={{ maxWidth:480, margin:"0 auto", minHeight:"100vh", position:"relative", overflowX:"hidden" }}>
        <Style />
        {consent === "needed"
          ? <ConsentScreen onDone={() => setConsent("ok")} />
          : <AccessGate state={consent === "error" ? "error" : "checking"} onRetry={runGates} />}
      </div>
    );
  }

  return (
    <div style={{ maxWidth:480, margin:"0 auto", minHeight:"100vh", position:"relative", overflowX:"hidden" }}>
      <Style />
      <AccentBar />

      {/* Journal views */}
      {tab === "journal" && journalView === "list" && (
        <JournalList sessions={sessions} isPremium={isPremium}
          onNew={startNew}
          onLocker={() => setJournalView("locker")}
          onOpen={s => { setActiveSession(s); setJournalView("detail"); }}
          onResume={resumeDraft}
          onUpgrade={() => setJournalView("upgrade")}
          onPrivacy={() => setJournalView("privacy")} />
      )}
      {tab === "journal" && journalView === "detail" && activeSession && (
        <SessionDetail session={activeSession} isPremium={isPremium} locker={locker}
          onBack={() => setJournalView("list")}
          onUpgrade={() => setJournalView("upgrade")}
          onSaveAnalysis={(entry) => setSessions(prev =>
            prev.map(s => s.id === activeSession.id ? { ...s, analyses: [...(s.analyses || []), entry] } : s)
          )}
          onUpdateSession={(updated) => {
            setSessions(prev => prev.map(s => s.id === activeSession.id ? updated : s));
            setActiveSession(updated);
          }}
          onDelete={() => {
            setSessions(prev => prev.filter(s => s.id !== activeSession.id));
            setActiveSession(null);
            setJournalView("list");
          }} />
      )}
      {tab === "journal" && journalView === "upgrade" && (
        <UpgradePage onBack={() => setJournalView("list")} onPurchase={() => { setIsPremium(true); setJournalView("list"); }} />
      )}
      {tab === "journal" && journalView === "upgrade_from_flow" && (
        <UpgradePage onBack={() => { setJournalView("new"); saveFlowStep(7); }} onPurchase={() => {
          setIsPremium(true);
          finishSession(true);
        }} />
      )}
      {tab === "journal" && journalView === "music" && (
        <MusicPage onBack={() => setJournalView("list")} />
      )}
      {tab === "journal" && journalView === "locker" && (
        <LockerScreen thoughts={locker} onSave={saveLocker} sessions={sessions} onBack={() => setJournalView("list")} onSketch={() => setSketchOpen(true)} />
      )}
      {tab === "journal" && journalView === "privacy" && (
        <PrivacyPage onBack={() => setJournalView("list")} onDeleteAll={handleDeleteAll} />
      )}
      {tab === "journal" && journalView === "game" && (
        <SnakeGame isPremium={isPremium} onBack={() => setJournalView("list")} onUpgrade={() => setJournalView("upgrade")} />
      )}

      {/* New session flow */}
      {tab === "journal" && journalView === "new" && !activeFacet && (
        <>
          {flowStep === 0 && <StepCover data={flowData} onChange={saveFlowData} onNext={() => saveFlowStep(1)} />}
          {flowStep === 1 && <StepIntention data={flowData} onChange={saveFlowData} onNext={() => saveFlowStep(2)} onBack={() => saveFlowStep(0)} />}
          {flowStep === 2 && <StepAfter72 data={flowData} onChange={saveFlowData} onNext={() => saveFlowStep(3)} onSkip={() => saveFlowStep(4)} onBack={() => saveFlowStep(1)} />}
          {flowStep === 3 && <StepDifficult data={flowData} onChange={saveFlowData} onNext={() => saveFlowStep(4)} onBack={() => saveFlowStep(2)} />}
          {flowStep === 4 && <StepModes data={flowData} onChange={saveFlowData} onNext={() => saveFlowStep(5)} onBack={() => saveFlowStep(3)} />}
          {flowStep === 5 && <StepFacetsNav data={flowData} onFacet={k => setActiveFacet(k)} onNext={() => saveFlowStep(6)} onSkip={() => saveFlowStep(6)} onBack={() => saveFlowStep(4)} />}
          {flowStep === 6 && <StepRating data={flowData} onChange={saveFlowData} onFinish={() => saveFlowStep(7)} onBack={() => saveFlowStep(5)} />}
          {flowStep === 7 && <StepLongterm data={flowData} onChange={saveFlowData} onFinish={finishSessionWithUpgrade} onFinishFree={finishSession} onBack={() => saveFlowStep(6)} isPremium={isPremium} onUpgrade={() => setJournalView("upgrade_from_flow")} />}
        </>
      )}
      {tab === "journal" && journalView === "new" && activeFacet && (
        <StepFacet facetKey={activeFacet} data={flowData} onChange={saveFlowData} onDone={() => setActiveFacet(null)} />
      )}

      {tab === "library" && <LibraryPage />}
      {tab === "crisis" && <CrisisPage />}
      {tab === "tracker" && !isPremium && trackerUpgrade && (
        <UpgradePage onBack={() => setTrackerUpgrade(false)} onPurchase={() => { setIsPremium(true); setTrackerUpgrade(false); }} />
      )}
      {tab === "tracker" && (!trackerUpgrade || isPremium) && <TrackerPage sessions={sessions} isPremium={isPremium} onUpgrade={() => setTrackerUpgrade(true)} />}

      <NavBar active={tab} onGame={() => { setTab("journal"); setJournalView("game"); }} onLocker={() => { setTab("journal"); setJournalView("locker"); }} onMusic={() => { setTab("journal"); setJournalView("music"); }} onPrivacy={() => { setTab("journal"); setJournalView("privacy"); }} onChange={id => {
        setTab(id);
        if (id === "journal") {
          try { persistDraftNow(); } catch (e) {}
          setActiveFacet(null);
          setJournalView("list");
        }
      }} />

      {sketchOpen && <SketchPad onClose={() => setSketchOpen(false)} />}

      {/* First launch onboarding, поверх всего */}
      {showOnboarding && <FirstLaunch onAccept={() => setShowOnboarding(false)} />}
    </div>
  );
}
