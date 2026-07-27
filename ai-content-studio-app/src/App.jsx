import { useState, useEffect, useRef, useCallback } from "react";
import mammoth from "mammoth";

// ── window.storage shim (Claude.ai artifact API) — falls back to localStorage outside the sandbox ──
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const raw = localStorage.getItem(key);
      return raw ? { value: raw } : null;
    },
    async set(key, value) {
      localStorage.setItem(key, value);
    },
  };
}

if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const paidToken = params.get("token");
  if (paidToken && /^[a-f0-9]{48}$/.test(paidToken)) {
    localStorage.setItem("acs3-paid-token", paidToken);
    window.history.replaceState({}, "", window.location.pathname);
  }
}
// ── CONSTANTS ──
const STATUSES = [
  { key: "idea", label: "Идея" },
  { key: "to_film", label: "Снять" },
  { key: "to_edit", label: "Смонтировать" },
  { key: "published", label: "Опубликовано" },
];
const PLATFORMS = {
  ig: { name: "Instagram", icon: "📸", formats: ["Reels", "Карусель", "Пост", "Stories"] },
  yt: { name: "YouTube", icon: "▷", formats: ["Shorts", "Видео"] },
  tg: { name: "Telegram", icon: "✈", formats: ["Пост", "Видео", "Кружок"] },
  tt: { name: "TikTok", icon: "♪", formats: ["Видео"] },
  th: { name: "Threads", icon: "◎", formats: ["Пост"] },
  vk: { name: "VK", icon: "VK", formats: ["Клип", "Пост"] },
};
const HUNT_HINTS = ["Агент определит сам","Не осознаёт проблему","Чувствует боль","Ищет решение","Знает о нас","Готов купить"];
const VIDEO_FORMATS = ["Reels", "Видео", "Shorts", "Кружок", "Клип"];
const DEFAULT_PLAT_INSTR = {
  ig: "Instagram:\n— Хук в первые 2 строки\n— 1 CTA в конце\n— Эмодзи в меру",
  yt: "YouTube:\n— Ключевое слово в заголовке\n— Описание с расшифровкой первых 10 сек",
  tg: "Telegram:\n— По-свойски, аудитория тёплая\n— Ссылка в конце",
  tt: "TikTok:\n— Хук в первую секунду\n— Коротко и живо",
  th: "Threads:\n— 300–500 символов\n— Самостоятельная мысль",
  vk: "VK:\n— Живой стиль\n— CTA в конце",
};

const COLORS = {
  cream: "#FDF2F5", rose: "#E23577", roseL: "#FBD3E3", roseP: "#FCE7EF",
  brown: "#23121A", brownS: "#8C5470", white: "#FFFFFF", brd: "#F6C9DC",
  green: "#2A7A4F", greenL: "#D4F0E0", amber: "#B45309", amberL: "#FEF3C7",
  blue: "#1D4ED8", blueL: "#DBEAFE", purple: "#7C3AED", purpleL: "#EDE9FE",
};

// ── STORAGE ──
async function sGet(key) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function sSet(key, val) {
  try { await window.storage.set(key, JSON.stringify(val)); } catch (e) { console.warn(e); }
}

// ── FILE UPLOAD ──
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — the whole profile (all niches) lives in localStorage's shared quota
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
// Single entry point for reading an uploaded document into plain text,
// shared by every upload control in the profile (ca/prod/tov/memory/materials).
async function parseFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "docx") {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return { text: value, fileType: "docx" };
  }
  return { text: await file.text(), fileType: ext === "md" ? "md" : "txt" };
}
const FILE_ACCEPT = ".txt,.md,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ── API ──
function getClientId() {
  let id = localStorage.getItem("acs3-client-id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + Date.now().toString(36);
    localStorage.setItem("acs3-client-id", id);
  }
  return id;
}
async function callAPI(messages, system, maxTokens = 1000) {
  const headers = { "Content-Type": "application/json", "X-Client-Id": getClientId() };
  const paidToken = localStorage.getItem("acs3-paid-token");
  if (paidToken) headers["Authorization"] = "Bearer " + paidToken;
  const r = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({ system, messages, maxTokens }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "API ошибка");
  return d.text || "";
}
function parseJSON(raw) {
  try { return JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Не удалось разобрать ответ");
  }
}
function parseJSONArray(raw) {
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; }
  throw new Error("Не удалось разобрать ответ агента");
}
// Cuts at the nearest paragraph/sentence break instead of mid-word, so
// agents see a coherent excerpt rather than a truncated fragment.
function smartTruncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return (lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak + 1) : cut) + "…";
}
// Materials flagged for this step are included whole (up to perMaterialMax
// each) in order, until the combined total would exceed totalBudget — the
// rest are skipped entirely rather than each shaved down to an unreadable
// stub.
function buildMaterialsCtx(materials, useKey, perMaterialMax = 2000, totalBudget = 6000) {
  let ctx = "";
  let used = 0;
  for (const m of (materials || []).filter(x => x.use?.[useKey])) {
    const piece = smartTruncate(m.text, perMaterialMax);
    if (used + piece.length > totalBudget) break;
    ctx += `=== ${m.name.toUpperCase()} ===\n${piece}\n\n`;
    used += piece.length;
  }
  return ctx;
}
// Full, untruncated niche document — used only for the once-a-month plan
// call. Per-post generation elsewhere truncates profile fields to keep
// frequent calls cheap; this call is rare enough that depth matters more.
function buildFullNicheDocument(profile) {
  let doc = "";
  const ca = fieldContext(profile, "ca"), prod = fieldContext(profile, "prod"), tov = fieldContext(profile, "tov"), memory = fieldContext(profile, "memory");
  if (ca) doc += `=== ЦЕЛЕВАЯ АУДИТОРИЯ ===\n${ca}\n\n`;
  if (prod) doc += `=== ПРОДУКТЫ И ВОРОНКА ===\n${prod}\n\n`;
  if (tov) doc += `=== ТОН И СТИЛЬ ===\n${tov}\n\n`;
  if (memory) doc += `=== ПАТТЕРНЫ ===\n${memory}\n\n`;
  (profile.materials || []).forEach(m => { doc += `=== ${(m.name || "").toUpperCase()} ===\n${m.text}\n\n`; });
  return doc.trim();
}

// ── LIGHTWEIGHT MARKDOWN (bold / italic / quotes / --- dividers) ──
function renderInline(text, keyPrefix) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0, i = 0, match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) parts.push(<strong key={`${keyPrefix}-${i++}`}>{match[1]}</strong>);
    else parts.push(<em key={`${keyPrefix}-${i++}`}>{match[2]}</em>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
function MsgText({ text }) {
  const lines = (text || "").split("\n");
  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (/^-{3,}$/.test(trimmed)) return <div key={i} style={{ height: 1, background: "currentColor", opacity: .15, margin: "7px 0" }} />;
    const isQuote = trimmed.startsWith("> ") || trimmed.startsWith(">");
    const content = isQuote ? trimmed.replace(/^>\s*/, "") : line;
    return (
      <div key={i} style={isQuote ? { borderLeft: "2.5px solid currentColor", opacity: .75, paddingLeft: 8, margin: "5px 0", fontStyle: "italic" } : { margin: "3px 0" }}>
        {renderInline(content, `l${i}`)}
      </div>
    );
  });
}

// ── STYLES ──
const s = {
  nav: { background: COLORS.white, borderBottom: `1.5px solid ${COLORS.brd}`, padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 50, position: "sticky", top: 0, zIndex: 100 },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoIc: { width: 28, height: 28, background: COLORS.rose, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13 },
  logoT: { fontFamily: "sans-serif", fontWeight: 800, fontSize: 13, color: COLORS.brown },
  logoV: { fontSize: 10, color: COLORS.brownS },
  panel: { padding: 16, maxWidth: 1060, margin: "0 auto" },
  card: { background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 12, padding: 14, marginBottom: 11 },
  label: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: COLORS.brownS, marginBottom: 4, display: "block" },
  field: { width: "100%", border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: "8px 10px", fontFamily: "inherit", fontSize: 12, color: COLORS.brown, background: COLORS.cream, resize: "none", outline: "none", lineHeight: 1.5, boxSizing: "border-box" },
  btnRose: { border: "none", borderRadius: 8, padding: "7px 14px", background: COLORS.rose, color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  btnOutline: { border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: "6px 12px", background: "none", color: COLORS.brownS, fontSize: 11, cursor: "pointer", fontFamily: "inherit" },
  btnSm: { padding: "4px 10px", fontSize: 11 },
  badge: (bg, color) => ({ background: bg, color, padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 600, display: "inline-flex", alignItems: "center" }),
  overlay: { position: "fixed", inset: 0, background: "rgba(35,18,26,.45)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 12, overflowY: "auto" },
  modal: { background: COLORS.white, borderRadius: 16, padding: 18, width: "100%", maxWidth: 780, margin: "auto", position: "relative" },
  chatMsg: (role) => ({ padding: "8px 11px", borderRadius: role === "user" ? "9px 9px 3px 9px" : "9px 9px 9px 3px", fontSize: 12, lineHeight: 1.55, maxWidth: "88%", background: role === "user" ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${role === "user" ? COLORS.roseL : COLORS.brd}`, alignSelf: role === "user" ? "flex-end" : "flex-start", marginLeft: role === "user" ? "auto" : 0 }),
};

// ── BADGE ──
function Badge({ bg, color, children }) {
  return <span style={s.badge(bg, color)}>{children}</span>;
}

function genDocId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 8);
}
// ca/prod/tov/memory stay plain strings holding only what the user typed by
// hand — uploaded files keep their text on the {field}_files record instead,
// so the textarea never shows raw document dumps. This combines the two for
// agent prompts only; nothing that renders a textarea should call it.
function fieldContext(profile, fieldId) {
  const manual = profile[fieldId] || "";
  const files = (profile[`${fieldId}_files`] || []).map(f => f.text).filter(Boolean).join("\n\n");
  return [manual, files].filter(Boolean).join("\n\n");
}

// ── DOCUMENT CHIP ── list entry for an uploaded file, used under ca/prod/tov/memory and in materials
function DocumentChip({ fileName, fileType, fileSize, onRemove }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 5, background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 7, padding: "3px 7px", fontSize: 10, color: COLORS.brownS, marginTop: 5, marginRight: 5 }}>
      <span>{fileType === "docx" ? "📘" : "📄"}</span>
      <span style={{ fontWeight: 600, color: COLORS.brown }}>{fileName}</span>
      {fileSize != null && <span>· {formatFileSize(fileSize)}</span>}
      {onRemove && <button onClick={onRemove} title="Удалить" style={{ background: "none", border: "none", color: COLORS.brownS, cursor: "pointer", fontSize: 11, padding: 0, marginLeft: 2, lineHeight: 1 }}>✕</button>}
    </div>
  );
}

const EMPTY_PROFILE_FIELDS = { ca: "", prod: "", tov: "", memory: "", ca_files: [], prod_files: [], tov_files: [], memory_files: [], leads: [], materials: [], platInstr: { ...DEFAULT_PLAT_INSTR }, huntStage: null, profileType: "manual", contentPlan: null };
function makeProfile(data) {
  return { id: "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: "Новая ниша", ...EMPTY_PROFILE_FIELDS, ...data, platInstr: { ...DEFAULT_PLAT_INSTR, ...(data.platInstr || {}) } };
}
function makeReel({ platform, format, hunt = 0, topic = "" }) {
  return {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    created_at: new Date().toISOString(),
    platform, format, hunt_stage: hunt,
    lead_magnet_idx: null,
    topic, status: "idea", agreed_angle: null,
    idea_chat: [], script_chat: [], script_versions: [],
    selected_script: -1, hooks: [], selected_hook: 0,
    shoot_format: null, shoot_plan: "",
    copy: {}, notes: "", reactions: "", publish_date: null,
  };
}

// ── MAIN APP ──
export default function App() {
  const [tab, setTab] = useState("board");
  const [reels, setReels] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [onboarding, setOnboarding] = useState(null); // null | "choice" | "interview"
  const [showNicheMenu, setShowNicheMenu] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [cardId, setCardId] = useState(null);
  const [showNewCard, setShowNewCard] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [hoveredCardId, setHoveredCardId] = useState(null);
  const [deleteBoardCardId, setDeleteBoardCardId] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      let list = await sGet("acs3-profiles");
      let active = await sGet("acs3-active-profile-id");
      if (!list) {
        const legacy = await sGet("acs3-profile");
        if (legacy && (legacy.ca || legacy.prod || legacy.tov)) {
          const migrated = makeProfile({ name: "Моя ниша", ...legacy });
          list = [migrated];
          active = migrated.id;
          await sSet("acs3-profiles", list);
          await sSet("acs3-active-profile-id", active);
        } else {
          list = [];
        }
      }
      setProfiles(list);
      const validActive = active && list.some(p => p.id === active) ? active : (list[0]?.id || null);
      setActiveProfileId(validActive);
      if (list.length === 0) setOnboarding("choice");
      const r = await sGet("acs3-reels");
      if (r) {
        // One-off migration: reels predating per-niche isolation have no
        // profileId — attach them to whichever profile is active (or the
        // first one) instead of silently orphaning them off the board.
        const fallbackProfileId = validActive || list[0]?.id || null;
        const needsMigration = r.some(x => !x.profileId);
        const migrated = needsMigration ? r.map(x => x.profileId ? x : { ...x, profileId: fallbackProfileId }) : r;
        setReels(migrated);
        if (needsMigration) saveReels(migrated);
      }
      const k = localStorage.getItem("acs3-key") || "";
      setApiKey(k);
    })();
  }, []);

  const saveReels = useCallback(async (updated) => {
    await sSet("acs3-reels", updated);
  }, []);

  const saveProfiles = useCallback(async (list) => {
    await sSet("acs3-profiles", list);
  }, []);

  const updateActiveProfile = useCallback((changes) => {
    setProfiles(prev => {
      const updated = prev.map(p => p.id === activeProfileId ? { ...p, ...changes } : p);
      saveProfiles(updated);
      return updated;
    });
  }, [activeProfileId, saveProfiles]);

  const createProfile = useCallback((data) => {
    const created = makeProfile(data);
    setProfiles(prev => {
      const updated = [...prev, created];
      saveProfiles(updated);
      return updated;
    });
    setActiveProfileId(created.id);
    sSet("acs3-active-profile-id", created.id);
    setOnboarding(null);
    return created.id;
  }, [saveProfiles]);

  const switchProfile = useCallback((id) => {
    setActiveProfileId(id);
    sSet("acs3-active-profile-id", id);
    setShowNicheMenu(false);
  }, []);

  const profile = profiles.find(p => p.id === activeProfileId) || EMPTY_PROFILE_FIELDS;

  const scheduleAutosave = useCallback((updatedReels) => {
    setSaveStatus("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await saveReels(updatedReels);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 2000);
    }, 700);
  }, [saveReels]);

  const updateReel = useCallback((id, changes) => {
    setReels(prev => {
      const updated = prev.map(r => r.id === id ? { ...r, ...changes } : r);
      scheduleAutosave(updated);
      return updated;
    });
  }, [scheduleAutosave]);

  const deleteReel = useCallback((id) => {
    setReels(prev => { const u = prev.filter(r => r.id !== id); saveReels(u); return u; });
    setCardId(prev => (prev === id ? null : prev));
  }, [saveReels]);

  const currentReel = reels.find(r => r.id === cardId);
  const deleteBoardCard = reels.find(r => r.id === deleteBoardCardId);
  // Board, reminders, and everything downstream (existing-topics checks,
  // due/overdue banners) must only ever see the active niche's own reels —
  // reels themselves aren't per-profile storage, just tagged with profileId.
  const profileReels = reels.filter(r => r.profileId === activeProfileId);

  const todayStr = new Date().toISOString().slice(0, 10);
  const dueToday = profileReels.filter(r => r.publish_date === todayStr && r.status !== "published");
  const overdue = profileReels.filter(r => r.publish_date && r.publish_date < todayStr && r.status !== "published");

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: COLORS.cream, minHeight: "100vh", color: COLORS.brown, fontSize: 13 }}>
      {/* NAV */}
      <nav style={s.nav}>
        <div style={s.logo}>
          <div style={s.logoIc}>✦</div>
          <div>
            <div style={s.logoT}>AI Content Studio</div>
            <div style={s.logoV}>3.0 · Workshop</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {["board", "plan", "profile"].map((t, i) => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "inherit", background: tab === t ? COLORS.rose : "none", color: tab === t ? "#fff" : COLORS.brownS }}>
              {t === "board" ? "◫ Доска" : t === "plan" ? "📅 План" : "⚙ Профиль"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {profiles.length > 0 && (
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowNicheMenu(v => !v)} style={{ ...s.btnOutline, display: "flex", alignItems: "center", gap: 5, maxWidth: 160 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.name || "Ниша"}</span>
                <span style={{ fontSize: 9 }}>▾</span>
              </button>
              {showNicheMenu && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 150 }} onClick={() => setShowNicheMenu(false)} />
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: "#fff", border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, boxShadow: "0 4px 16px rgba(35,18,26,.15)", minWidth: 180, zIndex: 151, overflow: "hidden" }}>
                    {profiles.map(p => (
                      <button key={p.id} onClick={() => switchProfile(p.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 11px", border: "none", background: p.id === activeProfileId ? COLORS.roseP : "#fff", color: p.id === activeProfileId ? COLORS.rose : COLORS.brown, fontSize: 12, fontWeight: p.id === activeProfileId ? 700 : 400, cursor: "pointer" }}>
                        {p.id === activeProfileId ? "✓ " : ""}{p.name || "Без названия"}
                      </button>
                    ))}
                    <div style={{ height: 1, background: COLORS.brd }} />
                    <button onClick={() => { setShowNicheMenu(false); setOnboarding("choice"); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 11px", border: "none", background: "#fff", color: COLORS.rose, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Добавить нишу</button>
                  </div>
                </>
              )}
            </div>
          )}
          <span style={{ fontSize: 10, color: saveStatus === "saving" ? COLORS.amber : saveStatus === "saved" ? COLORS.green : COLORS.brownS }}>
            {saveStatus === "saving" ? "Сохраняю..." : saveStatus === "saved" ? "✓ Сохранено" : ""}
          </span>
          <button onClick={() => setShowNewCard(true)} style={{ width: 30, height: 30, borderRadius: "50%", background: COLORS.roseP, border: `1.5px solid ${COLORS.brd}`, color: COLORS.rose, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
        </div>
      </nav>

      {/* BOARD */}
      {tab === "board" && (
        <div style={s.panel}>
          {(!profile.ca || !profile.prod || !profile.tov) && (
            <div style={{ background: COLORS.amberL, border: `1.5px solid #FCD34D`, borderRadius: 9, padding: "9px 12px", fontSize: 11, color: COLORS.amber, fontWeight: 500, display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
              ⚠ Заполни профиль — агенты будут работать точнее.
              <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={() => setTab("profile")}>Перейти →</span>
            </div>
          )}
          {(dueToday.length > 0 || overdue.length > 0) && (
            <div style={{ background: COLORS.amberL, border: `1.5px solid #FCD34D`, borderRadius: 9, padding: "9px 12px", fontSize: 11, color: COLORS.amber, fontWeight: 500, marginBottom: 12 }}>
              {dueToday.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, marginBottom: overdue.length ? 5 : 0 }}>
                  <span>📅 <strong>Сегодня нужно опубликовать:</strong></span>
                  {dueToday.map(r => <span key={r.id} onClick={() => setCardId(r.id)} style={{ textDecoration: "underline", cursor: "pointer" }}>{r.topic || "Без темы"}</span>)}
                </div>
              )}
              {overdue.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, color: "#DC2626" }}>
                  <span>⚠ <strong>Просрочено:</strong></span>
                  {overdue.map(r => <span key={r.id} onClick={() => setCardId(r.id)} style={{ textDecoration: "underline", cursor: "pointer" }}>{r.topic || "Без темы"}</span>)}
                </div>
              )}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.brown }}>Производственная доска</div>
              <div style={{ fontSize: 11, color: COLORS.brownS }}>{profileReels.length ? `${profileReels.length} ролик(ов) в работе` : "Нажми «+ Новый ролик» чтобы начать"}</div>
            </div>
            <button style={s.btnRose} onClick={() => setShowNewCard(true)}>+ Новый ролик</button>
          </div>
          <div style={{ overflowX: "auto", paddingBottom: 6 }}>
            <div style={{ display: "flex", gap: 10, minWidth: 800 }}>
              {STATUSES.map(st => {
                const cards = profileReels.filter(r => r.status === st.key);
                return (
                  <div key={st.key} style={{ background: COLORS.roseP, borderRadius: 12, padding: 10, minWidth: 185, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 11, color: COLORS.brown }}>{st.label}</span>
                      <span style={{ background: COLORS.roseL, color: COLORS.rose, borderRadius: 20, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>{cards.length}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 40 }}>
                      {cards.length === 0 && <div style={{ textAlign: "center", color: COLORS.brownS, fontSize: 10, padding: "12px 4px", opacity: .5 }}>Пусто</div>}
                      {cards.map(r => {
                        const isDueToday = r.publish_date === todayStr && r.status !== "published";
                        const isOverdue = r.publish_date && r.publish_date < todayStr && r.status !== "published";
                        return (
                        <div key={r.id} onClick={() => setCardId(r.id)} onMouseEnter={() => setHoveredCardId(r.id)} onMouseLeave={() => setHoveredCardId(prev => (prev === r.id ? null : prev))} style={{ position: "relative", background: COLORS.white, border: `1.5px solid ${isOverdue ? "#DC2626" : isDueToday ? COLORS.amber : COLORS.brd}`, borderRadius: 10, padding: 10, cursor: "pointer" }}>
                          <button
                            onClick={e => { e.stopPropagation(); setDeleteBoardCardId(r.id); }}
                            title="Удалить"
                            style={{ position: "absolute", top: 6, right: 6, width: 20, height: 20, borderRadius: "50%", border: "none", background: "#fff", color: COLORS.brownS, fontSize: 11, lineHeight: "20px", textAlign: "center", padding: 0, cursor: "pointer", boxShadow: "0 1px 3px rgba(35,18,26,.15)", opacity: hoveredCardId === r.id ? 1 : 0, transition: "opacity .12s" }}
                          >✕</button>
                          <div style={{ fontWeight: 700, fontSize: 11, color: COLORS.brown, marginBottom: 4, lineHeight: 1.4, paddingRight: 16 }}>{r.topic || "Без темы"}</div>
                          <div style={{ fontSize: 10, color: COLORS.brownS, lineHeight: 1.4, marginBottom: 6, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{(r.hooks?.[r.selected_hook || 0] || r.topic || "").substring(0, 70)}</div>
                          {(isDueToday || isOverdue) && (
                            <div style={{ marginBottom: 6 }}>
                              {isOverdue ? <Badge bg="#FEE2E2" color="#DC2626">⚠ Просрочено</Badge> : <Badge bg={COLORS.amberL} color={COLORS.amber}>📅 Сегодня</Badge>}
                            </div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", gap: 3 }}>
                              {r.hunt_stage ? <Badge bg={COLORS.roseL} color={COLORS.rose}>С{r.hunt_stage}</Badge> : null}
                              <Badge bg={COLORS.blueL} color={COLORS.blue}>{PLATFORMS[r.platform]?.icon} {PLATFORMS[r.platform]?.name}</Badge>
                            </div>
                            <span style={{ fontSize: 9, color: COLORS.brownS }}>{r.created_at ? new Date(r.created_at).toLocaleDateString("ru", { day: "numeric", month: "short" }) : ""}</span>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                    <button onClick={() => setShowNewCard(true)} style={{ width: "100%", background: "none", border: `1.5px dashed ${COLORS.brd}`, borderRadius: 8, padding: 6, color: COLORS.brownS, fontSize: 11, marginTop: 5, cursor: "pointer" }}>+ Добавить</button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* PLAN */}
      {tab === "plan" && (
        <PlanTab
          key={profile.id}
          profile={profile}
          onUpdateProfile={(p) => updateActiveProfile(p)}
          onWritePost={(item) => {
            const p = PLATFORMS[item.platform] || PLATFORMS.ig;
            const reel = { ...makeReel({ platform: item.platform, format: p.formats[0], hunt: item.stage, topic: item.topic }), profileId: activeProfileId };
            setReels(prev => { const u = [reel, ...prev]; saveReels(u); return u; });
            setCardId(reel.id);
          }}
        />
      )}

      {/* PROFILE */}
      {tab === "profile" && (
        <ProfilePanel
          profile={profile} apiKey={apiKey} setApiKey={setApiKey}
          onSave={(p) => updateActiveProfile(p)}
        />
      )}

      {/* ONBOARDING */}
      {onboarding === "choice" && (
        <OnboardingChoice
          onClose={profiles.length > 0 ? () => setOnboarding(null) : null}
          onInterview={() => setOnboarding("interview")}
          onManual={() => { createProfile({ name: "Моя ниша", profileType: "manual" }); setTab("profile"); }}
        />
      )}
      {onboarding === "interview" && (
        <InterviewWizard
          onCancel={() => setOnboarding("choice")}
          onComplete={(data) => { createProfile({ ...data, profileType: "interview" }); setTab("board"); }}
        />
      )}

      {/* CARD MODAL */}
      {cardId && currentReel && (
        <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) setCardId(null); }}>
          <div style={s.modal}>
            <button onClick={() => setCardId(null)} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: COLORS.brownS, cursor: "pointer" }}>✕</button>
            <CardModal
              reel={currentReel} profile={profile} reels={profileReels}
              onUpdate={(changes) => updateReel(cardId, changes)}
              onDelete={() => deleteReel(cardId)}
            />
          </div>
        </div>
      )}

      {/* NEW CARD MODAL */}
      {showNewCard && (
        <NewCardModal
          profile={profile}
          onClose={() => setShowNewCard(false)}
          onCreate={(reel) => {
            setReels(prev => { const u = [reel, ...prev]; saveReels(u); return u; });
            setShowNewCard(false);
            setCardId(reel.id);
          }}
        />
      )}

      {/* DELETE FROM BOARD CONFIRM */}
      {deleteBoardCardId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(35,18,26,.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={e => { if (e.target === e.currentTarget) setDeleteBoardCardId(null); }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: 300, width: "90%", textAlign: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Удалить ролик?</div>
            <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 16 }}>«{deleteBoardCard?.topic || "Без темы"}» — это нельзя отменить.</div>
            <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
              <button style={{ ...s.btnRose, background: "#DC2626" }} onClick={() => { deleteReel(deleteBoardCardId); setDeleteBoardCardId(null); }}>Удалить</button>
              <button style={s.btnOutline} onClick={() => setDeleteBoardCardId(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PROFILE PANEL ──
function ProfilePanel({ profile, apiKey, setApiKey, onSave }) {
  const [showAddLead, setShowAddLead] = useState(false);
  const [showAddMat, setShowAddMat] = useState(false);
  const [leadForm, setLeadForm] = useState({ name: "", link: "", hunt: "3", desc: "" });
  const [matForm, setMatForm] = useState({ name: "", text: "", use: { idea: true, script: false, copy: false } });
  const [localProfile, setLocalProfile] = useState(profile);

  useEffect(() => setLocalProfile(profile), [profile]);

  const handleSave = () => {
    onSave(localProfile);
  };

  const saveKey = (v) => {
    setApiKey(v);
    v ? localStorage.setItem("acs3-key", v) : localStorage.removeItem("acs3-key");
  };

  const addLead = () => {
    if (!leadForm.name) return;
    const updated = { ...localProfile, leads: [...(localProfile.leads || []), { ...leadForm }] };
    setLocalProfile(updated);
    setLeadForm({ name: "", link: "", hunt: "3", desc: "" });
    setShowAddLead(false);
  };

  const deleteLead = (i) => setLocalProfile(p => ({ ...p, leads: p.leads.filter((_, idx) => idx !== i) }));

  const addMat = () => {
    const combinedText = [matForm.text, matForm.fileText].filter(Boolean).join("\n\n");
    if (!matForm.name || !combinedText) return;
    const { fileText, ...rest } = matForm;
    const updated = { ...localProfile, materials: [...(localProfile.materials || []), { ...rest, text: combinedText }] };
    setLocalProfile(updated);
    setMatForm({ name: "", text: "", use: { idea: true, script: false, copy: false } });
    setShowAddMat(false);
  };

  const deleteMat = (i) => setLocalProfile(p => ({ ...p, materials: p.materials.filter((_, idx) => idx !== i) }));

  const appendFieldFile = async (field, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > MAX_FILE_SIZE) { alert(`Файл слишком большой (${formatFileSize(file.size)}). Максимум ${formatFileSize(MAX_FILE_SIZE)}.`); return; }
    const { text, fileType } = await parseFile(file);
    const filesKey = `${field}_files`;
    setLocalProfile(p => ({
      ...p,
      [filesKey]: [...(p[filesKey] || []), { id: genDocId(), fileName: file.name, fileType, fileSize: file.size, uploadedAt: new Date().toISOString(), text }],
    }));
  };

  const removeFieldFile = (field, docId) => {
    const filesKey = `${field}_files`;
    setLocalProfile(p => ({ ...p, [filesKey]: (p[filesKey] || []).filter(f => f.id !== docId) }));
  };

  const attachMatFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > MAX_FILE_SIZE) { alert(`Файл слишком большой (${formatFileSize(file.size)}). Максимум ${formatFileSize(MAX_FILE_SIZE)}.`); return; }
    const { text, fileType } = await parseFile(file);
    setMatForm(p => ({ ...p, name: p.name || file.name.replace(/\.[^.]+$/, ""), fileText: text, fileName: file.name, fileType, fileSize: file.size, uploadedAt: new Date().toISOString() }));
  };

  const keyOk = apiKey.startsWith("sk-ant-");

  return (
    <div style={{ ...s.panel }}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>Профиль ниши</div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>Все данные используются агентами при каждой генерации для этой ниши</div>

      <div style={{ ...s.card }}>
        <span style={s.label}>Название ниши</span>
        <input style={s.field} value={localProfile.name || ""} onChange={e => setLocalProfile(p => ({ ...p, name: e.target.value }))} placeholder="Например, «Личный бренд» или «Клиент А»" />
      </div>

      {/* API KEY */}
      <div style={{ ...s.card, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.brownS, whiteSpace: "nowrap" }}>🔑 API-ключ</span>
        <input type="password" value={apiKey} onChange={e => saveKey(e.target.value)} placeholder="sk-ant-api03-..." style={{ ...s.field, flex: 1, minWidth: 160 }} />
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: keyOk ? COLORS.greenL : COLORS.cream, color: keyOk ? COLORS.green : COLORS.brownS, border: `1.5px solid ${keyOk ? "#A7D7B8" : COLORS.brd}`, whiteSpace: "nowrap" }}>
          {apiKey.length === 0 ? "Не введён" : keyOk ? "✓ Сохранён" : "⚠ Формат?"}
        </span>
        <span style={{ fontSize: 10, color: COLORS.brownS }}>console.anthropic.com → API Keys</span>
      </div>

      {/* BASE FIELDS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 11, marginBottom: 11 }}>
        {[{ id: "ca", title: "🎯 Целевая аудитория", hint: "Кто она, боли, желания" },
          { id: "prod", title: "💎 Продукты и воронка", hint: "Продукты, цены, воронка" },
          { id: "tov", title: "🎙 Тон и стиль (TOV)", hint: "Как говоришь, обороты" }].map(f => (
          <div key={f.id} style={s.card}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 2 }}>{f.title}</div>
            <div style={{ fontSize: 10, color: COLORS.brownS, marginBottom: 7 }}>{f.hint}</div>
            <textarea style={{ ...s.field, minHeight: 110 }} rows={5} value={localProfile[f.id] || ""} onChange={e => setLocalProfile(p => ({ ...p, [f.id]: e.target.value }))} />
            <label style={{ ...s.btnOutline, ...s.btnSm, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 7, cursor: "pointer" }}>
              📎 Загрузить файл
              <input type="file" accept={FILE_ACCEPT} onChange={e => appendFieldFile(f.id, e)} style={{ display: "none" }} />
            </label>
            {(localProfile[`${f.id}_files`] || []).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap" }}>
                {localProfile[`${f.id}_files`].map(doc => (
                  <DocumentChip key={doc.id} {...doc} onRemove={() => removeFieldFile(f.id, doc.id)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* LEADS */}
      <div style={s.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>🧲 Лид-магниты</div>
            <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 1 }}>Агент подставит CTA по ступени Ханта</div>
          </div>
          <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={() => setShowAddLead(v => !v)}>+ Добавить</button>
        </div>
        {(localProfile.leads || []).map((l, i) => (
          <div key={i} style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "8px 11px", display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>{l.name}</div>
              <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 1 }}>Ступени: {l.hunt} · {l.link}</div>
            </div>
            <button onClick={() => deleteLead(i)} style={{ background: "none", border: "none", color: COLORS.brownS, cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        ))}
        {showAddLead && (
          <div style={{ background: COLORS.cream, border: `1.5px dashed ${COLORS.brd}`, borderRadius: 9, padding: 11 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 7 }}>
              <div><span style={s.label}>Название</span><input style={s.field} value={leadForm.name} onChange={e => setLeadForm(p => ({ ...p, name: e.target.value }))} placeholder="Гайд «5 шагов»..." /></div>
              <div><span style={s.label}>Ссылка / кодовое слово</span><input style={s.field} value={leadForm.link} onChange={e => setLeadForm(p => ({ ...p, link: e.target.value }))} placeholder="https://... или УРОК" /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 8 }}>
              <div><span style={s.label}>Ступени Ханта</span>
                <select style={s.field} value={leadForm.hunt} onChange={e => setLeadForm(p => ({ ...p, hunt: e.target.value }))}>
                  <option value="1-2">1–2 (холодная)</option>
                  <option value="3">3 (ищет решение)</option>
                  <option value="4-5">4–5 (готова купить)</option>
                  <option value="all">Любая</option>
                </select>
              </div>
              <div><span style={s.label}>Описание</span><input style={s.field} value={leadForm.desc} onChange={e => setLeadForm(p => ({ ...p, desc: e.target.value }))} placeholder="Что внутри..." /></div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...s.btnRose, ...s.btnSm }} onClick={addLead}>Сохранить</button>
              <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={() => setShowAddLead(false)}>Отмена</button>
            </div>
          </div>
        )}
      </div>

      {/* MATERIALS */}
      <div style={s.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>📁 Мои материалы</div>
            <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 1 }}>Контент-план, идеи, разборы конкурентов</div>
          </div>
          <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={() => setShowAddMat(v => !v)}>+ Добавить</button>
        </div>
        {(localProfile.materials || []).map((m, i) => (
          <div key={i} style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "8px 11px", display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 16 }}>{m.fileType === "docx" ? "📘" : "📄"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>{m.name}</div>
              {m.fileName ? (
                <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 1 }}>{m.fileName}{m.fileSize != null ? ` · ${formatFileSize(m.fileSize)}` : ""}</div>
              ) : (
                <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 1 }}>{m.text.substring(0, 80)}...</div>
              )}
            </div>
            <button onClick={() => deleteMat(i)} style={{ background: "none", border: "none", color: COLORS.brownS, cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        ))}
        {showAddMat && (
          <div style={{ background: COLORS.cream, border: `1.5px dashed ${COLORS.brd}`, borderRadius: 9, padding: 11 }}>
            <div style={{ marginBottom: 6 }}><span style={s.label}>Название</span><input style={s.field} value={matForm.name} onChange={e => setMatForm(p => ({ ...p, name: e.target.value }))} placeholder="Контент-план на июнь..." /></div>
            <div style={{ marginBottom: 6 }}>
              <span style={s.label}>Использовать при</span>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {["idea", "script", "copy"].map(k => (
                  <label key={k} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, cursor: "pointer" }}>
                    <input type="checkbox" checked={matForm.use[k]} onChange={e => setMatForm(p => ({ ...p, use: { ...p.use, [k]: e.target.checked } }))} />
                    {k === "idea" ? "Идея" : k === "script" ? "Сценарий" : "Тексты"}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={s.label}>Текст</span>
              <textarea style={{ ...s.field, minHeight: 70 }} rows={3} value={matForm.text} onChange={e => setMatForm(p => ({ ...p, text: e.target.value }))} placeholder="Вставь текст или загрузи файл..." />
              <label style={{ ...s.btnOutline, ...s.btnSm, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer" }}>
                📎 Загрузить файл
                <input type="file" accept={FILE_ACCEPT} onChange={attachMatFile} style={{ display: "none" }} />
              </label>
              {matForm.fileName && (
                <div>
                  <DocumentChip fileName={matForm.fileName} fileType={matForm.fileType} fileSize={matForm.fileSize} onRemove={() => setMatForm(p => ({ ...p, fileName: undefined, fileType: undefined, fileSize: undefined, uploadedAt: undefined, fileText: undefined }))} />
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...s.btnRose, ...s.btnSm }} onClick={addMat}>Сохранить</button>
              <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={() => setShowAddMat(false)}>Отмена</button>
            </div>
          </div>
        )}
      </div>

      {/* MEMORY */}
      <div style={s.card}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>🧠 Память студии</div>
        <div style={{ fontSize: 10, color: COLORS.brownS, marginBottom: 8 }}>Паттерны которые работают — агенты учитывают при генерации</div>
        <textarea style={{ ...s.field, minHeight: 70 }} rows={3} value={localProfile.memory || ""} onChange={e => setLocalProfile(p => ({ ...p, memory: e.target.value }))} placeholder="Мои лучшие ролики начинаются с истории провала..." />
        <label style={{ ...s.btnOutline, ...s.btnSm, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 7, cursor: "pointer" }}>
          📎 Загрузить файл
          <input type="file" accept={FILE_ACCEPT} onChange={e => appendFieldFile("memory", e)} style={{ display: "none" }} />
        </label>
        {(localProfile.memory_files || []).length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {localProfile.memory_files.map(doc => (
              <DocumentChip key={doc.id} {...doc} onRemove={() => removeFieldFile("memory", doc.id)} />
            ))}
          </div>
        )}
      </div>

      {/* SAVE */}
      <div style={{ ...s.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11, color: COLORS.brownS }}>Данные хранятся в браузере</div>
        <button style={s.btnRose} onClick={handleSave}>💾 Сохранить профиль</button>
      </div>
    </div>
  );
}

// ── CONTENT PLAN ──
function buildPlanParserSystem() {
  return `Ты — парсер контент-планов. Тебе дан текст документа с готовым контент-планом пользователя (даты и/или темы, возможно с платформами и заметками).

ЗАДАЧА:
Преобразуй его в JSON-массив в следующем формате, сохраняя порядок:
{"day": <номер по порядку или дата, если явно указана>, "platform": "<если платформа указана в документе — она; если нет — null>", "topic": "<тема, как в документе, без искажений>", "stage": <оцени этап Лестницы Ханта 1-5 по формулировке темы; если неочевидно — 2>, "опора": "из документа пользователя"}

ПРАВИЛА:
- Не выдумывай темы, которых нет в документе.
- Если тем меньше или больше 30 — верни столько, сколько реально есть, не дополняй и не обрезай.
- Если платформа не указана явно — верни null, не угадывай.

ФОРМАТ ОТВЕТА: только валидный JSON-массив, без пояснений и markdown.`;
}

function UploadPlanModal({ onClose, onParsed }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rawReply, setRawReply] = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  };

  const parse = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError("");
    setRawReply("");
    let raw = "";
    try {
      raw = await callAPI([{ role: "user", content: text }], buildPlanParserSystem(), 8000);
      if (!raw) throw new Error("Агент вернул пустой ответ. Попробуй ещё раз.");
      const rows = parseJSONArray(raw);
      onParsed(rows);
    } catch (e) {
      setError(e.message || "Ошибка запроса");
      setRawReply(raw);
    }
    setLoading(false);
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...s.modal, maxWidth: 520 }}>
        <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 12, color: COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>Загрузить свой план</div>
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 12 }}>Вставь текст плана или загрузи файл — формат любой: список дат и тем, таблица, просто перечисление.</div>
        <div style={{ marginBottom: 10 }}>
          <input type="file" accept=".txt,.md,text/plain" onChange={handleFile} style={{ fontSize: 11 }} />
          {fileName && <div style={{ fontSize: 10, color: COLORS.brownS, marginTop: 4 }}>Файл: {fileName}</div>}
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Или вставь текст плана сюда..." rows={8} style={{ ...s.field, minHeight: 140, marginBottom: 10 }} />
        {loading && <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>}
        {error && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{error}</div>
            {rawReply && <div style={{ fontSize: 10, color: COLORS.brownS, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: 8, maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>{rawReply}</div>}
          </div>
        )}
        <button style={{ ...s.btnRose, width: "100%", opacity: (text.trim() && !loading) ? 1 : .5 }} disabled={!text.trim() || loading} onClick={parse}>
          {loading ? "Разбираю..." : "Разобрать и загрузить план"}
        </button>
      </div>
    </div>
  );
}

function planDepthRules(typeLabel) {
  return `ПРАВИЛА ГЛУБИНЫ ПРОРАБОТКИ — САМОЕ ВАЖНОЕ:

Если тип профиля — ДОКУМЕНТ_ВОРКШОПА:
- В документе могут быть конкретные формулировки боли, возражения, фразы, которыми аудитория описывает свою проблему, реальные примеры/ситуации.
- Каждая тема ДОЛЖНА опираться на конкретный, узнаваемый элемент из документа — не общую фразу вроде "боится не успеть", а именно то, что реально написано (например: "боится, что подписчики решат, будто она непрофессионал из-за ошибок в постах" — тема должна цеплять именно это, а не абстрактную "неуверенность").
- Для каждой темы заполни поле "опора" — короткая цитата или прямая отсылка к конкретному месту документа, на которое опирается эта тема.
- Если для конкретной темы в документе НЕТ подходящей конкретики — НЕ ВЫДУМЫВАЙ. Укажи "опора": "общая логика этапа" и сформулируй тему нейтральнее, без ложной конкретики.

Если тип профиля — ИНТЕРВЬЮ:
- Данных мало (несколько строк: ниша, аудитория, боль, тон, оффер). Работай строго с тем, что есть — не придумывай цитаты, ситуации или детали, которых нет во входных данных.
- Поле "опора" в этом случае — "по краткому брифу", без цитат.`;
}

function buildPlanSystem(typeLabel, fullDoc, platformNames) {
  return `Ты — контент-стратег, создающий план публикаций на 30 дней на основе методики "Лестница Ханта" (5 этапов осознанности: 1 — не знает о проблеме, 2 — знает о проблеме, не ищет решение, 3 — ищет и сравнивает решения, 4 — выбирает конкретный продукт, 5 — уже клиент/адвокат).

ВХОДНЫЕ ДАННЫЕ:
Тип профиля: ${typeLabel}
Бриф/документ ниши: ${fullDoc || "(пусто)"}
Платформы клиента: ${platformNames}

${planDepthRules(typeLabel)}

ОБЩИЕ ПРАВИЛА:
- Каждая тема — короткая формулировка (не сам пост, только суть, до 12 слов).
- Распредели темы по всем указанным платформам примерно равномерно.
- Распредели темы по этапам Ханта осмысленным циклом: не более 2 дней подряд один этап; за месяц — все 5 этапов несколько раз; ближе к середине-концу месяца можно немного чаще давать этапы 3-4.
- Не повторяй тему дважды за 30 дней.
- Избегай общих маркетинговых клише ("успех начинается с малого", "здоровье — это важно") — если тема не может быть конкретной из-за нехватки данных, пусть будет просто нейтральной, но не банальной.

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО валидный JSON-массив из 30 объектов, без markdown-разметки и пояснений, в точности такой структуры:
[{"day": 1, "platform": "Telegram", "topic": "...", "stage": 2, "опора": "..."}, {"day": 2, "platform": "...", "topic": "...", "stage": 1, "опора": "..."}, ...]`;
}

function buildRegenItemSystem(typeLabel, fullDoc, platformName, stage, existingTopics) {
  return `Ты — контент-стратег, работающий с планом публикаций на основе методики "Лестница Ханта" (5 этапов осознанности: 1 — не знает о проблеме, 2 — знает о проблеме, не ищет решение, 3 — ищет и сравнивает решения, 4 — выбирает конкретный продукт, 5 — уже клиент/адвокат).

ВХОДНЫЕ ДАННЫЕ:
Тип профиля: ${typeLabel}
Бриф/документ ниши: ${fullDoc || "(пусто)"}
Площадка: ${platformName}
Этап Ханта: ${stage}
Уже есть в плане (не повторяться): ${existingTopics.join("; ") || "(пока пусто)"}

${planDepthRules(typeLabel)}

ЗАДАЧА: придумай ОДНУ новую тему взамен текущей, для указанных площадки и этапа Ханта. До 12 слов, без маркетинговых клише, не повторяя темы из списка выше.

ФОРМАТ ОТВЕТА: только валидный JSON-объект, без markdown-разметки и пояснений:
{"topic": "...", "опора": "..."}`;
}

function PlanRow({ item, onChange, onWritePost, onDelete, onRegenerate, regenerating }) {
  return (
    <div style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6, opacity: regenerating ? .6 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.brownS, minWidth: 44 }}>День {item.day}</span>
        <select value={item.platform} onChange={e => onChange({ platform: e.target.value })} style={{ ...s.field, width: "auto", padding: "3px 7px", fontSize: 10 }}>
          {Object.entries(PLATFORMS).map(([key, p]) => <option key={key} value={key}>{p.icon} {p.name}</option>)}
        </select>
        <select value={item.stage} onChange={e => onChange({ stage: Number(e.target.value) })} style={{ ...s.field, width: "auto", padding: "3px 7px", fontSize: 10, color: COLORS.rose, fontWeight: 700 }}>
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Ступень {n}</option>)}
        </select>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button onClick={onWritePost} disabled={regenerating} style={{ ...s.btnOutline, ...s.btnSm }}>✍️ Написать пост</button>
          <button onClick={onRegenerate} disabled={regenerating} title="Перегенерировать эту тему" style={{ ...s.btnOutline, padding: "4px 8px", fontSize: 11, borderRadius: 6 }}>{regenerating ? "…" : "↺"}</button>
          <button onClick={onDelete} disabled={regenerating} title="Удалить тему" style={{ ...s.btnOutline, padding: "4px 8px", fontSize: 11, borderRadius: 6, color: "#DC2626", borderColor: "#FECACA" }}>✕</button>
        </div>
      </div>
      <input value={item.topic} onChange={e => onChange({ topic: e.target.value })} style={{ ...s.field, fontWeight: 600 }} />
      {item.anchor && <div style={{ fontSize: 10, color: COLORS.brownS, fontStyle: "italic" }}>Опора: {item.anchor}</div>}
    </div>
  );
}

function PlanTab({ profile, onUpdateProfile, onWritePost }) {
  const plan = profile.contentPlan;
  const [selectedPlatforms, setSelectedPlatforms] = useState(plan?.platforms || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rawReply, setRawReply] = useState("");
  const [showConfirmRegen, setShowConfirmRegen] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  const togglePlatform = (key) => setSelectedPlatforms(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const handleUploaded = (rows) => {
    const nameToKey = Object.fromEntries(Object.entries(PLATFORMS).map(([key, p]) => [p.name, key]));
    const items = rows.map((it, i) => ({
      day: Number(it.day) || i + 1,
      platform: nameToKey[it.platform] || Object.keys(PLATFORMS)[0],
      topic: it.topic || "",
      stage: Math.min(5, Math.max(1, Number(it.stage) || 2)),
      anchor: it["опора"] || it.opora || it.anchor || "из документа пользователя",
    }));
    const platforms = [...new Set(items.map(it => it.platform))];
    setSelectedPlatforms(platforms);
    onUpdateProfile({ contentPlan: { platforms, items, generatedAt: new Date().toISOString(), source: "upload" } });
    setShowUpload(false);
  };

  const generate = async () => {
    if (selectedPlatforms.length === 0) return;
    setLoading(true);
    setError("");
    setRawReply("");
    const typeLabel = profile.profileType === "interview" ? "ИНТЕРВЬЮ" : "ДОКУМЕНТ_ВОРКШОПА";
    const fullDoc = buildFullNicheDocument(profile);
    const platformNames = selectedPlatforms.map(k => PLATFORMS[k].name).join(", ");
    const system = buildPlanSystem(typeLabel, fullDoc, platformNames);
    let raw = "";
    try {
      raw = await callAPI([{ role: "user", content: "Сформируй план на 30 дней. Ответь только JSON-массивом, без текста и markdown." }], system, 8000);
      if (!raw) throw new Error("Агент вернул пустой ответ. Попробуй ещё раз.");
      const rows = parseJSONArray(raw);
      const nameToKey = Object.fromEntries(Object.entries(PLATFORMS).map(([key, p]) => [p.name, key]));
      const items = rows.slice(0, 30).map((it, i) => ({
        day: Number(it.day) || i + 1,
        platform: nameToKey[it.platform] || selectedPlatforms[i % selectedPlatforms.length],
        topic: it.topic || "",
        stage: Math.min(5, Math.max(1, Number(it.stage) || 1)),
        anchor: it["опора"] || it.opora || it.anchor || "",
      }));
      onUpdateProfile({ contentPlan: { platforms: selectedPlatforms, items, generatedAt: new Date().toISOString() } });
    } catch (e) {
      setError(e.message || "Ошибка запроса");
      setRawReply(raw);
    }
    setLoading(false);
  };

  const updatePlanItem = (i, changes) => {
    const items = plan.items.map((it, idx) => idx === i ? { ...it, ...changes } : it);
    onUpdateProfile({ contentPlan: { ...plan, items } });
  };

  const deletePlanItem = (i) => {
    const items = plan.items.filter((_, idx) => idx !== i);
    onUpdateProfile({ contentPlan: { ...plan, items } });
  };

  const [regenIndex, setRegenIndex] = useState(null);

  const regenPlanItem = async (i) => {
    setRegenIndex(i);
    const item = plan.items[i];
    const typeLabel = profile.profileType === "interview" ? "ИНТЕРВЬЮ" : "ДОКУМЕНТ_ВОРКШОПА";
    const fullDoc = buildFullNicheDocument(profile);
    const platformName = PLATFORMS[item.platform]?.name || item.platform;
    const existingTopics = plan.items.filter((_, idx) => idx !== i).map(it => it.topic).filter(Boolean);
    const system = buildRegenItemSystem(typeLabel, fullDoc, platformName, item.stage, existingTopics);
    try {
      const raw = await callAPI([{ role: "user", content: "Предложи новую тему взамен текущей." }], system, 500);
      if (!raw) throw new Error("Агент вернул пустой ответ.");
      const parsed = parseJSON(raw);
      updatePlanItem(i, { topic: parsed.topic || item.topic, anchor: parsed["опора"] || parsed.opora || parsed.anchor || item.anchor });
    } catch (e) {
      alert("Ошибка: " + (e.message || "не удалось перегенерировать тему"));
    }
    setRegenIndex(null);
  };

  return (
    <div style={s.panel}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>Контент-план на месяц</div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>Темы на месяц вперёд для ниши «{profile.name}», с учётом ступеней Лестницы Ханта</div>

      <div style={s.card}>
        <span style={s.label}>Площадки</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {Object.entries(PLATFORMS).map(([key, p]) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 20, border: `1.5px solid ${selectedPlatforms.includes(key) ? COLORS.rose : COLORS.brd}`, background: selectedPlatforms.includes(key) ? COLORS.roseP : COLORS.cream, cursor: "pointer", fontSize: 11 }}>
              <input type="checkbox" checked={selectedPlatforms.includes(key)} onChange={() => togglePlatform(key)} style={{ margin: 0 }} />
              {p.icon} {p.name}
            </label>
          ))}
        </div>
        {loading && <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", margin: "12px 0" }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>}
        {error && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{error}</div>
            {rawReply && <div style={{ fontSize: 10, color: COLORS.brownS, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: 8, maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>{rawReply}</div>}
          </div>
        )}
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 12 }}>
          <button style={{ ...s.btnRose, opacity: (selectedPlatforms.length && !loading) ? 1 : .4 }} disabled={!selectedPlatforms.length || loading} onClick={() => plan ? setShowConfirmRegen(true) : generate()}>
            {loading ? "Генерирую..." : plan ? "🔄 Перегенерировать план" : "✦ Сгенерировать план"}
          </button>
          <button style={s.btnOutline} onClick={() => setShowUpload(true)}>📄 Загрузить свой план</button>
        </div>
      </div>

      {showUpload && <UploadPlanModal onClose={() => setShowUpload(false)} onParsed={handleUploaded} />}

      {plan && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, color: COLORS.brownS, marginBottom: 8 }}>{plan.source === "upload" ? "Загружен" : "Сгенерирован"} {new Date(plan.generatedAt).toLocaleDateString("ru")} · {plan.items.length} тем{plan.source !== "upload" ? ` · тип профиля: ${profile.profileType === "interview" ? "по интервью" : "по документу воркшопа"}` : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {plan.items.map((item, i) => (
              <PlanRow
                key={i} item={item}
                onChange={(changes) => updatePlanItem(i, changes)}
                onWritePost={() => onWritePost(item)}
                onDelete={() => deletePlanItem(i)}
                onRegenerate={() => regenPlanItem(i)}
                regenerating={regenIndex === i}
              />
            ))}
          </div>
        </div>
      )}

      {showConfirmRegen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(35,18,26,.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: 300, width: "90%", textAlign: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Перегенерировать план?</div>
            <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 16 }}>Текущий план на 30 дней будет заменён новым.</div>
            <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
              <button style={{ ...s.btnRose, background: "#DC2626" }} onClick={() => { setShowConfirmRegen(false); generate(); }}>Перегенерировать</button>
              <button style={s.btnOutline} onClick={() => setShowConfirmRegen(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ONBOARDING: CHOICE ──
function OnboardingChoice({ onClose, onInterview, onManual }) {
  return (
    <div style={s.overlay} onClick={e => { if (onClose && e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...s.modal, maxWidth: 440, textAlign: "center" }}>
        {onClose && <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 12, color: COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>}
        <div style={{ fontSize: 30, marginBottom: 8 }}>✦</div>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 8 }}>Добро пожаловать в AI Content Studio</div>
        <div style={{ fontSize: 12, color: COLORS.brownS, lineHeight: 1.6, marginBottom: 20 }}>
          Чтобы студия сразу выдала результат ближе к твоей нише, ответь на несколько коротких вопросов — это займёт минуту. Учти: это быстрая настройка «на глаз». Для по-настоящему персонализированных ответов, которые звучат именно твоим голосом, рекомендуем пройти обучение (воркшоп) — там ты обучаешь студию под себя куда глубже.
        </div>
        <button style={{ ...s.btnRose, width: "100%", marginBottom: 8 }} onClick={onInterview}>⚡ Быстрый старт (4 вопроса)</button>
        <button style={{ ...s.btnOutline, width: "100%" }} onClick={onManual}>✍️ Заполню сам</button>
      </div>
    </div>
  );
}

// ── ONBOARDING: INTERVIEW WIZARD ──
const INTERVIEW_QUESTIONS = [
  { key: "q1", label: "Чем ты занимаешься / что продаёшь?", placeholder: "Например: провожу консультации по..." },
  { key: "q2", label: "Кто твой клиент?", placeholder: "Пол, возраст, сфера — можно одной строкой" },
  { key: "q3", label: "Какой тон тебе ближе?", type: "buttons", options: ["Дружелюбно на «ты»", "Экспертно и по делу", "С юмором и лёгкостью", "Вдохновляюще и эмоционально"] },
  { key: "q4", label: "Что нужно продвигать через контент прямо сейчас?", placeholder: "Курс / консультации / личный бренд / продукт" },
];

const INTERVIEWER_SYSTEM = `Ты — дружелюбный интервьюер AI Content Studio. Твоя задача — за 4 коротких вопроса собрать бриф о нише пользователя, чтобы дальше на основе него генерировать контент по методике "Лестница Ханта".

ПРАВИЛА ВЕДЕНИЯ ДИАЛОГА:
- Задавай ровно ОДИН вопрос за раз, жди ответа, потом переходи к следующему.
- Тон — тёплый, простой, без маркетинговых терминов. Пользователь может быть новичком.
- Не объясняй методологию Ханта пользователю и не спрашивай про неё напрямую.
- Если ответ пользователя короткий или расплывчатый — прими его как есть, не дожимай уточнениями (это быстрый тест, не глубокое интервью).

ПОСЛЕДОВАТЕЛЬНОСТЬ ВОПРОСОВ:
1. "Чем ты занимаешься / что продаёшь?"
2. "Кто твой клиент? (например: пол, возраст, сфера — можно одной строкой)"
3. "Какой тон тебе ближе?" — предложи варианты: дружелюбно на «ты» / экспертно и по делу / с юмором и лёгкостью / вдохновляюще и эмоционально
4. "Что нужно продвигать через контент прямо сейчас?" (курс / консультации / личный бренд / продукт — свободный ответ)

ПОСЛЕ 4-го ОТВЕТА:
Самостоятельно, не показывая рассуждение пользователю, определи вероятный этап осознанности аудитории по Ханту на основе ответов 1 и 2:
- если аудитория описана как "новички", "только начинают", "не знают, что делать" → этап 1-2
- если "уже пробовали", "ищут специалиста", "сравнивают варианты" → этап 3-4
- если неясно — по умолчанию бери этап 2.

Затем сформируй финальный бриф СТРОГО в следующем формате, без лишних слов до или после, уложись в 800 символов:

###PROFILE_START###
НИША: [коротко, 1 строка]
АУДИТОРИЯ: [коротко, 1 строка]
БОЛЬ: [твой вывод на основе ответов — 1 строка]
ТОН: [выбранный вариант]
ОФФЕР: [что продвигаем]
ЭТАП_ХАНТА: [1-5]
###PROFILE_END###

После этого блока добавь одну дружелюбную фразу для пользователя: "Готово! Собрал бриф — теперь можно генерировать контент под твою нишу. Для более глубокой персонализации (примеры твоих постов, точные боли аудитории, твой стиль речи) — рекомендуем пройти обучение в воркшопе."`;

function InterviewWizard({ onCancel, onComplete }) {
  const [step, setStep] = useState(0); // 0-3 questions, 4 loading, 5 review
  const [answers, setAnswers] = useState({ q1: "", q2: "", q3: "", q4: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [editName, setEditName] = useState("");
  const [rawReply, setRawReply] = useState("");

  const q = INTERVIEW_QUESTIONS[step];
  const answered = q ? (answers[q.key] || "").trim().length > 0 : false;

  const runInterview = async () => {
    setLoading(true);
    setError("");
    // A single explicit message (rather than a faked multi-turn transcript)
    // so the model can't mistake this for a mid-interview turn and reply
    // conversationally instead of emitting the final PROFILE block.
    const messages = [
      { role: "user", content: `Пользователь ответил на все 4 вопроса интервью:\n1. Чем ты занимаешься / что продаёшь? — ${answers.q1}\n2. Кто твой клиент? — ${answers.q2}\n3. Какой тон тебе ближе? — ${answers.q3}\n4. Что нужно продвигать через контент прямо сейчас? — ${answers.q4}\n\nЭто был последний, 4-й ответ. Сформируй финальный бриф строго по инструкции из системного промпта (блок ###PROFILE_START###...###PROFILE_END### и ничего похожего до/после кроме финальной дружелюбной фразы).` },
    ];
    try {
      const reply = await callAPI(messages, INTERVIEWER_SYSTEM, 1200);
      // Be lenient: the model can wrap the block in code fences, use a
      // different number of #, or (rarely) omit the closing marker.
      const cleaned = reply.replace(/```[a-z]*\n?/gi, "");
      let m = cleaned.match(/#{2,}\s*PROFILE_START\s*#{2,}([\s\S]+?)#{2,}\s*PROFILE_END\s*#{2,}/i);
      if (!m) m = cleaned.match(/#{2,}\s*PROFILE_START\s*#{2,}([\s\S]+)/i);
      if (!m) {
        setRawReply(reply);
        throw new Error("Не удалось разобрать ответ агента. Попробуй ещё раз.");
      }
      const block = m[1];
      const get = (label) => { const mm = block.match(new RegExp(label + ":\\s*(.+)")); return mm ? mm[1].trim() : ""; };
      const niche = get("НИША");
      const audience = get("АУДИТОРИЯ");
      const pain = get("БОЛЬ");
      const tone = get("ТОН");
      const offer = get("ОФФЕР");
      const huntStage = parseInt(get("ЭТАП_ХАНТА")) || null;
      if (!niche && !audience && !tone) {
        setRawReply(reply);
        throw new Error("Агент ответил, но бриф пустой. Попробуй ещё раз.");
      }
      const data = {
        ca: [audience, pain ? `Боль: ${pain}` : ""].filter(Boolean).join("\n"),
        prod: [niche, offer ? `Продвигаем сейчас: ${offer}` : ""].filter(Boolean).join("\n"),
        tov: tone,
        huntStage,
      };
      setResult(data);
      setEditName(niche.slice(0, 40) || "Новая ниша");
      setStep(5);
    } catch (e) {
      setError(e.message || "Ошибка запроса");
    }
    setLoading(false);
  };

  const next = () => {
    if (step < 3) { setStep(step + 1); return; }
    setStep(4);
    runInterview();
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ ...s.modal, maxWidth: 480 }}>
        <button onClick={onCancel} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 12, color: COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>

        {step <= 3 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.brownS, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Вопрос {step + 1} из 4</div>
            <div style={{ display: "flex", gap: 3, marginBottom: 16 }}>
              {[0, 1, 2, 3].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? COLORS.rose : COLORS.brd }} />)}
            </div>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 14 }}>{q.label}</div>
            {q.type === "buttons" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {q.options.map(opt => (
                  <button key={opt} onClick={() => setAnswers(a => ({ ...a, [q.key]: opt }))} style={{ padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${answers.q3 === opt ? COLORS.rose : COLORS.brd}`, background: answers.q3 === opt ? COLORS.roseP : COLORS.cream, color: answers.q3 === opt ? COLORS.rose : COLORS.brown, fontSize: 12, fontWeight: answers.q3 === opt ? 700 : 500, cursor: "pointer", textAlign: "left" }}>{opt}</button>
                ))}
              </div>
            ) : (
              <textarea autoFocus value={answers[q.key]} onChange={e => setAnswers(a => ({ ...a, [q.key]: e.target.value }))} placeholder={q.placeholder} rows={3} style={{ ...s.field, minHeight: 70, marginBottom: 16 }} />
            )}
            <div style={{ display: "flex", gap: 7 }}>
              {step > 0 && <button style={s.btnOutline} onClick={() => setStep(step - 1)}>← Назад</button>}
              <button style={{ ...s.btnRose, flex: 1, opacity: answered ? 1 : .4, cursor: answered ? "pointer" : "not-allowed" }} disabled={!answered} onClick={next}>{step === 3 ? "Собрать бриф →" : "Дальше →"}</button>
            </div>
          </>
        )}

        {step === 4 && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            {loading && <>
              <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", marginBottom: 16, maxWidth: 200, margin: "0 auto 16px" }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>
              <div style={{ fontSize: 12, color: COLORS.brownS }}>Собираю бриф на основе ответов...</div>
            </>}
            {error && (
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: 12, color: "#DC2626", marginBottom: 10, textAlign: "center" }}>{error}</div>
                {rawReply && (
                  <div style={{ fontSize: 10, color: COLORS.brownS, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: 9, marginBottom: 14, maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{rawReply}</div>
                )}
                <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
                  <button style={s.btnOutline} onClick={() => setStep(3)}>← Назад к вопросам</button>
                  <button style={s.btnRose} onClick={runInterview}>Повторить</button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 5 && result && (
          <>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Бриф готов</div>
            <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>Проверь и поправь, если нужно — потом можно изменить в любой момент в профиле</div>
            <div style={{ marginBottom: 10 }}>
              <span style={s.label}>Название ниши</span>
              <input style={s.field} value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <span style={s.label}>🎯 Целевая аудитория</span>
              <textarea style={{ ...s.field, minHeight: 60 }} rows={2} value={result.ca} onChange={e => setResult(r => ({ ...r, ca: e.target.value }))} />
              <label style={{ ...s.btnOutline, ...s.btnSm, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer" }}>
                📎 Загрузить файл
                <input type="file" accept={FILE_ACCEPT} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; e.target.value = ""; if (f.size > MAX_FILE_SIZE) { alert(`Файл слишком большой (${formatFileSize(f.size)}). Максимум ${formatFileSize(MAX_FILE_SIZE)}.`); return; } const { text } = await parseFile(f); setResult(r => ({ ...r, ca: (r.ca ? r.ca + "\n\n" : "") + text })); }} style={{ display: "none" }} />
              </label>
            </div>
            <div style={{ marginBottom: 10 }}>
              <span style={s.label}>💎 Продукты и воронка</span>
              <textarea style={{ ...s.field, minHeight: 60 }} rows={2} value={result.prod} onChange={e => setResult(r => ({ ...r, prod: e.target.value }))} />
              <label style={{ ...s.btnOutline, ...s.btnSm, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, cursor: "pointer" }}>
                📎 Загрузить файл
                <input type="file" accept={FILE_ACCEPT} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; e.target.value = ""; if (f.size > MAX_FILE_SIZE) { alert(`Файл слишком большой (${formatFileSize(f.size)}). Максимум ${formatFileSize(MAX_FILE_SIZE)}.`); return; } const { text } = await parseFile(f); setResult(r => ({ ...r, prod: (r.prod ? r.prod + "\n\n" : "") + text })); }} style={{ display: "none" }} />
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <span style={s.label}>🎙 Тон и стиль (TOV)</span>
              <input style={s.field} value={result.tov} onChange={e => setResult(r => ({ ...r, tov: e.target.value }))} />
            </div>
            <button style={{ ...s.btnRose, width: "100%" }} onClick={() => onComplete({ name: editName, ca: result.ca, prod: result.prod, tov: result.tov, huntStage: result.huntStage })}>Сохранить и начать →</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── NEW CARD MODAL ──
function NewCardModal({ profile, onClose, onCreate }) {
  const [platform, setPlatform] = useState("ig");
  const [format, setFormat] = useState("Reels");
  const [hunt, setHunt] = useState(profile.huntStage || 0);
  const [leadIdx, setLeadIdx] = useState("");
  const [topic, setTopic] = useState("");

  const fmts = PLATFORMS[platform]?.formats || [];

  const create = () => {
    const reel = { ...makeReel({ platform, format, hunt, topic }), profileId: profile.id, lead_magnet_idx: leadIdx !== "" ? parseInt(leadIdx) : null };
    onCreate(reel);
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...s.modal, maxWidth: 460 }}>
        <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 12, color: COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 14 }}>Новый ролик</div>

        <div style={{ marginBottom: 10 }}>
          <span style={s.label}>Площадка</span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
            {Object.entries(PLATFORMS).map(([key, p]) => (
              <button key={key} onClick={() => { setPlatform(key); setFormat(p.formats[0]); }} style={{ padding: "5px 10px", borderRadius: 7, border: `1.5px solid ${platform === key ? "transparent" : COLORS.brd}`, background: platform === key ? (key === "ig" ? "linear-gradient(135deg,#ea580c,#db2777,#9333ea)" : key === "yt" ? "#DC2626" : key === "tg" ? "#0284C7" : key === "tt" ? "#1A1A1A" : key === "th" ? "#4C3490" : "#1D6FBF") : COLORS.cream, color: platform === key ? "#fff" : COLORS.brownS, fontSize: 11, cursor: "pointer", fontWeight: platform === key ? 600 : 400 }}>
                {p.icon} {p.name}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {fmts.map(f => (
              <button key={f} onClick={() => setFormat(f)} style={{ padding: "3px 9px", borderRadius: 6, border: `1.5px solid ${format === f ? COLORS.rose : COLORS.brd}`, background: format === f ? COLORS.roseL : COLORS.cream, color: format === f ? COLORS.rose : COLORS.brownS, fontSize: 10, cursor: "pointer", fontWeight: format === f ? 600 : 400 }}>{f}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <span style={s.label}>Ступень Ханта</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 3, marginBottom: 4 }}>
            {[0,1,2,3,4,5].map(n => (
              <button key={n} onClick={() => setHunt(n)} style={{ padding: "4px 2px", borderRadius: 6, border: `1.5px solid ${hunt === n ? COLORS.rose : COLORS.brd}`, background: hunt === n ? COLORS.roseL : COLORS.cream, color: hunt === n ? COLORS.rose : COLORS.brownS, fontSize: 10, cursor: "pointer", fontWeight: hunt === n ? 700 : 400, textAlign: "center" }}>{n === 0 ? "Авто" : n}</button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: COLORS.brownS }}>{HUNT_HINTS[hunt]}</div>
        </div>

        {(profile.leads || []).length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <span style={s.label}>Лид-магнит</span>
            <select style={s.field} value={leadIdx} onChange={e => setLeadIdx(e.target.value)}>
              <option value="">— Выбрать —</option>
              {profile.leads.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
            </select>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <span style={s.label}>Тема (необязательно)</span>
          <textarea style={{ ...s.field, minHeight: 50 }} rows={2} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Оставь пустым — Идеолог поможет придумать..." />
        </div>
        <button style={{ ...s.btnRose, width: "100%" }} onClick={create}>Создать и открыть →</button>
      </div>
    </div>
  );
}

// ── CARD MODAL ──
function CardModal({ reel, profile, reels, onUpdate, onDelete }) {
  const [step, setStep] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);
  const p = PLATFORMS[reel.platform];
  const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;

  const statusIdx = STATUSES.findIndex(s => s.key === reel.status);

  return (
    <div>
      {/* HEADER */}
      <input value={reel.topic} onChange={e => onUpdate({ topic: e.target.value })} placeholder="Тема ролика..." style={{ ...s.field, fontWeight: 700, fontSize: 15, marginBottom: 7, paddingRight: 36 }} />
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <Badge bg={COLORS.blueL} color={COLORS.blue}>{p?.icon} {p?.name} · {reel.format}</Badge>
        {reel.hunt_stage ? <Badge bg={COLORS.roseL} color={COLORS.rose}>Ступень {reel.hunt_stage}</Badge> : null}
        {lead ? <Badge bg={COLORS.greenL} color={COLORS.green}>🧲 {lead.name}</Badge> : null}
      </div>

      {/* STATUS */}
      <div style={{ marginBottom: 14 }}>
        <span style={s.label}>Статус</span>
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
          {STATUSES.map((st, i) => (
            <span key={st.key}>
              {i > 0 && <span style={{ color: COLORS.brd, fontSize: 11, marginRight: 5 }}>→</span>}
              <button onClick={() => onUpdate({ status: st.key })} style={{ padding: "5px 10px", borderRadius: 7, border: `1.5px solid ${reel.status === st.key ? COLORS.rose : i < statusIdx ? COLORS.green : COLORS.brd}`, background: reel.status === st.key ? COLORS.rose : i < statusIdx ? COLORS.greenL : COLORS.cream, color: reel.status === st.key ? "#fff" : i < statusIdx ? COLORS.green : COLORS.brownS, fontSize: 11, fontWeight: reel.status === st.key ? 600 : 400, cursor: "pointer" }}>
                {i < statusIdx ? "✓ " : ""}{st.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* STEP TABS */}
      <div style={{ display: "flex", border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, overflow: "hidden", marginBottom: 16 }}>
        {["1 · Идея", "2 · Сценарий", "3 · Тексты", "4 · Заметки"].map((t, i) => (
          <button key={i} onClick={() => setStep(i)} style={{ flex: 1, padding: "7px 4px", border: "none", borderRight: i < 3 ? `1px solid ${COLORS.brd}` : "none", background: step === i ? COLORS.rose : (i === 1 && reel.script_versions?.length) || (i === 2 && reel.copy && Object.keys(reel.copy).length) ? COLORS.greenL : COLORS.cream, color: step === i ? "#fff" : (i === 1 && reel.script_versions?.length) || (i === 2 && reel.copy && Object.keys(reel.copy).length) ? COLORS.green : COLORS.brownS, fontSize: 10, fontWeight: 700, cursor: "pointer", textAlign: "center" }}>{t}</button>
        ))}
      </div>

      {step === 0 && <IdeaStep reel={reel} profile={profile} reels={reels} onUpdate={onUpdate} onAdvance={() => setStep(1)} />}
      {step === 1 && <ScriptStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(2)} />}
      {step === 2 && <CopyStep reel={reel} profile={profile} onUpdate={onUpdate} />}
      {step === 3 && (
        <NotesStep reel={reel} onUpdate={onUpdate} onDeleteRequest={() => setShowConfirm(true)} />
      )}

      {showConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(35,18,26,.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: 300, width: "90%", textAlign: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Удалить ролик?</div>
            <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 16 }}>Это нельзя отменить.</div>
            <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
              <button style={{ ...s.btnRose, background: "#DC2626" }} onClick={onDelete}>Удалить</button>
              <button style={s.btnOutline} onClick={() => setShowConfirm(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── IDEA STEP ──
function IdeaStep({ reel, profile, reels, onUpdate, onAdvance }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const chatRef = useRef(null);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [reel.idea_chat]);

  const buildSystem = () => {
    const existingTopics = reels.filter(x => x.id !== reel.id && x.topic).map(x => x.topic).join(", ");
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const p = PLATFORMS[reel.platform];
    let ctx = "";
    if (profile.ca || profile.ca_files?.length) ctx += `=== ЦА ===\n${smartTruncate(fieldContext(profile, "ca"), 2000)}\n\n`;
    if (profile.prod || profile.prod_files?.length) ctx += `=== ПРОДУКТЫ И ВОРОНКА ===\n${smartTruncate(fieldContext(profile, "prod"), 2000)}\n\n`;
    if (profile.tov || profile.tov_files?.length) ctx += `=== TOV ===\n${smartTruncate(fieldContext(profile, "tov"), 1200)}\n\n`;
    if (profile.memory || profile.memory_files?.length) ctx += `=== ПАТТЕРНЫ ===\n${smartTruncate(fieldContext(profile, "memory"), 1000)}\n\n`;
    ctx += buildMaterialsCtx(profile.materials, "idea");

    return `Ты — Идеолог, стратег по вирусному контенту. Тон — честный и по делу: не хвалишь идею ради вежливости, а сразу называешь сильные и слабые стороны.\n\n${ctx}\nПлощадка: ${p?.name} · ${reel.format}\n${reel.hunt_stage ? `Ступень Ханта: ${reel.hunt_stage} (${HUNT_HINTS[reel.hunt_stage]})` : "Ступень: определи сам, исходя из площадки"}\n${existingTopics ? `Уже снятые темы (не повторяться): ${existingTopics}` : ""}\n${lead ? `Лид-магнит: ${lead.name} (${lead.link})` : ""}\n\nЕсли темы нет — задай МАКСИМУМ 1 вопрос за раз (не больше 2 за сессию): что происходит в жизни/бизнесе сейчас / какой вопрос чаще всего задают клиенты / что раздражает в нише.\n\nЕсли тема есть:\n— Предложи 2-3 угла подачи (формулы: факт+эмоция, статистика+последствие, разрушение мифа/контраст "думают VS на самом деле"). По каждому углу — одна короткая фраза, что в нём цепляет (контроверсивность/любопытство/painful/общий враг), без построчного разбора всей формулы виральности. Если угол слабый — сразу скажи, что усилить, не спрашивай "что делать"\n— Если боль в теме абстрактная — сам предложи конкретную бытовую деталь и переверни её в хук (боль → хук), не дожидаясь примера от пользователя\n— Учти тон площадки: Threads — самая резкая провокация; Instagram/TikTok — мягче, через наблюдение; Telegram — экспертно, без провокации ради провокации\n— Обоснуй, зачем снимать для воронки\n— Вопросы — по минимуму: максимум ОДИН вопрос за весь ответ, и только если без ответа реально нельзя предложить конкретный угол. Если можешь сам додумать деталь или пример — предлагай её сам вместо вопроса, не спрашивай "на всякий случай"\n\nНе выдумывай факты. Контроверсия — про мнение, не про ложь. "Общий враг" — система/привычка/миф, не человек.\n\nЕсли предлагаешь НЕСКОЛЬКО вариантов темы — оформляй их не строкой "ТЕМА:", а просто заголовками (например "Вариант 1: ..."), чтобы не путать с финальным выбором.\nСтрокой "ТЕМА: ..." начинай только когда пользователь явно выбрал или согласовал ОДНУ конкретную тему — в этой строке должна быть именно она, без номера.\n\nЕсли пользователь готов перейти к сценаристу (получено служебное сообщение о переходе), заверши диалог итоговым блоком СТРОГО в этом формате, без лишнего текста до или после:\n\n###ANGLE_START###\nУГОЛ: [номер и краткое название выбранного угла]\nОБОСНОВАНИЕ: [1-2 предложения, почему этот угол работает для этой аудитории/этапа]\nХУК: [конкретная фраза-зацепка, если она обсуждалась]\n###ANGLE_END###\n\nОтвечай кратко, по делу, на русском.`;
  };

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const system = buildSystem();
    const newChat = [...(reel.idea_chat || []), { role: "user", content: msg }];
    onUpdate({ idea_chat: newChat });
    try {
      const messages = newChat.filter(m => m.role !== "note").slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 1600);
      const updatedChat = [...newChat, { role: "assistant", content: reply }];
      let updates = { idea_chat: updatedChat };
      // Match only an unambiguous single "ТЕМА:" line — not "ТЕМА 1:",
      // "ТЕМА 2:" style numbered options, which we can't safely auto-pick
      // between. Always take the latest such line (no "only if empty"
      // guard) so topic tracks whatever was most recently agreed, not
      // whichever suggestion happened to come first in the conversation.
      const tm = reply.match(/^ТЕМА:\s*(.+)$/m);
      if (tm) updates.topic = tm[1].trim();
      onUpdate(updates);
    } catch (e) {
      onUpdate({ idea_chat: [...newChat, { role: "assistant", content: "Ошибка: " + e.message }] });
    }
    setLoading(false);
  };

  const handoffToScript = async () => {
    setHandoffLoading(true);
    setHandoffError("");
    const system = buildSystem();
    const baseChat = (reel.idea_chat || []).filter(m => m.role !== "note");
    try {
      const messages = [...baseChat.slice(-6).map(m => ({ role: m.role, content: m.content })), { role: "user", content: "Пользователь готов перейти к сценаристу. Сформулируй итог обсуждения строго в формате ниже." }];
      const reply = await callAPI(messages, system, 500);
      const m = reply.match(/###ANGLE_START###([\s\S]+?)###ANGLE_END###/);
      if (!m) {
        setHandoffError("Не удалось получить итог от Идеолога. Можно попробовать снова или перейти без согласованного угла.");
        setHandoffLoading(false);
        return;
      }
      const block = m[1].trim();
      const get = (label) => { const mm = block.match(new RegExp(label + ":\\s*(.+)")); return mm ? mm[1].trim() : ""; };
      const angle = { raw: block, angle: get("УГОЛ"), rationale: get("ОБОСНОВАНИЕ"), hook: get("ХУК") };
      onUpdate({ idea_chat: [...(reel.idea_chat || []), { role: "note", content: "✓ Угол согласован, передаю сценаристу" }], agreed_angle: angle });
      onAdvance();
    } catch (e) {
      setHandoffError(e.message || "Ошибка запроса");
    }
    setHandoffLoading(false);
  };

  const skipHandoff = () => { setHandoffError(""); onAdvance(); };

  const topics = reels.filter(x => x.id !== reel.id && x.topic).slice(0, 4).map(x => x.topic).join(", ");

  return (
    <div>
      {(profile.memory || topics) && (
        <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "10px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple }}>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>🧠 Студия помнит</div>
          {profile.memory && <div>{profile.memory.substring(0, 150)}</div>}
          {topics && <div style={{ marginTop: 3, fontSize: 10 }}>Уже снятые: {topics}</div>}
        </div>
      )}
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 8 }}>{reel.topic ? "Идеолог уточнит угол и обоснует зачем снимать этот ролик" : "Нет темы? Агент поможет придумать — просто отправь сообщение"}</div>
      <div ref={chatRef} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", marginBottom: 8 }}>
        {(reel.idea_chat || []).map((m, i) => m.role === "note"
          ? <div key={i} style={{ textAlign: "center", fontSize: 10, color: COLORS.brownS, opacity: .75, fontStyle: "italic", margin: "2px 0" }}>{m.content}</div>
          : <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>
        )}
        {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Думаю...</div>}
        {handoffLoading && <div style={{ textAlign: "center", fontSize: 10, color: COLORS.brownS, opacity: .75, fontStyle: "italic", margin: "2px 0" }}>→ Готовим передачу сценаристу…</div>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 7 }}>
        {["Придумай тему с нуля", "Какой угол для ЦА?", "Проверь воронку", "5 тем на месяц"].map(q => (
          <button key={q} onClick={() => send(q)} style={{ background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: COLORS.brownS, cursor: "pointer" }}>{q}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Сообщение Идеологу..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
        <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
      </div>
      <div style={{ height: 1, background: COLORS.brd, margin: "14px 0 10px" }} />
      {handoffError && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{handoffError}</div>
          <button onClick={skipHandoff} style={{ ...s.btnOutline, ...s.btnSm }}>Перейти без согласованного угла →</button>
        </div>
      )}
      <button onClick={handoffToScript} disabled={!reel.topic || handoffLoading} style={{ ...s.btnRose, width: "100%", opacity: (reel.topic && !handoffLoading) ? 1 : .4, cursor: (reel.topic && !handoffLoading) ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {handoffLoading ? "Согласовываю угол..." : "Идея согласована — дальше к Сценаристу →"}
      </button>
    </div>
  );
}

// ── SCRIPT STEP ──
function ScriptStep({ reel, profile, onUpdate, onAdvance }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hooksError, setHooksError] = useState("");
  const [scriptDraft, setScriptDraft] = useState(reel.script_versions?.[reel.selected_script] || "");
  const chatRef = useRef(null);
  const autoGenRef = useRef(false);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [reel.script_chat]);
  useEffect(() => { setScriptDraft(reel.script_versions?.[reel.selected_script] || ""); }, [reel.selected_script, reel.script_versions]);

  const isVideo = VIDEO_FORMATS.includes(reel.format);

  useEffect(() => {
    if (autoGenRef.current) return;
    if (reel.agreed_angle && !(reel.script_versions || []).length && reel.topic?.trim() && (!isVideo || reel.shoot_format)) {
      autoGenRef.current = true;
      generateFromIdea();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel.shoot_format]);

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const p = PLATFORMS[reel.platform];
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const finalScript = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : "";
    let ctx = "";
    if (profile.ca || profile.ca_files?.length) ctx += `=== ЦА ===\n${smartTruncate(fieldContext(profile, "ca"), 2000)}\n\n`;
    if (profile.prod || profile.prod_files?.length) ctx += `=== ПРОДУКТЫ ===\n${smartTruncate(fieldContext(profile, "prod"), 2000)}\n\n`;
    if (profile.tov || profile.tov_files?.length) ctx += `=== TOV ===\n${smartTruncate(fieldContext(profile, "tov"), 1200)}\n\n`;
    ctx += buildMaterialsCtx(profile.materials, "script");

    const ideaSummary = (reel.idea_chat || []).filter(m => m.role !== "note").slice(-3).map(m => `${m.role === "user" ? "Пользователь" : "Идеолог"}: ${m.content}`).join("\n").substring(0, 500);
    const inputBlock = `ВХОДНЫЕ ДАННЫЕ:\nТема из плана: ${reel.topic}\nПлощадка: ${p?.name}\nЭтап Ханта: ${reel.hunt_stage ? `${reel.hunt_stage} — ${HUNT_HINTS[reel.hunt_stage]}` : "не определён"}\n${reel.agreed_angle ? `Согласованный с идеологом угол (ПРИОРИТЕТНЫЙ источник — пиши строго по нему):\n${reel.agreed_angle.raw}\n\nЕсли согласованный угол противоречит теме из плана — следуй согласованному углу, тема из плана нужна только для общего контекста ниши.` : ""}${ideaSummary ? `\n\nФрагменты обсуждения с Идеологом (детали, которых нет в согласованном угле, — используй если уместно):\n${ideaSummary}` : ""}`;
    const shootPlanInstr = isVideo ? `\n\nПосле СЦЕНАРИЙ: добавь отдельным блоком ПЛАН СЪЁМКИ: с ${
      reel.shoot_format === "voiceover" ? "тем, что показывать в кадре (Б-ролл) под каждую фразу начитки"
      : reel.shoot_format === "full_plan" ? "для каждого смыслового куска сценария (хук / было-плохо / перелом / стало-так / CTA) — что в кадре, ракурс и крупность, примерная локация и реквизит, текст на экране в этот момент"
      : "минимальными пометками, где сменить план/крупность для динамики (без покадрового разбора)"
    }.` : "";
    const system = `Ты — Сценарист для ${p?.name} (${reel.format}).\n\n${ctx}\n${inputBlock}\n${lead ? `Лид-магнит: ${lead.name} (${lead.link})` : ""}\n${finalScript ? `Текущий сценарий:\n${finalScript}` : ""}\n\nСтруктура:\n— хук (3 сек, до 12 слов): шок-факт/цифра, незаконченная мысль, личное признание, вопрос в боль, спор с распространённым мнением\n— середина: было плохо (конкретная деталь, не абстракция) → перелом (что произошло, какое решение принято) → стало так (результат через факт/деталь, без "и тогда я поняла, что...")\n— вывод → CTA. Тон CTA зависит от ступени Ханта: 1-2 — мягко (сохранить/подписаться, без продажи), 3 — интерес к методу (узнать больше, следующий шаг), 4-5 — прямой оффер с конкретикой, что и как получить\nДлина 30-60 сек речи.${shootPlanInstr}\n\nТон под площадку: Threads — резче, самостоятельная спорная мысль; Instagram/TikTok — мягче, через наблюдение; Telegram — экспертно, без провокации ради провокации.\n\nПравила:\n— Пиши в голосе автора (TOV)\n— Хук останавливает скролл\n— Никакого официоза, канцеляризмов, штампов ("важно понимать", "в современном мире")\n— Не больше 2 метафор на весь текст\n— Каждый раз, когда даёшь готовый текст сценария (новый или отредактированную правку) — выводи его целиком после СЦЕНАРИЙ:, без ХУКИ: — хуки предлагаются отдельным запросом после одобрения сценария. Только если пользователь явно попросил хуки в чате — выводи их после ХУКИ:, каждый хук отдельной строкой, минимум 2 варианта, без повторного СЦЕНАРИЙ:\nОтвечай на русском.`;

    const newChat = [...(reel.script_chat || []), { role: "user", content: msg }];
    onUpdate({ script_chat: newChat });
    let scriptGenerated = false;
    try {
      const messages = newChat.slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 2000);
      const updatedChat = [...newChat, { role: "assistant", content: reply }];
      let updates = { script_chat: updatedChat };
      const sm = reply.match(/СЦЕНАРИЙ:([\s\S]+?)(?:ХУКИ:|ПЛАН СЪЁМКИ:|$)/);
      if (sm) {
        const versions = [...(reel.script_versions || []), sm[1].trim()];
        updates.script_versions = versions;
        updates.selected_script = versions.length - 1;
        scriptGenerated = true;
      }
      const hm = reply.match(/ХУКИ:([\s\S]+?)(?:ПЛАН СЪЁМКИ:|$)/);
      if (hm) {
        const lines = hm[1].split("\n").map(l => l.replace(/^[-•\d.]+\s*/, "")).filter(l => l.trim().length > 10);
        if (lines.length >= 2) updates.hooks = lines.slice(0, 3);
      }
      const pm = reply.match(/ПЛАН СЪЁМКИ:([\s\S]+)/);
      if (pm) updates.shoot_plan = pm[1].trim();
      onUpdate(updates);
    } catch (e) {
      onUpdate({ script_chat: [...newChat, { role: "assistant", content: "Ошибка: " + e.message }] });
    }
    setLoading(false);
    return scriptGenerated;
  };

  const generateFromIdea = async () => { await send(`Сгенерируй сценарий на тему: ${reel.topic}`); };

  const saveScriptEdit = () => {
    if (reel.selected_script < 0 || scriptDraft === reel.script_versions?.[reel.selected_script]) return;
    const versions = [...reel.script_versions];
    versions[reel.selected_script] = scriptDraft;
    onUpdate({ script_versions: versions });
  };

  const requestHooks = async () => {
    setHooksLoading(true);
    setHooksError("");
    const finalScript = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : "";
    const system = `Ты — Сценарист. Дай минимум 2 варианта хука (первая фраза ролика, 3 сек, до 12 слов) к финальному сценарию ниже. Ответь СТРОГО в формате: начни с ХУКИ:, каждый хук отдельной строкой, без другого текста до или после.\n\nСценарий:\n${finalScript}`;
    try {
      const reply = await callAPI([{ role: "user", content: "Дай варианты хука к финальному сценарию." }], system, 400);
      const hm = reply.match(/ХУКИ:([\s\S]+)/);
      const lines = hm ? hm[1].split("\n").map(l => l.replace(/^[-•\d.]+\s*/, "").trim()).filter(l => l.length > 10) : [];
      if (lines.length >= 2) {
        onUpdate({ hooks: lines.slice(0, 3), selected_hook: 0 });
      } else {
        setHooksError("Не удалось получить хуки. Можно перейти без них.");
      }
    } catch (e) {
      setHooksError(e.message || "Ошибка запроса");
    }
    setHooksLoading(false);
  };

  const hasHooks = (reel.hooks || []).length > 0;

  return (
    <div>
      {!(reel.script_versions || []).length && (
        <div style={{ marginBottom: 14 }}>
          {reel.agreed_angle && (
            <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>✓ Угол согласован с Идеологом</div>
              {reel.topic && <div><strong>Тема:</strong> {reel.topic}</div>}
              {reel.agreed_angle.angle && <div><strong>Угол:</strong> {reel.agreed_angle.angle}</div>}
              {reel.agreed_angle.rationale && <div><strong>Почему работает:</strong> {reel.agreed_angle.rationale}</div>}
              {reel.agreed_angle.hook && <div><strong>Хук:</strong> {reel.agreed_angle.hook}</div>}
            </div>
          )}
          <span style={s.label}>Идея (согласована на прошлом шаге — можно поправить)</span>
          <textarea style={{ ...s.field, minHeight: 60 }} rows={3} value={reel.topic || ""} onChange={e => onUpdate({ topic: e.target.value })} placeholder="Тема ролика..." />
          {isVideo && (
            <div style={{ marginTop: 8 }}>
              <span style={s.label}>Формат съёмки</span>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {[["talking_head", "🎤 Говорю на камеру"], ["voiceover", "🎙 Закадровый голос"], ["full_plan", "🎬 Нужен полный план"]].map(([key, label]) => (
                  <button key={key} onClick={() => onUpdate({ shoot_format: key })} style={{ padding: "6px 10px", borderRadius: 7, border: `1.5px solid ${reel.shoot_format === key ? COLORS.rose : COLORS.brd}`, background: reel.shoot_format === key ? COLORS.rose : COLORS.cream, color: reel.shoot_format === key ? "#fff" : COLORS.brownS, fontSize: 11, fontWeight: reel.shoot_format === key ? 600 : 400, cursor: "pointer" }}>{label}</button>
                ))}
              </div>
            </div>
          )}
          <button onClick={generateFromIdea} disabled={loading || !reel.topic?.trim() || (isVideo && !reel.shoot_format)} style={{ ...s.btnRose, width: "100%", marginTop: 8, opacity: (loading || !reel.topic?.trim() || (isVideo && !reel.shoot_format)) ? .5 : 1 }}>
            {loading ? "Генерирую..." : "✦ Сгенерировать сценарий"}
          </button>
        </div>
      )}
      {/* VERSIONS */}
      {(reel.script_versions || []).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <span style={s.label}>Версии сценария</span>
          {reel.script_versions.map((v, i) => (
            <div key={i} onClick={() => onUpdate({ selected_script: i })} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: i === reel.selected_script ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${i === reel.selected_script ? COLORS.rose : COLORS.brd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 4, cursor: "pointer" }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: i === reel.selected_script ? COLORS.rose : COLORS.brd, color: i === reel.selected_script ? "#fff" : COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
              <div style={{ fontSize: 11, color: COLORS.brown, lineHeight: 1.4, flex: 1 }}>{v.substring(0, 110)}{v.length > 110 ? "..." : ""}</div>
              {i === reel.selected_script && <div style={{ fontSize: 10, color: COLORS.green, fontWeight: 600, whiteSpace: "nowrap" }}>✓ Финальная</div>}
            </div>
          ))}
        </div>
      )}
      {(reel.script_versions || []).length > 0 && reel.selected_script >= 0 && (
        <div style={{ marginBottom: 10 }}>
          <span style={s.label}>Текст выбранной версии (можно править вручную)</span>
          <textarea value={scriptDraft} onChange={e => setScriptDraft(e.target.value)} onBlur={saveScriptEdit} style={{ ...s.field, minHeight: 140 }} rows={7} />
          <button onClick={saveScriptEdit} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 6 }}>Сохранить правки</button>
        </div>
      )}
      {reel.shoot_plan && (
        <div style={{ marginBottom: 10 }}>
          <span style={s.label}>🎬 План съёмки</span>
          <div style={{ fontSize: 11, color: COLORS.brown, lineHeight: 1.6, whiteSpace: "pre-wrap", background: COLORS.cream, borderRadius: 8, padding: 9, border: `1.5px solid ${COLORS.brd}` }}>{reel.shoot_plan}</div>
        </div>
      )}
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 8 }}>{(reel.script_versions || []).length ? "Правки и новые версии — прямо в чате. Каждая версия сохраняется." : "Отредактируй идею выше и нажми «Сгенерировать сценарий», или сразу опиши, что нужно, в чате."}</div>
      <div ref={chatRef} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
        {(reel.script_chat || []).map((m, i) => <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>)}
        {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Думаю...</div>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 7 }}>
        {["Напиши с нуля", "Короче", "3 варианта хука", "+ История", "Усиль триггер", "Живее"].map(q => (
          <button key={q} onClick={() => send(q)} style={{ background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: COLORS.brownS, cursor: "pointer" }}>{q}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Черновик или правки Сценаристу..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
        <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
      </div>
      {hasHooks && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 1, background: COLORS.brd, margin: "12px 0" }} />
          <span style={s.label}>Хуки (⭐ — финальный)</span>
          {reel.hooks.map((h, i) => (
            <div key={i} onClick={() => onUpdate({ selected_hook: i })} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: i === (reel.selected_hook || 0) ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${i === (reel.selected_hook || 0) ? COLORS.rose : COLORS.brd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 5, cursor: "pointer" }}>
              <span style={{ fontSize: 12, opacity: i === (reel.selected_hook || 0) ? 1 : .35 }}>⭐</span>
              <span style={{ fontSize: 12, color: COLORS.brown, lineHeight: 1.4, flex: 1 }}>{h}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 1, background: COLORS.brd, margin: "14px 0 10px" }} />
      {hooksError && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{hooksError}</div>
          <button onClick={onAdvance} style={{ ...s.btnOutline, ...s.btnSm }}>Перейти без хуков →</button>
        </div>
      )}
      {hasHooks ? (
        <button onClick={onAdvance} disabled={reel.selected_script < 0} style={{ ...s.btnRose, width: "100%", opacity: reel.selected_script >= 0 ? 1 : .4, cursor: reel.selected_script >= 0 ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          Дальше к Копирайтеру →
        </button>
      ) : (
        <button onClick={requestHooks} disabled={reel.selected_script < 0 || hooksLoading} style={{ ...s.btnRose, width: "100%", opacity: (reel.selected_script >= 0 && !hooksLoading) ? 1 : .4, cursor: (reel.selected_script >= 0 && !hooksLoading) ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          {hooksLoading ? "Подбираю хуки..." : "Сценарий согласован — показать хуки →"}
        </button>
      )}
    </div>
  );
}

// ── COPY STEP ──
function CopyStep({ reel, profile, onUpdate }) {
  const [loading, setLoading] = useState(false);

  const getCtx = () => {
    let ctx = "";
    if (profile.ca || profile.ca_files?.length) ctx += `=== ЦА ===\n${smartTruncate(fieldContext(profile, "ca"), 2000)}\n\n`;
    if (profile.prod || profile.prod_files?.length) ctx += `=== ПРОДУКТЫ ===\n${smartTruncate(fieldContext(profile, "prod"), 2000)}\n\n`;
    if (profile.tov || profile.tov_files?.length) ctx += `=== TOV ===\n${smartTruncate(fieldContext(profile, "tov"), 1200)}\n\n`;
    ctx += buildMaterialsCtx(profile.materials, "copy");
    const scriptSummary = (reel.script_chat || []).slice(-2).map(m => `${m.role === "user" ? "Пользователь" : "Сценарист"}: ${m.content}`).join("\n").substring(0, 400);
    if (scriptSummary) ctx += `=== ОБСУЖДЕНИЕ ПРИ ПРАВКЕ СЦЕНАРИЯ (детали, которых нет в финальном тексте) ===\n${scriptSummary}\n\n`;
    return ctx;
  };

  const getLead = () => reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : profile.leads?.find(l => {
    const h = String(reel.hunt_stage);
    if (l.hunt === "all") return true;
    if (l.hunt === "1-2" && (h === "1" || h === "2")) return true;
    if (l.hunt === "3" && h === "3") return true;
    if (l.hunt === "4-5" && (h === "4" || h === "5")) return true;
    return false;
  }) || profile.leads?.[0];

  const script = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : reel.topic;
  const sourceIsVideo = VIDEO_FORMATS.includes(reel.format);
  const isVideoAdjacentPlat = (key) => key === "tt" || key === "yt" || (key === "ig" && reel.format === "Reels");
  const needsFullScript = (key) => isVideoAdjacentPlat(key) && !sourceIsVideo;
  const bonusStructureInstr = (key) => isVideoAdjacentPlat(key)
    ? `Описание физически отдельно от видео — не пересказывай видео. Структура: 1) короткая зацепка, обещающая доп. пользу (например "сохрани", "вот 5 способов") 2) самостоятельная бонусная польза — конкретный список/чек-лист/лайфхак, которого НЕТ в самом видео 3) CTA по ступени Ханта: 1-2 — просто польза + "сохрани", без давления; 3 — интерес к методу; 4-5 — бонус ведёт к лид-магниту/офферу.`
    : `Структура: 1. Описание о чём ролик 2. Полезность 3. Лид-магнит + CTA.`;
  const fullScriptInstr = `Исходный контент не был видео-форматом — помимо описания напиши ПОЛНЫЙ сценарий для видео (поле script): хук (3 сек, до 12 слов: шок-факт/цифра/незаконченная мысль/вопрос в боль) → было плохо (конкретная деталь) → перелом → стало так (результат) → CTA по ступени Ханта. Длина 30-60 сек речи.`;
  const baseFmts = { ig: '{"caption":"...","cta":"..."}', yt: '{"title":"...","description":"...","tags":["..."]}', tg: '{"caption":"..."}', tt: '{"overlay":"...","caption":"..."}', th: '{"text":"...","link_comment":"..."}', vk: '{"caption":"..."}' };
  const scriptFmts = { tt: '{"script":"...","overlay":"...","caption":"..."}', yt: '{"script":"...","title":"...","description":"...","tags":["..."]}' };

  const genMain = async () => {
    setLoading(true);
    const lead = getLead();
    const key = reel.platform;
    const platInstr = (profile.platInstr || DEFAULT_PLAT_INSTR)[key] || DEFAULT_PLAT_INSTR[key] || "";
    const fullScript = needsFullScript(key);
    const system = `Ты — Копирайтер. TOV: ${smartTruncate(fieldContext(profile, "tov"), 250)}. Инструкция площадки ${PLATFORMS[key]?.name}: ${platInstr}.\n${getCtx()}\n${reel.hunt_stage ? `Ступень Ханта: ${reel.hunt_stage} — тон CTA: 1-2 мягкий (сохранить/подписаться), 3 интерес к методу, 4-5 прямой оффер с конкретикой.` : ""}\n${key === "tt" ? "overlay — короткий текст НА видео (6-8 слов), caption — развёрнутый текст под видео." : ""}${key === "th" ? "Ссылку клади в link_comment, не в text — так принято в Threads." : ""}\n${bonusStructureInstr(key)}${fullScript ? `\n${fullScriptInstr}` : ""}\nПолезность пиши конкретно, без слов "полезно"/"качественный"/"уникальный" без опоры на факт. CTA — до 15 слов, без давления, на основе реальной пользы лид-магнита. Без канцеляризмов и конструкций "не X, а Y".\nОтвечай JSON без текста.`;
    const fmt = fullScript ? (scriptFmts[key] || baseFmts[key]) : baseFmts[key];
    try {
      const raw = await callAPI([{ role: "user", content: `Напиши описание для ${PLATFORMS[key]?.name}.\n\nСценарий: ${script}\nЗаметки: ${reel.notes || "нет"}\n${lead ? `Лид-магнит: ${lead.name} · ${lead.link}` : ""}\n\nJSON: ${fmt}` }], system, fullScript ? 1800 : 1000);
      const parsed = parseJSON(raw);
      onUpdate({ copy: { ...(reel.copy || {}), [key]: parsed } });
    } catch (e) { alert("Ошибка: " + e.message); }
    setLoading(false);
  };

  const adaptAll = async () => {
    setLoading(true);
    const lead = getLead();
    const instrBlock = Object.entries(profile.platInstr || DEFAULT_PLAT_INSTR).map(([k, v]) => `${PLATFORMS[k]?.name}: ${v.substring(0, 120)}`).join("\n\n");
    const system = `Ты — Копирайтер. TOV: ${smartTruncate(fieldContext(profile, "tov"), 250)}.\n${getCtx()}\nИнструкции:\n${instrBlock}.\n${reel.hunt_stage ? `Ступень Ханта: ${reel.hunt_stage} — тон CTA: 1-2 мягкий, 3 интерес к методу, 4-5 прямой оффер.` : ""}\nДля TikTok (tt): overlay — короткий текст НА видео (6-8 слов), caption — текст под видео. Для Threads (th): ссылку клади в link_comment, не в text.\nДля площадок, где описание физически отдельно от видео (tt, yt, а также ig если формат ролика — Reels) — не пересказывай видео в описании: 1) короткая зацепка, обещающая доп. пользу 2) самостоятельная бонусная польза — список/чек-лист/лайфхак, которого нет в видео 3) CTA по ступени Ханта (1-2 мягко+сохрани, 3 интерес к методу, 4-5 бонус ведёт к офферу). Для остальных площадок (tg, th, vk, ig не-Reels) — структура описание/полезность/лид-магнит+CTA не меняется.\n${!sourceIsVideo ? fullScriptInstr + " Это касается только tt и yt." : ""}\nПолезность — конкретно, без общих слов без опоры на факт. CTA — до 15 слов, без давления. Без канцеляризмов и штампов "и вот почему"/"но есть нюанс".\nОтвечай JSON.`;
    const jsonShape = sourceIsVideo
      ? `{"ig":{"caption":"...","cta":"..."},"yt":{"title":"...","description":"...","tags":["..."]},"tg":{"caption":"..."},"tt":{"overlay":"...","caption":"..."},"th":{"text":"...","link_comment":"..."},"vk":{"caption":"..."}}`
      : `{"ig":{"caption":"...","cta":"..."},"yt":{"script":"...","title":"...","description":"...","tags":["..."]},"tg":{"caption":"..."},"tt":{"script":"...","overlay":"...","caption":"..."},"th":{"text":"...","link_comment":"..."},"vk":{"caption":"..."}}`;
    try {
      const raw = await callAPI([{ role: "user", content: `Адаптируй под все площадки.\nСценарий: ${script}\nЗаметки: ${reel.notes || "нет"}\n${lead ? `Лид-магнит: ${lead.name} · ${lead.link}` : ""}\n\nJSON:\n${jsonShape}` }], system, sourceIsVideo ? 3000 : 4000);
      const parsed = parseJSON(raw);
      onUpdate({ copy: { ...(reel.copy || {}), ...parsed } });
    } catch (e) { alert("Ошибка: " + e.message); }
    setLoading(false);
  };

  const regenPlat = async (key) => {
    setLoading(true);
    const lead = getLead();
    const platInstr = (profile.platInstr || DEFAULT_PLAT_INSTR)[key] || DEFAULT_PLAT_INSTR[key] || "";
    const fullScript = needsFullScript(key);
    const system = `Ты — Копирайтер для ${PLATFORMS[key]?.name}. TOV: ${smartTruncate(fieldContext(profile, "tov"), 200)}. Инструкция: ${platInstr}.\n${getCtx()}\n${reel.hunt_stage ? `Ступень Ханта: ${reel.hunt_stage} — тон CTA: 1-2 мягкий, 3 интерес к методу, 4-5 прямой оффер.` : ""}\n${key === "tt" ? "overlay — короткий текст НА видео (6-8 слов), caption — текст под видео." : ""}${key === "th" ? "Ссылку клади в link_comment, не в text." : ""}\n${bonusStructureInstr(key)}${fullScript ? `\n${fullScriptInstr}` : ""}\nКонкретная польза, CTA до 15 слов без давления, без канцеляризмов.\nОтвечай JSON.`;
    const fmt = fullScript ? (scriptFmts[key] || baseFmts[key]) : baseFmts[key];
    try {
      const raw = await callAPI([{ role: "user", content: `Текст для ${PLATFORMS[key]?.name}.\nСценарий: ${script}\n${lead ? `Лид-магнит: ${lead.name} · ${lead.link}` : ""}\n\nJSON: ${fmt}` }], system, fullScript ? 1600 : 900);
      const parsed = parseJSON(raw);
      onUpdate({ copy: { ...(reel.copy || {}), [key]: parsed } });
    } catch (e) { alert("Ошибка: " + e.message); }
    setLoading(false);
  };

  const copyToClipboard = (key) => {
    const d = reel.copy?.[key];
    if (!d) return;
    const texts = { ig: `${d.caption || ""}\n\n${d.cta || ""}`, yt: `${d.script ? d.script + "\n\n" : ""}${d.title || ""}\n\n${d.description || ""}\n\n${(d.tags || []).join(" ")}`, tg: d.caption || "", tt: `${d.script ? d.script + "\n\n" : ""}${d.overlay || ""}\n\n${d.caption || ""}`, th: `${d.text || ""}\n\n${d.link_comment || ""}`, vk: d.caption || "" };
    navigator.clipboard.writeText(texts[key] || "").catch(() => {});
  };

  const renderPlatData = (key, d) => {
    if (!d) return <div style={{ fontSize: 10, color: COLORS.brownS, padding: "6px 0", textAlign: "center", opacity: .6 }}>Нажми «Написать тексты»</div>;
    const field = (label, val) => val ? <div key={label}><div style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: COLORS.brownS, marginBottom: 3, marginTop: 7 }}>{label}</div><div style={{ fontSize: 11, color: COLORS.brown, lineHeight: 1.6, whiteSpace: "pre-wrap", background: COLORS.cream, borderRadius: 6, padding: 7, border: `1.5px solid ${COLORS.brd}` }}>{val}</div></div> : null;
    if (key === "ig") return <>{field("Описание", d.caption)}{field("CTA", d.cta)}</>;
    if (key === "yt") return <>{field("Сценарий", d.script)}{field("Заголовок", d.title)}{field("Описание", d.description)}{d.tags?.length ? <div><div style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", color: COLORS.brownS, marginTop: 7, marginBottom: 3 }}>Теги</div><div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{d.tags.map((t, i) => <span key={i} style={{ background: COLORS.roseP, color: COLORS.rose, borderRadius: 20, padding: "2px 6px", fontSize: 9 }}>{t}</span>)}</div></div> : null}</>;
    if (key === "tg") return field("Пост", d.caption);
    if (key === "tt") return <>{field("Сценарий", d.script)}{field("Текст на видео", d.overlay)}{field("Описание", d.caption)}</>;
    if (key === "th") return <>{field("Пост", d.text)}{field("Комментарий", d.link_comment)}</>;
    if (key === "vk") return field("Пост", d.caption);
    return null;
  };

  const ordered = [reel.platform, ...Object.keys(PLATFORMS).filter(k => k !== reel.platform)];

  return (
    <div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 10 }}>Копирайтер напишет по структуре: описание / полезность / лид-магнит + CTA</div>
      {loading && <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>}
      <div style={{ marginBottom: 10, display: "flex", gap: 7, flexWrap: "wrap" }}>
        <button style={{ ...s.btnRose, ...s.btnSm }} onClick={genMain} disabled={loading}>✦ Написать тексты</button>
        <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={adaptAll} disabled={loading}>⇄ Все площадки</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {ordered.map(key => (
          <div key={key} style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 10, padding: 11 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: COLORS.brown, display: "flex", alignItems: "center", gap: 4 }}>
                {PLATFORMS[key]?.icon} {PLATFORMS[key]?.name}
                {key === reel.platform && <Badge bg={COLORS.roseL} color={COLORS.rose}>основная</Badge>}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => copyToClipboard(key)} style={{ ...s.btnOutline, padding: "2px 7px", fontSize: 10, borderRadius: 6 }}>⎘</button>
                <button onClick={() => regenPlat(key)} style={{ ...s.btnOutline, padding: "2px 7px", fontSize: 10, borderRadius: 6 }}>↺</button>
              </div>
            </div>
            {renderPlatData(key, reel.copy?.[key])}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── NOTES STEP ──
function NotesStep({ reel, onUpdate, onDeleteRequest }) {
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <span style={s.label}>Заметки со съёмки и монтажа</span>
        <textarea style={{ ...s.field, minHeight: 70 }} rows={3} value={reel.notes || ""} onChange={e => onUpdate({ notes: e.target.value })} placeholder="Что изменилось при съёмке — агент учтёт это в текстах..." />
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={s.label}>📅 Дата публикации</span>
        <input type="date" style={{ ...s.field, maxWidth: 180 }} value={reel.publish_date || ""} onChange={e => onUpdate({ publish_date: e.target.value || null })} />
      </div>
      <div style={{ background: COLORS.blueL, border: `1.5px solid #BFDBFE`, borderRadius: 9, padding: "10px 11px" }}>
        <div style={{ fontWeight: 700, fontSize: 11, color: COLORS.blue, marginBottom: 5 }}>💬 Реакции аудитории</div>
        <div style={{ fontSize: 10, color: COLORS.blue, marginBottom: 5 }}>Комментарии, вопросы — идут в следующий цикл</div>
        <textarea style={{ ...s.field, minHeight: 50, background: "#fff" }} rows={2} value={reel.reactions || ""} onChange={e => onUpdate({ reactions: e.target.value })} placeholder="Что писали в комментариях?..." />
      </div>
      <div style={{ height: 1, background: COLORS.brd, margin: "12px 0" }} />
      <button onClick={onDeleteRequest} style={{ ...s.btnOutline, fontSize: 11, color: "#DC2626", borderColor: "#FECACA" }}>Удалить ролик</button>
    </div>
  );
}
