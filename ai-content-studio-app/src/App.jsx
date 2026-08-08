import { useState, useEffect, useRef, useCallback } from "react";
import mammoth from "mammoth";
import { readSheet } from "read-excel-file/web-worker";
import { createContextPacket, renderContextPacket } from "./ai/contextBuilder.js";
import { buildCoreInstructions as ideologistCore } from "./ai/prompts/ideologist.js";
import { buildCoreInstructions as trendResearcherCore } from "./ai/prompts/trendResearcher.js";
import { buildCoreInstructions as scriptwriterCore } from "./ai/prompts/scriptwriter.js";
import { buildCoreInstructions as carouselCore } from "./ai/prompts/carousel.js";
import { buildCoreInstructions as copywriterCore, buildAllPlatformsCoreInstructions as copywriterAllPlatformsCore, needsFullScript as copyNeedsFullScript } from "./ai/prompts/copywriter.js";
import { buildPlanCoreInstructions as miaPlanCore, buildRegenItemCoreInstructions as miaRegenItemCore, buildIdeaCoreInstructions as miaIdeaCore, buildFormatIdeaCoreInstructions as miaFormatIdeaCore } from "./ai/prompts/mia.js";
import { buildCoreInstructions as competitorAnalysisCore } from "./ai/prompts/competitorAnalysis.js";
import { buildCoreInstructions as leoCore } from "./ai/prompts/leo.js";

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
function csvEscapeCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  if (ext === "xlsx" || ext === "xls") {
    // Serialize the first sheet to CSV text rather than mapping columns
    // ourselves — the same LLM-driven plan parser (buildPlanParserSystem)
    // already turns arbitrary tabular/free text into the plan JSON shape,
    // so there's no need for a second, format-specific mapping path.
    const rows = await readSheet(file);
    return { text: rows.map(row => row.map(csvEscapeCell).join(",")).join("\n"), fileType: "xlsx" };
  }
  if (ext === "csv") {
    return { text: await file.text(), fileType: "csv" };
  }
  return { text: await file.text(), fileType: ext === "md" ? "md" : "txt" };
}
const FILE_ACCEPT = ".txt,.md,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PLAN_FILE_ACCEPT = FILE_ACCEPT + ",.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,application/vnd.ms-excel";

// ── API ──
function getClientId() {
  let id = localStorage.getItem("acs3-client-id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + Date.now().toString(36);
    localStorage.setItem("acs3-client-id", id);
  }
  return id;
}
async function callAPI(messages, system, maxTokens = 1000, enableWebSearch = false, agentType = "unknown") {
  const headers = { "Content-Type": "application/json", "X-Client-Id": getClientId() };
  const paidToken = localStorage.getItem("acs3-paid-token");
  if (paidToken) headers["Authorization"] = "Bearer " + paidToken;
  const userKey = localStorage.getItem("acs3-key");
  if (userKey && userKey.startsWith("sk-or-")) headers["X-User-Api-Key"] = userKey;
  const r = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({ system, messages, maxTokens, enableWebSearch, agentType }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "API ошибка");
  return d.text || "";
}
async function scrapeCompetitor(platform, handle) {
  const r = await fetch("/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, handle }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Ошибка запроса");
  return d.posts || [];
}
// Models sometimes wrap JSON in ```json fences despite being told not to —
// strip those before any parse attempt rather than letting them break it.
function stripCodeFence(raw) {
  return raw.replace(/```json\s*|```/g, "").trim();
}
function parseJSON(raw) {
  const cleaned = stripCodeFence(raw);
  try { return JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Не удалось разобрать ответ");
  }
}
// If the response got cut off mid-array (hit the token limit), salvage the
// complete objects that did make it through instead of losing the whole
// array over one dangling fragment at the end.
function recoverTruncatedArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;
  const body = text.slice(start + 1);
  const lastCompleteIdx = body.lastIndexOf("},");
  const cutoff = lastCompleteIdx !== -1 ? lastCompleteIdx + 1 : body.lastIndexOf("}") + 1;
  if (cutoff <= 0) return null;
  try {
    const v = JSON.parse("[" + body.slice(0, cutoff) + "]");
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}
function parseJSONArray(raw) {
  const cleaned = stripCodeFence(raw);
  try { const v = JSON.parse(cleaned); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  }
  const recovered = recoverTruncatedArray(cleaned);
  if (recovered) return recovered;
  throw new Error("Не удалось разобрать ответ агента");
}
// The Идеолог→Сценарист handoff block is small enough that models
// occasionally "helpfully" reformat it — markdown bold, bullet dashes,
// sentence-case labels, or drop the ###КАРТОЧКА_START###/END### markers
// entirely while still writing recognizable УГОЛ/ОБОСНОВАНИЕ/ХУК lines.
// Strip the common drift before giving up on it.
function extractAngleBlock(reply) {
  const stripped = reply.replace(/\*\*/g, "").replace(/^[-•]\s*/gm, "");
  const m = stripped.match(/###КАРТОЧКА_START###([\s\S]+?)###КАРТОЧКА_END###/i);
  if (m) return m[1].trim();
  if (/угол\s*:/i.test(stripped) && /хук\s*:/i.test(stripped)) return stripped.trim();
  return null;
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

const EMPTY_PROFILE_FIELDS = { ca: "", prod: "", tov: "", memory: "", ca_files: [], prod_files: [], tov_files: [], memory_files: [], leads: [], materials: [], platInstr: { ...DEFAULT_PLAT_INSTR }, huntStage: null, profileType: "manual", contentPlan: null, competitors: [], competitorsLastFetched: null, newsResults: [], newsInstruction: "", ideaChat: [], ideaDraftTopic: null, competitorsWarnings: [], competitorsTopics: [], competitorsBreakdown: "" };
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
    strategy_card: null,
    script_strategy_card: null,
    plan_anchor: null, plan_day: null,
    reveal_text: "", reveal_chat: [], selected_platforms: [],
  };
}

// ── MAIN APP ──
export default function App() {
  const [tab, setTab] = useState("team");
  const [reels, setReels] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [onboarding, setOnboarding] = useState(null); // null | "choice" | "interview"
  const [showNicheMenu, setShowNicheMenu] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [cardId, setCardId] = useState(null);
  const [showNewCard, setShowNewCard] = useState(false);
  const [quickStart, setQuickStart] = useState(null); // null | "leo" | "kira" | "asya" | "tim"
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

  // Team screen "quick start" — creates a card that skips straight to the
  // clicked agent. Кира needs a video format and Ася needs Карусель so
  // CardModal's existing video/Карусель routing (see its lazy `step` init)
  // lands on the right screen; Тим gets a non-video, non-carousel format so
  // that same routing skips straight past Кира/Ася to CopyStep, matching
  // how LeoStep.submit already routes a finished draft.
  const handleQuickStart = useCallback((text) => {
    const formatByAgent = { leo: "Reels", kira: "Reels", asya: "Карусель", tim: "Пост" };
    const reel = {
      ...makeReel({ platform: "ig", format: formatByAgent[quickStart] || "Reels", hunt: 0, topic: quickStart === "leo" ? text : "" }),
      profileId: activeProfileId,
    };
    if (quickStart !== "leo") reel.reveal_text = text; // Кира/Ася/Тим начинают сразу с этого текста, без Лео
    setReels(prev => { const u = [reel, ...prev]; saveReels(u); return u; });
    setCardId(reel.id);
    setQuickStart(null);
  }, [quickStart, activeProfileId, saveReels]);

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
          {["team", "profile", "board"].map((t, i) => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "inherit", background: tab === t ? COLORS.rose : "none", color: tab === t ? "#fff" : COLORS.brownS }}>
              {{ board: "◫ Доска", team: "🤖 Команда", profile: "⚙ Профиль" }[t]}
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

      {/* MIA (marketer — plan/news/idea/competitors) */}
      {tab === "plan" && (
        <MiaScreen
          key={profile.id}
          profile={profile}
          onUpdateProfile={(p) => updateActiveProfile(p)}
          onWritePost={(item) => {
            const p = PLATFORMS[item.platform] || PLATFORMS.ig;
            const reel = { ...makeReel({ platform: item.platform, format: p.formats[0], hunt: item.stage, topic: item.topic }), profileId: activeProfileId, plan_anchor: item.anchor || null, plan_day: item.day ?? null };
            setReels(prev => { const u = [reel, ...prev]; saveReels(u); return u; });
            setCardId(reel.id);
          }}
        />
      )}

      {/* TEAM */}
      {tab === "team" && <TeamScreen profile={profile} setTab={setTab} onQuickStart={setQuickStart} />}
      {quickStart && <QuickStartModal agent={quickStart} onClose={() => setQuickStart(null)} onCreate={handleQuickStart} />}

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
              onUpdateProfile={(changes) => updateActiveProfile(changes)}
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

// ── TEAM SCREEN ──
// Informational showcase only — the agent pipeline (IdeaStep/ScriptStep/
// CarouselStep/CopyStep) is untouched and unrelated to this screen except
// for Мия's click-through to the plan tab, which already exists.
//
// Each agent is a robot + comic-style "thinking" dots + a speech-bubble —
// two separate visual elements side by side, deliberately NOT wrapped in a
// shared card/border (that was the first, rejected version of this screen).
const TEAM_COLORS = {
  mia: { size: 90, dotSmall: 8, dotBig: 13, bg: "#FBEAF0", border: "#F4C0D1" },
  lev: { size: 70, dotSmall: 6, dotBig: 10, bg: "#FAEEDA", border: "#FAC775" },
  kira: { size: 70, dotSmall: 6, dotBig: 10, bg: "#EEEDFE", border: "#CECBF6" },
  asya: { size: 70, dotSmall: 6, dotBig: 10, bg: "#E1F5EE", border: "#9FE1CB" },
  tim: { size: 70, dotSmall: 6, dotBig: 10, bg: "#FAECE7", border: "#F5C4B3" },
  operator: { size: 56, dotSmall: 5, dotBig: 8, bg: "#F0EEEC", border: "#D6D0CB" },
  montazher: { size: 56, dotSmall: 5, dotBig: 8, bg: "#F0EEEC", border: "#D6D0CB" },
};

function AgentThought({ img, name, role, desc, soon, dim, bubbleMaxWidth = 340, onClick }) {
  const c = TEAM_COLORS[img];
  const dot = (size, extraStyle) => ({ width: size, height: size, borderRadius: "50%", background: c.bg, border: `1px solid ${c.border}`, ...extraStyle });
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, opacity: dim ? 0.55 : 1, cursor: onClick ? "pointer" : "default" }}>
      <img src={`/agents/${img}.png`} alt={name} style={{ width: c.size, height: c.size, objectFit: "contain", animation: "bot-bob 2.6s ease-in-out infinite", flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
        <div style={dot(c.dotSmall, { marginLeft: 4 })} />
        <div style={dot(c.dotBig)} />
      </div>
      <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 20, padding: "0.85rem 1.1rem", maxWidth: bubbleMaxWidth }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>
          {name}{role ? ` — ${role}` : ""}
          {soon && <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.brownS, marginLeft: 6 }}>скоро</span>}
        </div>
        {desc && <div style={{ fontSize: 12, color: COLORS.brownS, marginTop: 3, lineHeight: 1.5 }}>{desc}</div>}
      </div>
    </div>
  );
}

function TeamScreen({ profile, setTab, onQuickStart }) {
  const nextStep = [
    { img: "kira", name: "Кира", role: "сценарист", desc: "Превращает текст Лео в сценарий для видео: хук, план съёмки, о чём говорить." },
    { img: "asya", name: "Ася", role: "карусели", desc: "Раскладывает текст Лео по слайдам карусели для Instagram." },
    { img: "tim", name: "Тим", role: "тексты", desc: "Пишет финальный текст под каждую площадку: подпись к видео, пост в Telegram и так далее." },
  ];
  const comingSoon = [
    { img: "operator", name: "Оператор", role: "съёмка" },
    { img: "montazher", name: "Монтажёр", role: "монтаж" },
  ];
  const profileIncomplete = (!profile.ca && !profile.ca_files?.length) || (!profile.prod && !profile.prod_files?.length) || (!profile.tov && !profile.tov_files?.length);
  return (
    <div style={{ ...s.panel, display: "flex", flexDirection: "column", gap: 20 }}>
      {profileIncomplete && (
        <div style={{ background: COLORS.amberL, border: `1.5px solid #FCD34D`, borderRadius: 9, padding: "9px 12px", fontSize: 11, color: COLORS.amber, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          ⚠ Заполни профиль — агенты будут работать точнее.
          <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={() => setTab("profile")}>Перейти →</span>
        </div>
      )}
      {profileIncomplete && (
        <div style={{ fontSize: 12, color: COLORS.brownS, lineHeight: 1.5 }}>Ваша команда для создания контента. Начните с Мии — она соберёт план тем на основе вашей ниши.</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
        <AgentThought img="mia" name="Мия" role="маркетолог" desc="Знает вашу аудиторию, продукты и конкурентов. Составляет план на месяц и объясняет, почему выбрала именно эти темы." bubbleMaxWidth={280} onClick={() => setTab("plan")} />
        <AgentThought img="lev" name="Лео" role="копирайтер" desc="Берёт тему от Мии и пишет полноценный текст вашим голосом. Ещё не привязан к конкретной площадке — это следующий шаг." bubbleMaxWidth={260} onClick={() => onQuickStart("leo")} />
      </div>

      <div>
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 10 }}>Дальше — по площадке</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
          {nextStep.map(a => <AgentThought key={a.img} {...a} bubbleMaxWidth={220} onClick={() => onQuickStart(a.img)} />)}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 10 }}>Скоро</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
          {comingSoon.map(a => <AgentThought key={a.img} {...a} bubbleMaxWidth={200} dim />)}
        </div>
      </div>
    </div>
  );
}

// ── QUICK START MODAL — direct entry into an agent from the Team screen,
// bypassing the steps that would normally feed it a topic/text ──
function QuickStartModal({ agent, onClose, onCreate }) {
  const [value, setValue] = useState("");
  const isLeo = agent === "leo";
  const agentName = { leo: "Лео", kira: "Кире", asya: "Асе", tim: "Тиму" }[agent] || "";

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...s.modal, maxWidth: 440 }}>
        <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 12, color: COLORS.brownS, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>{isLeo ? "Какая тема?" : "О чём текст?"}</div>
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 12 }}>Быстрый старт сразу к {agentName} — минуя предыдущие шаги.</div>
        {isLeo ? (
          <input value={value} onChange={e => setValue(e.target.value)} placeholder="Тема ролика..." style={{ ...s.field, marginBottom: 12 }} />
        ) : (
          <textarea value={value} onChange={e => setValue(e.target.value)} placeholder="Вставь готовый текст или просто опиши мысль..." rows={6} style={{ ...s.field, minHeight: 120, marginBottom: 12 }} />
        )}
        <button onClick={() => value.trim() && onCreate(value.trim())} disabled={!value.trim()} style={{ ...s.btnRose, width: "100%", opacity: value.trim() ? 1 : .5 }}>Начать →</button>
      </div>
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

  const keyOk = apiKey.startsWith("sk-or-");

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
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.brownS, whiteSpace: "nowrap" }}>🔑 API-ключ (OpenRouter)</span>
        <input type="password" value={apiKey} onChange={e => saveKey(e.target.value)} placeholder="sk-or-v1-..." style={{ ...s.field, flex: 1, minWidth: 160 }} />
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: keyOk ? COLORS.greenL : COLORS.cream, color: keyOk ? COLORS.green : COLORS.brownS, border: `1.5px solid ${keyOk ? "#A7D7B8" : COLORS.brd}`, whiteSpace: "nowrap" }}>
          {apiKey.length === 0 ? "Не введён" : keyOk ? "✓ Свой ключ — генерации не расходуют пробный лимит" : "⚠ Формат?"}
        </span>
        <span style={{ fontSize: 10, color: COLORS.brownS }}>openrouter.ai/keys</span>
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
    const { text } = await parseFile(file);
    setText(text);
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
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 12 }}>Вставь текст плана или загрузи файл (.txt, .md, .docx, .xlsx, .csv) — формат любой: список дат и тем, таблица, просто перечисление.</div>
        <div style={{ marginBottom: 10 }}>
          <input type="file" accept={PLAN_FILE_ACCEPT} onChange={handleFile} style={{ fontSize: 11 }} />
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

// Shared profile-field extraction for every Мия call — kept in one place
// so ЦА/Продукты/TOV/Память are pulled the same way across План/regen/
// revise-chat/Идея.
function buildMiaProfileFields(profile) {
  return {
    name: profile.name,
    audience: fieldContext(profile, "ca"),
    products: fieldContext(profile, "prod"),
    toneOfVoice: fieldContext(profile, "tov"),
    manualMemory: fieldContext(profile, "memory"),
    learnedMemory: profile.learnedMemory || [],
  };
}

// Мия's plan prompt needs to know whether it can expect direct quotes from a
// real workshop document, or just a handful of interview-brief sentences —
// profileType alone doesn't say that ("Заполню сам" profiles range from two
// typed sentences to a fully uploaded document), so weigh actual content
// depth too instead of promising the model citations that may not exist.
function computeProfileTypeLabel(profile) {
  if (profile.profileType === "interview") return "ИНТЕРВЬЮ";
  const textLen = ["ca", "prod", "tov"].reduce((sum, f) => sum + (profile[f]?.length || 0), 0);
  const filesLen = ["ca_files", "prod_files", "tov_files"].reduce(
    (sum, f) => sum + (profile[f] || []).reduce((s, doc) => s + (doc.text?.length || 0), 0), 0
  );
  return (textLen + filesLen) >= 500 ? "ДОКУМЕНТ_ВОРКШОПА" : "ИНТЕРВЬЮ";
}

// Normalizes raw model rows (or an uploaded plan) into the plan's item
// shape, snapping any platform the model invented back onto one of the
// actually-selected platforms. Shared by generation and chat-driven
// whole-plan revision so both stay consistent.
function mapPlanRows(rows, selectedPlatforms) {
  const nameToKey = Object.fromEntries(Object.entries(PLATFORMS).map(([key, p]) => [p.name, key]));
  return rows.slice(0, 30).map((it, i) => {
    const mapped = nameToKey[it.platform];
    const platform = (mapped && selectedPlatforms.includes(mapped)) ? mapped : selectedPlatforms[i % selectedPlatforms.length];
    return {
      day: Number(it.day) || i + 1,
      platform,
      topic: it.topic || "",
      stage: Math.min(5, Math.max(1, Number(it.stage) || 1)),
      anchor: it["опора"] || it.opora || it.anchor || "",
    };
  });
}

function MiaPlanTab({ profile, onUpdateProfile, onWritePost }) {
  const plan = profile.contentPlan;
  const [selectedPlatforms, setSelectedPlatforms] = useState(plan?.platforms || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rawReply, setRawReply] = useState("");
  const [showConfirmRegen, setShowConfirmRegen] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [regenIndex, setRegenIndex] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatRef = useRef(null);
  // Old profiles were generated before contentPlan.chat existed.
  const chat = plan?.chat || [];

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [chat]);

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
    onUpdateProfile({ contentPlan: { platforms, items, chat: [], generatedAt: new Date().toISOString(), source: "upload" } });
    setShowUpload(false);
  };

  const generate = async () => {
    if (selectedPlatforms.length === 0) return;
    setLoading(true);
    setError("");
    setRawReply("");
    const typeLabel = computeProfileTypeLabel(profile);
    const platformNames = selectedPlatforms.map(k => PLATFORMS[k].name).join(", ");
    // Materials tagged for the Идеолог (use.idea) are reused here as a
    // temporary stand-in for "materials Мия should see" — the ТЗ named
    // this key "use.ideologist", but that key doesn't exist anywhere in
    // the materials data model (only idea/script/copy do); using a
    // nonexistent key would just silently return zero materials, which
    // defeats the ТЗ's own stated intent of reusing what's already
    // flagged for ideation. Per-agent material tagging is its own future
    // ТЗ — this is only a placeholder until then.
    const packet = createContextPacket({ agent: "mia", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = miaPlanCore({ typeLabel, platformNames });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
    let raw = "";
    try {
      raw = await callAPI([{ role: "user", content: "Сформируй план на 30 дней. Ответь только JSON-массивом, без текста и markdown." }], system, 10000, false, "mia");
      if (!raw) throw new Error("Агент вернул пустой ответ. Попробуй ещё раз.");
      const items = mapPlanRows(parseJSONArray(raw), selectedPlatforms);
      onUpdateProfile({ contentPlan: { platforms: selectedPlatforms, items, chat: [], generatedAt: new Date().toISOString() } });
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

  const regenPlanItem = async (i) => {
    setRegenIndex(i);
    const item = plan.items[i];
    const typeLabel = computeProfileTypeLabel(profile);
    const platformName = PLATFORMS[item.platform]?.name || item.platform;
    const existingTopics = plan.items.filter((_, idx) => idx !== i).map(it => it.topic).filter(Boolean);
    const packet = createContextPacket({ agent: "mia", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = miaRegenItemCore({ typeLabel, platformName, stage: item.stage, existingTopics });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
    try {
      const raw = await callAPI([{ role: "user", content: "Предложи новую тему взамен текущей." }], system, 500, false, "mia");
      if (!raw) throw new Error("Агент вернул пустой ответ.");
      const parsed = parseJSON(raw);
      updatePlanItem(i, { topic: parsed.topic || item.topic, anchor: parsed["опора"] || parsed.opora || parsed.anchor || item.anchor });
    } catch (e) {
      alert("Ошибка: " + (e.message || "не удалось перегенерировать тему"));
    }
    setRegenIndex(null);
  };

  const sendRevision = async (msg) => {
    if (!msg.trim() || !plan) return;
    setChatInput("");
    setChatLoading(true);
    const typeLabel = computeProfileTypeLabel(profile);
    const platforms = plan.platforms?.length ? plan.platforms : selectedPlatforms;
    const platformNames = platforms.map(k => PLATFORMS[k]?.name).filter(Boolean).join(", ");
    const packet = createContextPacket({ agent: "mia", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = miaPlanCore({ typeLabel, platformNames });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
    const planSummary = plan.items.map((it, i) => `${i + 1}. День ${it.day} · ${PLATFORMS[it.platform]?.name || it.platform} · Ступень ${it.stage}: ${it.topic}`).join("\n");
    const newChat = [...chat, { role: "user", content: msg }];
    onUpdateProfile({ contentPlan: { ...plan, chat: newChat } });
    try {
      const raw = await callAPI([{ role: "user", content: `Текущий план:\n${planSummary}\n\nПравка от пользователя: ${msg}\n\nПересобери план целиком с учётом этой правки — не меняй темы, которых правка не касается. Ответь только JSON-массивом из ${plan.items.length} объектов, тем же форматом, без текста и markdown.` }], system, 10000, false, "mia");
      const items = mapPlanRows(parseJSONArray(raw), platforms);
      onUpdateProfile({ contentPlan: { ...plan, items, chat: [...newChat, { role: "assistant", content: "Обновила план с учётом правки." }] } });
    } catch (e) {
      onUpdateProfile({ contentPlan: { ...plan, chat: [...newChat, { role: "assistant", content: "Ошибка: " + e.message }] } });
    }
    setChatLoading(false);
  };

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "0.85 1 280px", minWidth: 280 }}>
        <div style={{ ...s.card, display: "flex", flexDirection: "column", minHeight: "60vh" }}>
          <span style={s.label}>Чат с Мией — правки плана</span>
          <div ref={chatRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", margin: "8px 0" }}>
            {!plan && <div style={{ fontSize: 11, color: COLORS.brownS, fontStyle: "italic" }}>Сначала сгенерируй план справа — потом здесь можно будет попросить пересобрать его с учётом правки.</div>}
            {plan && chat.length === 0 && <div style={{ fontSize: 11, color: COLORS.brownS, fontStyle: "italic" }}>Например: «слишком много про страх, добавь про деньги»</div>}
            {chat.map((m, i) => <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>)}
            {chatLoading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Пересобираю план...</div>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <textarea value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendRevision(chatInput); } }} placeholder="Правка к плану..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} disabled={!plan || chatLoading} />
            <button onClick={() => sendRevision(chatInput)} disabled={!plan || chatLoading || !chatInput.trim()} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: (!plan || chatLoading || !chatInput.trim()) ? .4 : 1 }}>→</button>
          </div>
        </div>
      </div>

      <div style={{ flex: "1.15 1 340px", minWidth: 280 }}>
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
            <div style={{ fontSize: 10, color: COLORS.brownS, marginBottom: 8 }}>{plan.source === "upload" ? "Загружен" : "Сгенерирован"} {new Date(plan.generatedAt).toLocaleDateString("ru")} · {plan.items.length} тем{plan.source !== "upload" ? ` · тип профиля: ${computeProfileTypeLabel(profile) === "ИНТЕРВЬЮ" ? "по интервью" : "по документу воркшопа"}` : ""}</div>
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
    </div>
  );
}

function MiaIdeaTab({ profile, onUpdateProfile, onWritePost }) {
  // Persisted on the profile (not just local state) — otherwise switching
  // tabs unmounts MiaIdeaTab and both the chat and any in-progress draft
  // topic are gone, same issue MiaNewsTab had with newsResults.
  const [chat, setChat] = useState(profile.ideaChat || []);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [formatLoading, setFormatLoading] = useState(false);
  const [draftTopic, setDraftTopic] = useState(profile.ideaDraftTopic || null);
  const chatRef = useRef(null);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [chat]);

  const existingTopics = (profile.contentPlan?.items || []).map(it => it.topic).filter(Boolean).join(", ");

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const packet = createContextPacket({ agent: "mia", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = miaIdeaCore({ existingTopics });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
    const newChat = [...chat, { role: "user", content: msg }];
    setChat(newChat);
    onUpdateProfile({ ideaChat: newChat });
    try {
      const messages = newChat.slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 1200, false, "mia");
      const updated = [...newChat, { role: "assistant", content: reply }];
      setChat(updated);
      onUpdateProfile({ ideaChat: updated });
    } catch (e) {
      const updated = [...newChat, { role: "assistant", content: "Ошибка: " + e.message }];
      setChat(updated);
      onUpdateProfile({ ideaChat: updated });
    }
    setLoading(false);
  };

  const makeTopicFromMessage = async (text) => {
    if (!text || !text.trim()) return false;
    setFormatLoading(true);
    try {
      const raw = await callAPI([{ role: "user", content: text }], miaFormatIdeaCore(), 300, false, "mia");
      const parsed = parseJSON(raw);
      const topic = {
        topic: parsed.topic || text,
        anchor: parsed["опора"] || parsed.opora || parsed.anchor || "",
        stage: Math.min(5, Math.max(1, Number(parsed.stage) || 2)),
        platform: Object.keys(PLATFORMS)[0],
      };
      setDraftTopic(topic);
      onUpdateProfile({ ideaDraftTopic: topic });
      setFormatLoading(false);
      return true;
    } catch (e) {
      alert("Ошибка: " + (e.message || "не удалось оформить тему"));
      setFormatLoading(false);
      return false;
    }
  };

  const formatIdea = async () => {
    if (!input.trim()) return;
    if (await makeTopicFromMessage(input)) setInput("");
  };

  // Heuristic for "this message reads like a proposed topic, not just chatter"
  // — used only to make the button more prominent, never to hide it.
  const looksLikeTopic = (text) => /^\s*тема\s*:/i.test(text || "");

  const updateDraftTopic = (changes) => {
    const next = { ...draftTopic, ...changes };
    setDraftTopic(next);
    onUpdateProfile({ ideaDraftTopic: next });
  };

  const addToPlan = () => {
    if (!draftTopic) return;
    const plan = profile.contentPlan;
    const newItem = { day: (plan?.items?.length || 0) + 1, platform: draftTopic.platform, topic: draftTopic.topic, stage: draftTopic.stage, anchor: draftTopic.anchor };
    if (plan) {
      onUpdateProfile({ contentPlan: { ...plan, items: [...plan.items, newItem] }, ideaDraftTopic: null });
    } else {
      onUpdateProfile({ contentPlan: { platforms: [draftTopic.platform], items: [newItem], chat: [], generatedAt: new Date().toISOString() }, ideaDraftTopic: null });
    }
    setDraftTopic(null);
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 10 }}>Придумай тему с нуля, изложи мысль хаотично, или сразу напиши готовую — Мия оформит.</div>
      <div ref={chatRef} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto", marginBottom: 8 }}>
        {chat.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
            <div style={{ ...s.chatMsg(m.role), maxWidth: "100%", marginLeft: 0 }}><MsgText text={m.content} /></div>
            {m.role === "assistant" && (
              <button
                onClick={() => makeTopicFromMessage(m.content)}
                disabled={formatLoading}
                style={{ ...(i === chat.length - 1 && looksLikeTopic(m.content) ? s.btnRose : s.btnOutline), ...s.btnSm, marginTop: 3, opacity: formatLoading ? .5 : 1 }}
              >
                Сделать темой
              </button>
            )}
          </div>
        ))}
        {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Думаю...</div>}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginBottom: 8 }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Сообщение Мие или готовая тема..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
        <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
      </div>
      <button onClick={formatIdea} disabled={formatLoading || !input.trim()} style={{ ...s.btnOutline, ...s.btnSm, opacity: (formatLoading || !input.trim()) ? .5 : 1 }}>{formatLoading ? "Оформляю..." : "✎ Написать свою идею"}</button>

      {draftTopic && (
        <div style={{ marginTop: 14 }}>
          <span style={s.label}>Тема</span>
          <div style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <select value={draftTopic.platform} onChange={e => updateDraftTopic({ platform: e.target.value })} style={{ ...s.field, width: "auto", padding: "3px 7px", fontSize: 10 }}>
                {Object.entries(PLATFORMS).map(([key, p]) => <option key={key} value={key}>{p.icon} {p.name}</option>)}
              </select>
              <select value={draftTopic.stage} onChange={e => updateDraftTopic({ stage: Number(e.target.value) })} style={{ ...s.field, width: "auto", padding: "3px 7px", fontSize: 10, color: COLORS.rose, fontWeight: 700 }}>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Ступень {n}</option>)}
              </select>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                <button onClick={addToPlan} style={{ ...s.btnOutline, ...s.btnSm }}>+ Добавить в план</button>
                <button onClick={() => onWritePost(draftTopic)} style={{ ...s.btnOutline, ...s.btnSm }}>✍️ Написать пост</button>
              </div>
            </div>
            <input value={draftTopic.topic} onChange={e => updateDraftTopic({ topic: e.target.value })} style={{ ...s.field, fontWeight: 600 }} />
            {draftTopic.anchor && <div style={{ fontSize: 10, color: COLORS.brownS, fontStyle: "italic" }}>Опора: {draftTopic.anchor}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function MiaNewsTab({ profile, onUpdateProfile, onWritePost }) {
  const [instruction, setInstruction] = useState(profile.newsInstruction || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rawReply, setRawReply] = useState("");
  // Persisted on the profile (not just local state) — otherwise switching
  // tabs unmounts MiaNewsTab and the results are gone, forcing a re-search.
  const [topics, setTopics] = useState(profile.newsResults || []);
  // Which topics the user already added — local only (resets on remount),
  // just enough to give feedback right after the click without pretending
  // to track it across tab switches.
  const [addedIdx, setAddedIdx] = useState(new Set());

  const search = async () => {
    setLoading(true);
    setError("");
    setRawReply("");
    setTopics([]);
    setAddedIdx(new Set());
    onUpdateProfile({ newsResults: [], newsInstruction: instruction });
    const packet = createContextPacket({ agent: "trend_researcher", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = trendResearcherCore({ userInstruction: instruction });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: false });
    let raw = "";
    try {
      raw = await callAPI([{ role: "user", content: "Найди актуальные инфоповоды в нише." }], system, 1600, true, "trend_researcher");
      if (!raw) throw new Error("Агент вернул пустой ответ. Попробуй ещё раз.");
      const parsed = raw.split(/(?=Вариант\s*\d+\s*:)/i).map(t => t.trim()).filter(Boolean);
      const result = parsed.length ? parsed : [raw];
      setTopics(result);
      onUpdateProfile({ newsResults: result });
    } catch (e) {
      setError(e.message || "Ошибка запроса");
      setRawReply(raw);
    }
    setLoading(false);
  };

  const makeTopic = (text, idx) => {
    const topic = text.replace(/^Вариант\s*\d+\s*:\s*/i, "").trim();
    const plan = profile.contentPlan;
    const platform = plan?.platforms?.[0] || Object.keys(PLATFORMS)[0];
    const newItem = { day: (plan?.items?.length || 0) + 1, platform, topic, stage: 2, anchor: "из новостей ниши" };
    if (plan) {
      onUpdateProfile({ contentPlan: { ...plan, items: [...plan.items, newItem] } });
    } else {
      onUpdateProfile({ contentPlan: { platforms: [platform], items: [newItem], chat: [], generatedAt: new Date().toISOString() } });
    }
    setAddedIdx(prev => new Set(prev).add(idx));
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 10 }}>Мия поищет актуальные инфоповоды в нише через веб-поиск и предложит темы под них.</div>
      <span style={s.label}>Инструкция для поиска (необязательно)</span>
      <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Например: обрати внимание на новости про..." rows={2} style={{ ...s.field, width: "100%", marginBottom: 8 }} />
      <button onClick={search} disabled={loading} style={{ ...s.btnRose, opacity: loading ? .4 : 1 }}>{loading ? "Ищу..." : "🌍 Найти инфоповоды"}</button>

      {error && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{error}</div>
          {rawReply && <div style={{ fontSize: 10, color: COLORS.brownS, background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 8, padding: 8, maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>{rawReply}</div>}
        </div>
      )}

      {topics.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          {topics.map((t, i) => (
            <div key={i} style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}><MsgText text={t} /></div>
              {addedIdx.has(i) ? (
                <span style={{ ...s.btnSm, alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.green, fontSize: 11, fontWeight: 600 }}>✓ В твоём плане</span>
              ) : (
                <button onClick={() => makeTopic(t, i)} style={{ ...s.btnOutline, ...s.btnSm, alignSelf: "flex-start" }}>+ Сделать темой</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const COMPETITOR_PLATFORMS = {
  instagram: { icon: "📸", name: "Instagram" },
  tiktok: { icon: "🎵", name: "TikTok" },
  youtube: { icon: "▶️", name: "YouTube" },
};

// Accepts either a bare handle or a full profile URL (Instagram/TikTok/
// YouTube) and returns just the handle — ScrapeCreators expects a handle,
// not a URL.
function parseCompetitorHandle(input) {
  let v = (input || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) {
    try {
      const url = new URL(v);
      let path = url.pathname.replace(/^\/+|\/+$/g, "");
      path = path.replace(/^(channel|c|user)\//i, ""); // youtube-специфичные префиксы
      v = path.split("/")[0] || v;
    } catch { /* не распарсилось как URL — используем как есть, дальше просто уберём @ */ }
  }
  return v.replace(/^@/, "");
}

function MiaCompetitorsTab({ profile, onUpdateProfile }) {
  // Old profiles predate this feature — read defensively.
  const competitors = profile.competitors || [];
  const [newPlatform, setNewPlatform] = useState("instagram");
  const [newHandle, setNewHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Persisted on the profile (not just local state) — otherwise switching
  // tabs unmounts MiaCompetitorsTab and the analysis results are gone,
  // same issue MiaNewsTab had with newsResults.
  const [warnings, setWarnings] = useState(profile.competitorsWarnings || []);
  const [topics, setTopics] = useState(profile.competitorsTopics || []);
  // Шаг 1 промпта (разбор роликов с транскрипцией) — отдельно от тем шага 2:
  // это анализ, не предложение темы, ему не место среди карточек с
  // кнопкой "+ Сделать темой".
  const [breakdown, setBreakdown] = useState(profile.competitorsBreakdown || "");

  const addCompetitor = () => {
    if (!newHandle.trim()) return;
    onUpdateProfile({ competitors: [...competitors, { platform: newPlatform, handle: parseCompetitorHandle(newHandle) }] });
    setNewHandle("");
  };

  const removeCompetitor = (i) => onUpdateProfile({ competitors: competitors.filter((_, idx) => idx !== i) });

  // Deliberately manual (button-triggered), not automatic on tab open —
  // every call spends ScrapeCreators credits, and competitor content
  // doesn't change minute to minute.
  const analyze = async () => {
    if (!competitors.length) return;
    setLoading(true);
    setError("");
    setWarnings([]);
    setTopics([]);
    setBreakdown("");
    onUpdateProfile({ competitorsWarnings: [], competitorsTopics: [], competitorsBreakdown: "" });
    const fetched = [];
    const newWarnings = [];
    for (const c of competitors) {
      try {
        const posts = await scrapeCompetitor(c.platform, c.handle);
        fetched.push({ ...c, posts });
      } catch (e) {
        newWarnings.push(`@${c.handle} (${COMPETITOR_PLATFORMS[c.platform]?.name}): ${e.message}`);
      }
    }
    onUpdateProfile({ competitorsLastFetched: new Date().toISOString(), competitorsWarnings: newWarnings });
    setWarnings(newWarnings);
    const withPosts = fetched.filter(c => c.posts.length);
    if (!withPosts.length) {
      setError(newWarnings.length ? "Не удалось получить данные ни по одному конкуренту." : "У конкурентов не нашлось постов для анализа.");
      setLoading(false);
      return;
    }
    const summary = withPosts.map(c =>
      `@${c.handle} (${COMPETITOR_PLATFORMS[c.platform]?.name}):\n` +
      c.posts.map((p, i) => `${i + 1}. "${p.title_or_caption || "(без подписи)"}" (❤ ${p.likes} · 💬 ${p.comments} · 👁 ${p.views})` + (p.transcript ? `\nТранскрипт: ${p.transcript}` : "")).join("\n")
    ).join("\n\n");
    const packet = createContextPacket({ agent: "competitor_analysis", profile: buildMiaProfileFields(profile), materials: profile.materials });
    const coreInstructions = competitorAnalysisCore();
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
    try {
      const raw = await callAPI([{ role: "user", content: `Посты конкурентов (с транскриптом у самых залетевших):\n\n${summary}\n\nСначала разбери ролики с транскрипцией по отдельности, потом найди повторяющиеся темы/форматы/крючки и предложи 3-5 тем для контента пользователя.` }], system, 2400, false, "competitor_analysis");
      if (!raw) throw new Error("Агент вернул пустой ответ.");
      // Шаг 1 (разбор роликов) идёт перед первым "Вариант N:" — это анализ,
      // не тема, отделяем его от карточек с "+ Сделать темой" ниже.
      const firstVariantIdx = raw.search(/Вариант\s*\d+\s*:/i);
      const breakdownText = firstVariantIdx > 0 ? raw.slice(0, firstVariantIdx).trim() : "";
      const topicsRaw = firstVariantIdx >= 0 ? raw.slice(firstVariantIdx) : raw;
      const parsed = topicsRaw.split(/(?=Вариант\s*\d+\s*:)/i).map(t => t.trim()).filter(Boolean);
      const result = parsed.length ? parsed : (firstVariantIdx === -1 ? [raw] : []);
      setBreakdown(breakdownText);
      setTopics(result);
      onUpdateProfile({ competitorsBreakdown: breakdownText, competitorsTopics: result });
    } catch (e) {
      setError(e.message || "Ошибка запроса");
    }
    setLoading(false);
  };

  const makeTopic = (text) => {
    const topic = text.replace(/^Вариант\s*\d+\s*:\s*/i, "").trim();
    const plan = profile.contentPlan;
    const platform = plan?.platforms?.[0] || Object.keys(PLATFORMS)[0];
    const newItem = { day: (plan?.items?.length || 0) + 1, platform, topic, stage: 2, anchor: "по паттерну конкурентов" };
    if (plan) {
      onUpdateProfile({ contentPlan: { ...plan, items: [...plan.items, newItem] } });
    } else {
      onUpdateProfile({ contentPlan: { platforms: [platform], items: [newItem], chat: [], generatedAt: new Date().toISOString() } });
    }
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 4 }}>Добавь конкурентов, чтобы Мия нашла повторяющиеся темы и форматы в их контенте и предложила идеи под твой голос и продукт.</div>
      <div style={{ fontSize: 10, color: COLORS.brownS, fontStyle: "italic", marginBottom: 10 }}>Залетевшесть считаем по лайкам, комментариям и просмотрам — сохранения и репосты сами площадки не показывают публично никому, кроме владельца аккаунта.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {competitors.map((c, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "7px 11px" }}>
            <span>{COMPETITOR_PLATFORMS[c.platform]?.icon}</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>@{c.handle}</span>
            <span style={{ fontSize: 10, color: COLORS.brownS }}>{COMPETITOR_PLATFORMS[c.platform]?.name}</span>
            <button onClick={() => removeCompetitor(i)} disabled={loading} title="Удалить конкурента" style={{ marginLeft: "auto", ...s.btnOutline, padding: "4px 8px", fontSize: 11, borderRadius: 6, color: "#DC2626", borderColor: "#FECACA" }}>✕</button>
          </div>
        ))}
        {!competitors.length && <div style={{ fontSize: 11, color: COLORS.brownS, fontStyle: "italic" }}>Пока не добавлено ни одного конкурента.</div>}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <select value={newPlatform} onChange={e => setNewPlatform(e.target.value)} style={{ ...s.field, width: "auto", padding: "5px 9px", fontSize: 11 }}>
          {Object.entries(COMPETITOR_PLATFORMS).map(([key, m]) => <option key={key} value={key}>{m.icon} {m.name}</option>)}
        </select>
        <input value={newHandle} onChange={e => setNewHandle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addCompetitor(); }} placeholder="@handle" style={{ ...s.field, width: 160 }} />
        <button onClick={addCompetitor} disabled={!newHandle.trim()} style={{ ...s.btnOutline, ...s.btnSm, opacity: newHandle.trim() ? 1 : .5 }}>+ Добавить конкурента</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={analyze} disabled={!competitors.length || loading} style={{ ...s.btnRose, opacity: (!competitors.length || loading) ? .4 : 1 }}>{loading ? "Анализирую..." : "🔍 Обновить и проанализировать"}</button>
        {profile.competitorsLastFetched && <span style={{ fontSize: 10, color: COLORS.brownS }}>Обновлено: {new Date(profile.competitorsLastFetched).toLocaleString("ru")}</span>}
      </div>

      {loading && <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", margin: "12px 0" }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>}

      {warnings.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 10, color: COLORS.amber }}>
          {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {error && <div style={{ marginTop: 10, fontSize: 11, color: "#DC2626" }}>{error}</div>}

      {breakdown && (
        <div style={{ marginTop: 14 }}>
          <span style={s.label}>Разбор самых залетевших роликов</span>
          <div style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
            <MsgText text={breakdown} />
          </div>
        </div>
      )}

      {topics.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          {topics.map((t, i) => (
            <div key={i} style={{ background: COLORS.white, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}><MsgText text={t} /></div>
              <button onClick={() => makeTopic(t)} style={{ ...s.btnOutline, ...s.btnSm, alignSelf: "flex-start" }}>+ Сделать темой</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiaScreen({ profile, onUpdateProfile, onWritePost }) {
  const [subTab, setSubTab] = useState("plan");
  const SUB_TABS = [["idea", "Идея"], ["news", "Новости"], ["plan", "План"], ["competitors", "Конкуренты"]];

  return (
    <div style={s.panel}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>Мия — маркетолог</div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>Знает вашу аудиторию, продукты и конкурентов для ниши «{profile.name}»</div>

      <div style={{ display: "flex", border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, overflow: "hidden", marginBottom: 16 }}>
        {SUB_TABS.map(([key, label], i) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            style={{ flex: 1, padding: "7px 4px", border: "none", borderRight: i < SUB_TABS.length - 1 ? `1px solid ${COLORS.brd}` : "none", background: subTab === key ? COLORS.rose : COLORS.cream, color: subTab === key ? "#fff" : COLORS.brownS, fontSize: 10, fontWeight: 700, cursor: "pointer", textAlign: "center" }}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "plan" && <MiaPlanTab profile={profile} onUpdateProfile={onUpdateProfile} onWritePost={onWritePost} />}
      {subTab === "news" && <MiaNewsTab profile={profile} onUpdateProfile={onUpdateProfile} onWritePost={onWritePost} />}
      {subTab === "idea" && <MiaIdeaTab profile={profile} onUpdateProfile={onUpdateProfile} onWritePost={onWritePost} />}
      {subTab === "competitors" && <MiaCompetitorsTab profile={profile} onUpdateProfile={onUpdateProfile} />}
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
          <span style={s.label}>Тема</span>
          <textarea style={{ ...s.field, minHeight: 50 }} rows={2} value={topic} onChange={e => setTopic(e.target.value)} placeholder="О чём ролик — Лео раскроет тему в текст на следующем шаге..." />
        </div>
        <button style={{ ...s.btnRose, width: "100%", opacity: topic.trim() ? 1 : .5 }} disabled={!topic.trim()} onClick={create}>Создать и открыть →</button>
      </div>
    </div>
  );
}

// ── CARD MODAL ──
function CardModal({ reel, profile, reels, onUpdate, onUpdateProfile, onDelete }) {
  // Quick-started cards (Team screen → Кира/Ася/Тим) arrive with
  // reveal_text already filled in and no Лео step to pass through — same
  // routing rule LeoStep.submit uses (video/Карусель → Script/Carousel,
  // else → Copy directly), just applied once at mount instead of on a
  // button click. A plain Лео quick-start (topic only, reveal_text still
  // empty) still starts at step 0 like any other new card.
  const [step, setStep] = useState(() => {
    if (reel.reveal_text !== undefined && reel.reveal_text) {
      return (VIDEO_FORMATS.includes(reel.format) || reel.format === "Карусель") ? 1 : 2;
    }
    return 0;
  });
  const [showConfirm, setShowConfirm] = useState(false);
  const p = PLATFORMS[reel.platform];
  const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;

  const statusIdx = STATUSES.findIndex(s => s.key === reel.status);
  // Cards created before this PR don't have `reveal_text` at all (old
  // localStorage/window.storage shape predates the field) — those keep
  // opening on IdeaStep as before; only new cards get LeoStep.
  const isNewCard = reel.reveal_text !== undefined;

  // Лео/Кира/Ася/Тим/Заметки are all standalone agent screens now, not
  // steps inside the old card — no topic/badges header, no Статус bar, no
  // step tabs at any point in a new card's path. Each screen draws its own
  // header instead (see LeoStep and friends). Old cards (!isNewCard) are
  // untouched below — full old chrome, all four steps.
  if (isNewCard) {
    return (
      <>
        {step === 0 && <LeoStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={(target) => setStep(target)} />}
        {step === 1 && (
          reel.format === "Карусель"
            ? <CarouselStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(2)} standalone />
            : <ScriptStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(2)} standalone />
        )}
        {step === 2 && <CopyStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(3)} standalone />}
        {step === 3 && (
          <NotesStep reel={reel} profile={profile} onUpdate={onUpdate} onUpdateProfile={onUpdateProfile} onDeleteRequest={() => setShowConfirm(true)} standalone onBack={() => setStep(2)} />
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
      </>
    );
  }

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
        {["1 · Идея", reel.format === "Карусель" ? "2 · Слайды" : "2 · Сценарий", "3 · Тексты", "4 · Заметки"].map((t, i) => (
          <button key={i} onClick={() => setStep(i)} style={{ flex: 1, padding: "7px 4px", border: "none", borderRight: i < 3 ? `1px solid ${COLORS.brd}` : "none", background: step === i ? COLORS.rose : (i === 1 && reel.script_versions?.length) || (i === 2 && reel.copy && Object.keys(reel.copy).length) ? COLORS.greenL : COLORS.cream, color: step === i ? "#fff" : (i === 1 && reel.script_versions?.length) || (i === 2 && reel.copy && Object.keys(reel.copy).length) ? COLORS.green : COLORS.brownS, fontSize: 10, fontWeight: 700, cursor: "pointer", textAlign: "center" }}>{t}</button>
        ))}
      </div>

      {step === 0 && <IdeaStep reel={reel} profile={profile} reels={reels} onUpdate={onUpdate} onAdvance={() => setStep(1)} />}
      {step === 1 && (
        reel.format === "Карусель"
          ? <CarouselStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(2)} />
          : <ScriptStep reel={reel} profile={profile} onUpdate={onUpdate} onAdvance={() => setStep(2)} />
      )}
      {step === 2 && <CopyStep reel={reel} profile={profile} onUpdate={onUpdate} />}
      {step === 3 && (
        <NotesStep reel={reel} profile={profile} onUpdate={onUpdate} onUpdateProfile={onUpdateProfile} onDeleteRequest={() => setShowConfirm(true)} />
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

  const buildPacket = () => {
    const existingTopics = reels.filter(x => x.id !== reel.id && x.topic).map(x => x.topic).join(", ");
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const p = PLATFORMS[reel.platform];
    const packet = createContextPacket({
      agent: "ideologist",
      profile: {
        name: profile.name,
        audience: fieldContext(profile, "ca"),
        products: fieldContext(profile, "prod"),
        toneOfVoice: fieldContext(profile, "tov"),
        manualMemory: fieldContext(profile, "memory"),
        learnedMemory: profile.learnedMemory || [],
      },
      content: {
        topic: reel.topic,
        planAnchor: reel.plan_anchor || "",
        platform: p?.name,
        format: reel.format,
        huntStage: reel.hunt_stage,
        huntStageHint: reel.hunt_stage ? HUNT_HINTS[reel.hunt_stage] : "",
        selectedLead: lead ? `${lead.name} (${lead.link})` : "",
      },
      materials: profile.materials,
      // The live back-and-forth already goes through the Anthropic
      // `messages` array below — embedding it again here would just
      // duplicate it inside `system`.
      conversation: {},
    });
    const coreInstructions = ideologistCore({ platform: p?.name, format: reel.format, existingTopics });
    return renderContextPacket(packet, { coreInstructions, stage: "idea", requiresMemory: true });
  };

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const { system } = buildPacket();
    const newChat = [...(reel.idea_chat || []), { role: "user", content: msg }];
    onUpdate({ idea_chat: newChat });
    try {
      const messages = newChat.filter(m => m.role !== "note").slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 1600, false, "ideologist");
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
    const { system } = buildPacket(false);
    const baseChat = (reel.idea_chat || []).filter(m => m.role !== "note");
    try {
      const messages = [...baseChat.slice(-6).map(m => ({ role: m.role, content: m.content })), { role: "user", content: "Пользователь готов перейти к сценаристу. Ответь только карточкой ###КАРТОЧКА_START### / ... / ###КАРТОЧКА_END### — без markdown, без вступления, без другого текста." }];
      const reply = await callAPI(messages, system, 700, false, "ideologist");
      const block = extractAngleBlock(reply);
      if (!block) {
        setHandoffError("Не удалось получить итог от Идеолога. Можно попробовать снова или перейти без согласованного угла.");
        setHandoffLoading(false);
        return;
      }
      const get = (label) => { const mm = block.match(new RegExp(label + "\\s*:\\s*(.+)", "i")); return mm ? mm[1].trim() : ""; };
      const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
      const strategyCard = {
        topic: reel.topic || "",
        planAnchor: reel.plan_anchor || "",
        audienceSegment: get("СЕГМЕНТ"),
        huntStage: reel.hunt_stage,
        contentGoal: get("ЦЕЛЬ"),
        angle: get("УГОЛ"),
        rationale: get("ОБОСНОВАНИЕ"),
        hook: get("ХУК"),
        funnelRole: get("РОЛЬ В ВОРОНКЕ"),
        allowedFacts: get("РАЗРЕШЁННЫЕ ФАКТЫ"),
        selectedLead: lead ? `${lead.name} (${lead.link})` : "",
        userConstraints: get("ОГРАНИЧЕНИЯ"),
        raw: block,
      };
      // agreed_angle keeps the old shape ScriptStep/CarouselStep/CopyStep
      // still read directly — they switch to content.strategyCard via
      // contextPacket in a follow-up PR, alongside their own prompt fixes.
      const angle = { raw: block, angle: strategyCard.angle, rationale: strategyCard.rationale, hook: strategyCard.hook };
      onUpdate({ idea_chat: [...(reel.idea_chat || []), { role: "note", content: "✓ Угол согласован, передаю сценаристу" }], agreed_angle: angle, strategy_card: strategyCard });
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
        {reel.topic && !(reel.idea_chat || []).length && (
          <button onClick={() => send(reel.topic)} style={{ background: COLORS.rose, border: `1.5px solid ${COLORS.rose}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: "#fff", fontWeight: 600, cursor: "pointer" }}>Работаем над этой темой →</button>
        )}
        {[
          ...(reel.topic ? [] : ["Придумай тему с нуля"]),
          "Какой угол для ЦА?", "Проверь воронку", "5 тем на месяц",
        ].map(q => (
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

// ── LEO STEP (раскрытие темы — replaces IdeaStep as the entry point for
// newly created cards; IdeaStep itself stays in the codebase, unused, in
// case of rollback) ──
function LeoStep({ reel, profile, onUpdate, onAdvance }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [textDraft, setTextDraft] = useState(reel.reveal_text || "");
  const chatRef = useRef(null);
  const autoGenRef = useRef(false);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [reel.reveal_chat]);
  useEffect(() => { setTextDraft(reel.reveal_text || ""); }, [reel.reveal_text]);

  const buildPacket = () => {
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const packet = createContextPacket({
      agent: "leo",
      profile: {
        name: profile.name,
        audience: fieldContext(profile, "ca"),
        products: fieldContext(profile, "prod"),
        toneOfVoice: fieldContext(profile, "tov"),
        manualMemory: fieldContext(profile, "memory"),
        learnedMemory: profile.learnedMemory || [],
      },
      content: {
        topic: reel.topic,
        planAnchor: reel.plan_anchor || "",
        huntStage: reel.hunt_stage,
        huntStageHint: reel.hunt_stage ? HUNT_HINTS[reel.hunt_stage] : "",
        selectedLead: lead ? `${lead.name} (${lead.link})` : "",
      },
      materials: profile.materials,
      conversation: {
        recentMessages: reel.reveal_chat || [],
        latestUserEdit: reel.reveal_text ? `Текущий текст (учитывай ручные правки пользователя):\n${reel.reveal_text}` : "",
      },
    });
    const coreInstructions = leoCore();
    return renderContextPacket(packet, { coreInstructions, stage: "leo", requiresMemory: true });
  };

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const { system } = buildPacket();
    const newChat = [...(reel.reveal_chat || []), { role: "user", content: msg }];
    onUpdate({ reveal_chat: newChat });
    try {
      const messages = newChat.slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 2000, false, "leo");
      onUpdate({ reveal_chat: [...newChat, { role: "assistant", content: reply }], reveal_text: reply });
    } catch (e) {
      onUpdate({ reveal_chat: [...newChat, { role: "assistant", content: "Ошибка: " + e.message }] });
    }
    setLoading(false);
  };

  useEffect(() => {
    if (autoGenRef.current) return;
    if (reel.topic?.trim() && !reel.reveal_text) {
      autoGenRef.current = true;
      send("Раскрой эту тему в полноценный текст.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveTextEdit = () => {
    if (textDraft === reel.reveal_text) return;
    onUpdate({ reveal_text: textDraft });
  };

  // One reel is still one platform/format (see ТЗ) — checkboxes here are a
  // forward-looking UI for multi-platform selection, but only the first
  // checked entry actually drives routing below.
  useEffect(() => {
    if (!(reel.selected_platforms || []).length && reel.platform && reel.format) {
      onUpdate({ selected_platforms: [{ key: reel.platform, format: reel.format }] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlatformFormat = (key, format) => {
    const current = reel.selected_platforms || [];
    const exists = current.some(x => x.key === key && x.format === format);
    onUpdate({ selected_platforms: exists ? current.filter(x => !(x.key === key && x.format === format)) : [...current, { key, format }] });
  };

  const destinationFor = (format) => VIDEO_FORMATS.includes(format) ? "Кире" : format === "Карусель" ? "Асе" : "Тиму";

  const submit = () => {
    const chosen = (reel.selected_platforms && reel.selected_platforms[0]) || { key: reel.platform, format: reel.format };
    const updates = {};
    if (chosen.key !== reel.platform) updates.platform = chosen.key;
    if (chosen.format !== reel.format) updates.format = chosen.format;
    if (Object.keys(updates).length) onUpdate(updates);
    const isVideo = VIDEO_FORMATS.includes(chosen.format);
    const isCarousel = chosen.format === "Карусель";
    onAdvance(isVideo || isCarousel ? 1 : 2);
  };

  return (
    <div>
      {/* Standalone screen (not the old card chrome) — no leo.png asset yet,
          same as the rest of the still-unrenamed team, so text-only header. */}
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>Лео — копирайтер</div>
      <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>Раскрывает тему от Мии в полноценный текст вашим голосом — дальше его адаптируют под площадку</div>

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0.85 1 280px", minWidth: 280 }}>
          <div style={{ ...s.card, display: "flex", flexDirection: "column", minHeight: "60vh" }}>
            <div style={{ background: COLORS.roseP, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", marginBottom: 8, fontSize: 11, color: COLORS.brown, lineHeight: 1.5, flexShrink: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 3, color: COLORS.rose }}>От Мии</div>
              {reel.topic && <div><strong>Тема:</strong> {reel.topic}</div>}
              {reel.plan_anchor && <div><strong>Опора:</strong> {reel.plan_anchor}</div>}
            {reel.hunt_stage ? <div><strong>Ступень:</strong> {reel.hunt_stage} · {HUNT_HINTS[reel.hunt_stage]}</div> : null}
          </div>
          <div ref={chatRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", marginBottom: 8 }}>
            {(reel.reveal_chat || []).map((m, i) => <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>)}
            {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Пишу...</div>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Правка к тексту..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
            <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
          </div>
        </div>
      </div>

      <div style={{ flex: "1.15 1 340px", minWidth: 280 }}>
        <div style={s.card}>
          <span style={s.label}>Текст от Лео</span>
          <textarea value={textDraft} onChange={e => setTextDraft(e.target.value)} onBlur={saveTextEdit} style={{ ...s.field, minHeight: 220 }} rows={11} placeholder={loading ? "Пишу текст..." : ""} />
          <button onClick={saveTextEdit} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 6 }}>Сохранить правки</button>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {["Живее", "Мягче про продукт", "Короче"].map(q => (
              <button key={q} disabled={loading} onClick={() => send({
                "Живее": "Сделай текст живее и динамичнее — короче предложения, меньше канцелярита.",
                "Мягче про продукт": "Смягчи упоминания продукта — сейчас звучит слишком похоже на рекламу.",
                "Короче": "Сократи текст — убери всё, без чего можно обойтись, не теряя смысл.",
              }[q])} style={{ background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: COLORS.brownS, cursor: "pointer", opacity: loading ? .5 : 1 }}>{q}</button>
            ))}
          </div>
        </div>

        {/* Deliberately separated from the text editor above — this is the
            next, distinct step (choosing where the text goes), not part of
            editing the text itself. A viewport-relative gap (not a fixed
            px number) keeps it below the fold on real screens instead of
            crowding the editor, so the user scrolls to it once they're
            done editing rather than seeing everything squeezed together. */}
        <div style={{ height: 1, background: COLORS.brd, marginTop: "50vh" }} />
        <div style={{ ...s.card, marginTop: 16 }}>
          <span style={s.label}>Куда отправить</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            {Object.entries(PLATFORMS).map(([key, p]) => (
              <div key={key}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{p.icon} {p.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {p.formats.map(format => {
                    const checked = (reel.selected_platforms || []).some(x => x.key === key && x.format === format);
                    return (
                      <label key={format} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 20, border: `1.5px solid ${checked ? COLORS.rose : COLORS.brd}`, background: checked ? COLORS.roseP : COLORS.cream, cursor: "pointer", fontSize: 10 }}>
                        <input type="checkbox" checked={checked} onChange={() => togglePlatformFormat(key, format)} style={{ margin: 0 }} />
                        {format} → {destinationFor(format)}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <button onClick={submit} disabled={!reel.reveal_text} style={{ ...s.btnRose, width: "100%", marginTop: 12, opacity: reel.reveal_text ? 1 : .4 }}>Отправить агентам →</button>
        </div>
      </div>
      </div>
    </div>
  );
}

// ── SCRIPT STEP ──
function ScriptStep({ reel, profile, onUpdate, onAdvance, standalone }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hooksError, setHooksError] = useState("");
  const [scriptDraft, setScriptDraft] = useState(reel.script_versions?.[reel.selected_script] || "");
  const chatRef = useRef(null);
  const autoGenRef = useRef(false);
  const p = PLATFORMS[reel.platform];

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [reel.script_chat]);
  useEffect(() => { setScriptDraft(reel.script_versions?.[reel.selected_script] || ""); }, [reel.selected_script, reel.script_versions]);

  const isVideo = VIDEO_FORMATS.includes(reel.format);

  useEffect(() => {
    if (autoGenRef.current) return;
    // Quick-started cards (Кира via "Команда") arrive with reveal_text but a
    // deliberately blank topic — reveal_text alone is enough of an idea to
    // generate from, so don't gate on topic when it's present.
    if ((reel.reveal_text || reel.agreed_angle) && !(reel.script_versions || []).length && (reel.topic?.trim() || reel.reveal_text) && (!isVideo || reel.shoot_format)) {
      autoGenRef.current = true;
      generateFromIdea();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel.shoot_format]);

  // Same shape ScriptStep always used, just assembled by contextBuilder now
  // instead of manual string concatenation — see PR notes for what moved
  // where (planAnchor/strategyCard/allowedFacts/userConstraints are now
  // fixed decisions; "текущий сценарий" is conversation.latestUserEdit so
  // it's guaranteed to survive even a long idea-chat history).
  const buildPacket = () => {
    const p = PLATFORMS[reel.platform];
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const finalScript = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : "";
    const shootPlanInstr = isVideo ? `\n\nПосле СЦЕНАРИЙ: добавь отдельным блоком ПЛАН СЪЁМКИ: с ${
      reel.shoot_format === "voiceover" ? "тем, что показывать в кадре (Б-ролл) под каждую фразу начитки"
      : reel.shoot_format === "full_plan" ? "для каждого смыслового куска сценария (хук / было-плохо / перелом / стало-так / CTA) — что в кадре, ракурс и крупность, примерная локация и реквизит, текст на экране в этот момент"
      : "минимальными пометками, где сменить план/крупность для динамики (без покадрового разбора)"
    }.` : "";
    const angleText = reel.reveal_text || (reel.strategy_card
      ? [reel.strategy_card.angle, reel.strategy_card.rationale, reel.strategy_card.funnelRole ? `Роль в воронке: ${reel.strategy_card.funnelRole}` : ""].filter(Boolean).join(". ")
      : (reel.agreed_angle?.angle || ""));
    const packet = createContextPacket({
      agent: "scriptwriter",
      profile: {
        name: profile.name,
        audience: fieldContext(profile, "ca"),
        products: fieldContext(profile, "prod"),
        toneOfVoice: fieldContext(profile, "tov"),
        manualMemory: fieldContext(profile, "memory"),
        learnedMemory: profile.learnedMemory || [],
      },
      content: {
        topic: reel.topic,
        planAnchor: reel.plan_anchor || "",
        platform: p?.name,
        format: reel.format,
        huntStage: reel.hunt_stage,
        huntStageHint: reel.hunt_stage ? HUNT_HINTS[reel.hunt_stage] : "",
        agreedAngle: angleText,
        selectedHook: reel.strategy_card?.hook || reel.agreed_angle?.hook || "",
        contentGoal: reel.strategy_card?.contentGoal || "",
        allowedFacts: reel.strategy_card?.allowedFacts || "",
        userConstraints: reel.strategy_card?.userConstraints || "",
        selectedLead: lead ? `${lead.name} (${lead.link})` : "",
        strategyCard: reel.strategy_card || null,
      },
      materials: profile.materials,
      conversation: {
        recentMessages: (reel.idea_chat || []).filter(m => m.role !== "note"),
        latestUserEdit: finalScript ? `Текущий сценарий (учитывай текущий текст, включая ручные правки пользователя):\n${finalScript}` : "",
      },
    });
    const coreInstructions = scriptwriterCore({ platform: p?.name, format: reel.format, shootPlanInstr });
    return renderContextPacket(packet, { coreInstructions, stage: "script", requiresMemory: true });
  };

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const { system } = buildPacket();
    const newChat = [...(reel.script_chat || []), { role: "user", content: msg }];
    onUpdate({ script_chat: newChat });
    let scriptGenerated = false;
    try {
      const messages = newChat.slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 2000, false, "scriptwriter");
      // The strategy card is shown as its own block above the script, not
      // in the chat transcript — strip it out of what gets saved to
      // script_chat so the user doesn't see the raw service markers there.
      const displayReply = reply.replace(/###КАРТОЧКА_START###[\s\S]+?###КАРТОЧКА_END###\n*/, "").trim() || reply;
      const updatedChat = [...newChat, { role: "assistant", content: displayReply }];
      let updates = { script_chat: updatedChat };
      const cm = reply.match(/###КАРТОЧКА_START###([\s\S]+?)###КАРТОЧКА_END###/);
      if (cm) updates.script_strategy_card = cm[1].trim();
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

  const generateFromIdea = async () => {
    // reel.topic can be blank on a quick-started card — the actual idea is
    // reveal_text, already carried into the system prompt as "Согласованный
    // угол", so the user message just needs to ask for a script at all.
    const msg = reel.topic?.trim() ? `Сгенерируй сценарий на тему: ${reel.topic}` : "Сгенерируй сценарий по тексту выше.";
    await send(msg);
  };

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
      const reply = await callAPI([{ role: "user", content: "Дай варианты хука к финальному сценарию." }], system, 400, false, "scriptwriter");
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

  const cardField = (label) => {
    if (!reel.script_strategy_card) return "";
    const mm = reel.script_strategy_card.match(new RegExp(label + "\\s*:\\s*(.+)", "i"));
    return mm ? mm[1].trim() : "";
  };

  // Old cards (!standalone) keep the exact pre-Кира single-column layout —
  // "Обратная совместимость для !isNewCard карточек — полностью без
  // изменений" per ТЗ, not just "no missing features".
  if (!standalone) {
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
            <button onClick={generateFromIdea} disabled={loading || (!reel.topic?.trim() && !reel.reveal_text) || (isVideo && !reel.shoot_format)} style={{ ...s.btnRose, width: "100%", marginTop: 8, opacity: (loading || (!reel.topic?.trim() && !reel.reveal_text) || (isVideo && !reel.shoot_format)) ? .5 : 1 }}>
              {loading ? "Генерирую..." : "✦ Сгенерировать сценарий"}
            </button>
          </div>
        )}
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
        {reel.script_strategy_card && (reel.script_versions || []).length > 0 && (
          <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>📋 Карточка стратегии</div>
            {cardField("Ступень") && <div><strong>Ступень Ханта:</strong> {cardField("Ступень")}</div>}
            {cardField("Ключевая мысль") && <div><strong>Ключевая мысль:</strong> {cardField("Ключевая мысль")}</div>}
            {cardField("Каркас") && <div><strong>Каркас:</strong> {cardField("Каркас")}</div>}
            {cardField("Триггер") && <div><strong>Триггер:</strong> {cardField("Триггер")}</div>}
            {cardField("CTA") && <div><strong>CTA:</strong> {cardField("CTA")}</div>}
            {cardField("Допущения") && <div><strong>Допущения:</strong> {cardField("Допущения")}</div>}
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
            <button onClick={() => send("3 варианта хука")} disabled={loading} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 4, opacity: loading ? .5 : 1 }}>🔄 Другие варианты</button>
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <img src="/agents/kira.png" alt="Кира" style={{ width: 48, height: 48, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ fontSize: 18, fontWeight: 800 }}>Кира — сценарист</div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <Badge bg={COLORS.blueL} color={COLORS.blue}>{p?.icon} {p?.name} · {reel.format}</Badge>
        {reel.hunt_stage ? <Badge bg={COLORS.roseL} color={COLORS.rose}>Ступень {reel.hunt_stage}</Badge> : null}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0.85 1 280px", minWidth: 280 }}>
          <div style={{ ...s.card, display: "flex", flexDirection: "column", minHeight: "60vh" }}>
            {reel.reveal_text && (
              <div style={{ background: COLORS.roseP, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", marginBottom: 8, fontSize: 11, color: COLORS.brown, lineHeight: 1.5, flexShrink: 0 }}>
                <div style={{ fontWeight: 700, marginBottom: 3, color: COLORS.rose }}>От Лео</div>
                <div>{reel.reveal_text.slice(0, 150)}{reel.reveal_text.length > 150 ? "…" : ""}</div>
              </div>
            )}
            <div ref={chatRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", marginBottom: 8 }}>
              {!(reel.script_chat || []).length && <div style={{ fontSize: 11, color: COLORS.brownS, fontStyle: "italic" }}>Отредактируй идею справа и нажми «Сгенерировать сценарий», или сразу опиши, что нужно, здесь.</div>}
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
          </div>
        </div>

        <div style={{ flex: "1.15 1 340px", minWidth: 280 }}>
          {!(reel.script_versions || []).length && (
            <div style={{ ...s.card, marginBottom: 14 }}>
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
              <button onClick={generateFromIdea} disabled={loading || (!reel.topic?.trim() && !reel.reveal_text) || (isVideo && !reel.shoot_format)} style={{ ...s.btnRose, width: "100%", marginTop: 8, opacity: (loading || (!reel.topic?.trim() && !reel.reveal_text) || (isVideo && !reel.shoot_format)) ? .5 : 1 }}>
                {loading ? "Генерирую..." : "✦ Сгенерировать сценарий"}
              </button>
            </div>
          )}
          {(reel.script_versions || []).length > 0 && (
            <div style={{ ...s.card, marginBottom: 10 }}>
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
          {reel.script_strategy_card && (reel.script_versions || []).length > 0 && (
            <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>📋 Карточка стратегии</div>
              {cardField("Ступень") && <div><strong>Ступень Ханта:</strong> {cardField("Ступень")}</div>}
              {cardField("Ключевая мысль") && <div><strong>Ключевая мысль:</strong> {cardField("Ключевая мысль")}</div>}
              {cardField("Каркас") && <div><strong>Каркас:</strong> {cardField("Каркас")}</div>}
              {cardField("Триггер") && <div><strong>Триггер:</strong> {cardField("Триггер")}</div>}
              {cardField("CTA") && <div><strong>CTA:</strong> {cardField("CTA")}</div>}
              {cardField("Допущения") && <div><strong>Допущения:</strong> {cardField("Допущения")}</div>}
            </div>
          )}
          {(reel.script_versions || []).length > 0 && reel.selected_script >= 0 && (
            <div style={{ ...s.card, marginBottom: 10 }}>
              <span style={s.label}>Текст выбранной версии (можно править вручную)</span>
              <textarea value={scriptDraft} onChange={e => setScriptDraft(e.target.value)} onBlur={saveScriptEdit} style={{ ...s.field, minHeight: 140 }} rows={7} />
              <button onClick={saveScriptEdit} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 6 }}>Сохранить правки</button>
            </div>
          )}
          {reel.shoot_plan && (
            <div style={{ ...s.card, marginBottom: 10 }}>
              <span style={s.label}>🎬 План съёмки</span>
              <div style={{ fontSize: 11, color: COLORS.brown, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{reel.shoot_plan}</div>
            </div>
          )}
          {hasHooks && (
            <div style={{ ...s.card, marginBottom: 10 }}>
              <span style={s.label}>Хуки (⭐ — финальный)</span>
              {reel.hooks.map((h, i) => (
                <div key={i} onClick={() => onUpdate({ selected_hook: i })} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: i === (reel.selected_hook || 0) ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${i === (reel.selected_hook || 0) ? COLORS.rose : COLORS.brd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 5, cursor: "pointer" }}>
                  <span style={{ fontSize: 12, opacity: i === (reel.selected_hook || 0) ? 1 : .35 }}>⭐</span>
                  <span style={{ fontSize: 12, color: COLORS.brown, lineHeight: 1.4, flex: 1 }}>{h}</span>
                </div>
              ))}
              <button onClick={() => send("3 варианта хука")} disabled={loading} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 4, opacity: loading ? .5 : 1 }}>🔄 Другие варианты</button>
            </div>
          )}
          {hooksError && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{hooksError}</div>
              <button onClick={onAdvance} style={{ ...s.btnOutline, ...s.btnSm }}>Перейти без хуков →</button>
            </div>
          )}
          {hasHooks ? (
            <button onClick={onAdvance} disabled={reel.selected_script < 0} style={{ ...s.btnRose, width: "100%", opacity: reel.selected_script >= 0 ? 1 : .4, cursor: reel.selected_script >= 0 ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              Дальше к Тиму →
            </button>
          ) : (
            <button onClick={requestHooks} disabled={reel.selected_script < 0 || hooksLoading} style={{ ...s.btnRose, width: "100%", opacity: (reel.selected_script >= 0 && !hooksLoading) ? 1 : .4, cursor: (reel.selected_script >= 0 && !hooksLoading) ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {hooksLoading ? "Подбираю хуки..." : "Сценарий согласован — показать хуки →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CAROUSEL STEP ──
function CarouselStep({ reel, profile, onUpdate, onAdvance, standalone }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [coversLoading, setCoversLoading] = useState(false);
  const [coversError, setCoversError] = useState("");
  const [slidesDraft, setSlidesDraft] = useState(reel.script_versions?.[reel.selected_script] || "");
  const chatRef = useRef(null);
  const autoGenRef = useRef(false);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [reel.script_chat]);
  useEffect(() => { setSlidesDraft(reel.script_versions?.[reel.selected_script] || ""); }, [reel.selected_script, reel.script_versions]);

  // Авто-генерация сразу после согласования угла с Идеологом — карусели не
  // нужен доп. вопрос про формат съёмки, поэтому условие проще, чем в ScriptStep.
  useEffect(() => {
    if (autoGenRef.current) return;
    // Quick-started cards (Ася via "Команда") arrive with reveal_text but a
    // deliberately blank topic — reveal_text alone is enough of an idea to
    // generate from, so don't gate on topic when it's present.
    if ((reel.reveal_text || reel.agreed_angle) && !(reel.script_versions || []).length && (reel.topic?.trim() || reel.reveal_text)) {
      autoGenRef.current = true;
      generateFromIdea();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildPacket = () => {
    const lead = reel.lead_magnet_idx != null ? profile.leads?.[reel.lead_magnet_idx] : null;
    const finalSlides = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : "";
    const angleText = reel.reveal_text || (reel.strategy_card
      ? [reel.strategy_card.angle, reel.strategy_card.rationale, reel.strategy_card.funnelRole ? `Роль в воронке: ${reel.strategy_card.funnelRole}` : ""].filter(Boolean).join(". ")
      : (reel.agreed_angle?.angle || ""));
    const packet = createContextPacket({
      agent: "carousel",
      profile: {
        name: profile.name,
        audience: fieldContext(profile, "ca"),
        products: fieldContext(profile, "prod"),
        toneOfVoice: fieldContext(profile, "tov"),
        manualMemory: fieldContext(profile, "memory"),
        learnedMemory: profile.learnedMemory || [],
      },
      content: {
        topic: reel.topic,
        planAnchor: reel.plan_anchor || "",
        platform: "Instagram",
        format: "Карусель",
        huntStage: reel.hunt_stage,
        huntStageHint: reel.hunt_stage ? HUNT_HINTS[reel.hunt_stage] : "",
        agreedAngle: angleText,
        selectedHook: reel.strategy_card?.hook || reel.agreed_angle?.hook || "",
        contentGoal: reel.strategy_card?.contentGoal || "",
        allowedFacts: reel.strategy_card?.allowedFacts || "",
        userConstraints: reel.strategy_card?.userConstraints || "",
        selectedLead: lead ? `${lead.name} (${lead.link})` : "",
        strategyCard: reel.strategy_card || null,
      },
      // Same "script" use-flag as ScriptStep — the two are mutually
      // exclusive per reel (a reel is either video-scripted or a
      // carousel), so materials flagged for "script" apply to whichever
      // one is actually active for this reel.
      materials: profile.materials,
      conversation: {
        recentMessages: (reel.idea_chat || []).filter(m => m.role !== "note"),
        latestUserEdit: finalSlides ? `Текущая карусель (учитывай текущий текст, включая ручные правки пользователя):\n${finalSlides}` : "",
      },
    });
    const coreInstructions = carouselCore({ platform: "Instagram", format: "Карусель" });
    return renderContextPacket(packet, { coreInstructions, stage: "script", requiresMemory: true });
  };

  const send = async (msg) => {
    if (!msg.trim()) return;
    setInput("");
    setLoading(true);
    const { system } = buildPacket();
    const newChat = [...(reel.script_chat || []), { role: "user", content: msg }];
    onUpdate({ script_chat: newChat });
    try {
      const messages = newChat.slice(-6).map(m => ({ role: m.role, content: m.content }));
      const reply = await callAPI(messages, system, 2200, false, "carousel");
      const updatedChat = [...newChat, { role: "assistant", content: reply }];
      let updates = { script_chat: updatedChat };
      const sm = reply.match(/СЛАЙДЫ:([\s\S]+?)(?:ОБЛОЖКИ:|$)/);
      if (sm) {
        const versions = [...(reel.script_versions || []), sm[1].trim()];
        updates.script_versions = versions;
        updates.selected_script = versions.length - 1;
      }
      const om = reply.match(/ОБЛОЖКИ:([\s\S]+)/);
      if (om) {
        // Strip only actual list markers ("1. "/"2) "/"- "/"• ") — a bare
        // leading digit is often real hook content ("3 ошибки..."), not a
        // numbered-list prefix, and must not be eaten.
        const lines = om[1].split("\n").map(l => l.replace(/^(?:[-•]|\d+[.)])\s*/, "")).filter(l => l.trim().length > 5);
        if (lines.length >= 2) updates.hooks = lines.slice(0, 3);
      }
      onUpdate(updates);
    } catch (e) {
      onUpdate({ script_chat: [...newChat, { role: "assistant", content: "Ошибка: " + e.message }] });
    }
    setLoading(false);
  };

  const generateFromIdea = async () => {
    // reel.topic can be blank on a quick-started card — the actual idea is
    // reveal_text, already carried into the system prompt as "Согласованный
    // угол", so the user message just needs to ask for a carousel at all.
    const msg = reel.topic?.trim() ? `Сгенерируй карусель на тему: ${reel.topic}` : "Сгенерируй карусель по тексту выше.";
    await send(msg);
  };

  const saveSlidesEdit = () => {
    if (reel.selected_script < 0 || slidesDraft === reel.script_versions?.[reel.selected_script]) return;
    const versions = [...reel.script_versions];
    versions[reel.selected_script] = slidesDraft;
    onUpdate({ script_versions: versions });
  };

  const requestCovers = async () => {
    setCoversLoading(true);
    setCoversError("");
    const finalSlides = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : "";
    const system = `Ты — автор карусели. Дай минимум 2 варианта текста обложки (первый слайд, крупный текст, до 10 слов) к финальной карусели ниже. Ответь СТРОГО в формате: начни с ОБЛОЖКИ:, каждый вариант отдельной строкой, без другого текста до или после.\n\nКарусель:\n${finalSlides}`;
    try {
      const reply = await callAPI([{ role: "user", content: "Дай варианты обложки к финальной карусели." }], system, 400, false, "carousel");
      const om = reply.match(/ОБЛОЖКИ:([\s\S]+)/);
      const lines = om ? om[1].split("\n").map(l => l.replace(/^(?:[-•]|\d+[.)])\s*/, "").trim()).filter(l => l.length > 5) : [];
      if (lines.length >= 2) {
        onUpdate({ hooks: lines.slice(0, 3), selected_hook: 0 });
      } else {
        setCoversError("Не удалось получить варианты обложки. Можно перейти без них.");
      }
    } catch (e) {
      setCoversError(e.message || "Ошибка запроса");
    }
    setCoversLoading(false);
  };

  const hasCovers = (reel.hooks || []).length > 0;

  // Old cards keep the exact pre-Ася single-column layout — same rationale
  // as ScriptStep above.
  if (!standalone) {
    return (
      <div>
        {!(reel.script_versions || []).length && (
          <div style={{ marginBottom: 14 }}>
            {reel.agreed_angle && (
              <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>✓ Угол согласован с Идеологом</div>
                {reel.topic && <div><strong>Тема:</strong> {reel.topic}</div>}
                {reel.agreed_angle.angle && <div><strong>Угол:</strong> {reel.agreed_angle.angle}</div>}
              </div>
            )}
            <span style={s.label}>Идея (согласована на прошлом шаге — можно поправить)</span>
            <textarea style={{ ...s.field, minHeight: 60 }} rows={3} value={reel.topic || ""} onChange={e => onUpdate({ topic: e.target.value })} placeholder="Тема карусели..." />
            <button onClick={generateFromIdea} disabled={loading || (!reel.topic?.trim() && !reel.reveal_text)} style={{ ...s.btnRose, width: "100%", marginTop: 8, opacity: (loading || (!reel.topic?.trim() && !reel.reveal_text)) ? .5 : 1 }}>
              {loading ? "Генерирую..." : "✦ Сгенерировать карусель"}
            </button>
          </div>
        )}
        {(reel.script_versions || []).length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <span style={s.label}>Версии карусели</span>
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
            <span style={s.label}>Слайды (можно править вручную)</span>
            <textarea value={slidesDraft} onChange={e => setSlidesDraft(e.target.value)} onBlur={saveSlidesEdit} style={{ ...s.field, minHeight: 180 }} rows={9} />
            <button onClick={saveSlidesEdit} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 6 }}>Сохранить правки</button>
          </div>
        )}
        <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 8 }}>{(reel.script_versions || []).length ? "Правки и новые версии — прямо в чате. Каждая версия сохраняется." : "Отредактируй идею выше и нажми «Сгенерировать карусель», или сразу опиши, что нужно, в чате."}</div>
        <div ref={chatRef} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
          {(reel.script_chat || []).map((m, i) => <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>)}
          {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Думаю...</div>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 7 }}>
          {["Напиши с нуля", "Меньше слайдов", "Больше слайдов", "3 варианта обложки", "Усиль обложку", "Живее"].map(q => (
            <button key={q} onClick={() => send(q)} style={{ background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: COLORS.brownS, cursor: "pointer" }}>{q}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Черновик или правки по карусели..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
          <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
        </div>
        {hasCovers && (
          <div style={{ marginTop: 12 }}>
            <div style={{ height: 1, background: COLORS.brd, margin: "12px 0" }} />
            <span style={s.label}>Варианты обложки (⭐ — финальный)</span>
            {reel.hooks.map((h, i) => (
              <div key={i} onClick={() => onUpdate({ selected_hook: i })} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: i === (reel.selected_hook || 0) ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${i === (reel.selected_hook || 0) ? COLORS.rose : COLORS.brd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 5, cursor: "pointer" }}>
                <span style={{ fontSize: 12, opacity: i === (reel.selected_hook || 0) ? 1 : .35 }}>⭐</span>
                <span style={{ fontSize: 12, color: COLORS.brown, lineHeight: 1.4, flex: 1 }}>{h}</span>
              </div>
            ))}
            <button onClick={() => send("3 варианта обложки")} disabled={loading} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 4, opacity: loading ? .5 : 1 }}>🔄 Другие варианты</button>
          </div>
        )}
        <div style={{ height: 1, background: COLORS.brd, margin: "14px 0 10px" }} />
        {coversError && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{coversError}</div>
            <button onClick={onAdvance} style={{ ...s.btnOutline, ...s.btnSm }}>Перейти без вариантов обложки →</button>
          </div>
        )}
        {hasCovers ? (
          <button onClick={onAdvance} disabled={reel.selected_script < 0} style={{ ...s.btnRose, width: "100%", opacity: reel.selected_script >= 0 ? 1 : .4, cursor: reel.selected_script >= 0 ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            Дальше к Копирайтеру →
          </button>
        ) : (
          <button onClick={requestCovers} disabled={reel.selected_script < 0 || coversLoading} style={{ ...s.btnRose, width: "100%", opacity: (reel.selected_script >= 0 && !coversLoading) ? 1 : .4, cursor: (reel.selected_script >= 0 && !coversLoading) ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            {coversLoading ? "Подбираю варианты..." : "Карусель готова — варианты обложки →"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <img src="/agents/asya.png" alt="Ася" style={{ width: 48, height: 48, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ fontSize: 18, fontWeight: 800 }}>Ася — карусели</div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <Badge bg={COLORS.blueL} color={COLORS.blue}>{PLATFORMS.ig.icon} Instagram · Карусель</Badge>
        {reel.hunt_stage ? <Badge bg={COLORS.roseL} color={COLORS.rose}>Ступень {reel.hunt_stage}</Badge> : null}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0.85 1 280px", minWidth: 280 }}>
          <div style={{ ...s.card, display: "flex", flexDirection: "column", minHeight: "60vh" }}>
            {reel.reveal_text && (
              <div style={{ background: COLORS.roseP, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", marginBottom: 8, fontSize: 11, color: COLORS.brown, lineHeight: 1.5, flexShrink: 0 }}>
                <div style={{ fontWeight: 700, marginBottom: 3, color: COLORS.rose }}>От Лео</div>
                <div>{reel.reveal_text.slice(0, 150)}{reel.reveal_text.length > 150 ? "…" : ""}</div>
              </div>
            )}
            <div ref={chatRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", marginBottom: 8 }}>
              {!(reel.script_chat || []).length && <div style={{ fontSize: 11, color: COLORS.brownS, fontStyle: "italic" }}>Отредактируй идею справа и нажми «Сгенерировать карусель», или сразу опиши, что нужно, здесь.</div>}
              {(reel.script_chat || []).map((m, i) => <div key={i} style={s.chatMsg(m.role)}><MsgText text={m.content} /></div>)}
              {loading && <div style={{ ...s.chatMsg("assistant"), opacity: .6, fontStyle: "italic" }}>Думаю...</div>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 7 }}>
              {["Напиши с нуля", "Меньше слайдов", "Больше слайдов", "3 варианта обложки", "Усиль обложку", "Живее"].map(q => (
                <button key={q} onClick={() => send(q)} style={{ background: COLORS.cream, border: `1.5px solid ${COLORS.brd}`, borderRadius: 20, padding: "3px 9px", fontSize: 10, color: COLORS.brownS, cursor: "pointer" }}>{q}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} placeholder="Черновик или правки по карусели..." rows={1} style={{ ...s.field, flex: 1, minHeight: 38, maxHeight: 90 }} />
              <button onClick={() => send(input)} disabled={loading} style={{ ...s.btnRose, width: 36, height: 36, padding: 0, flexShrink: 0, opacity: loading ? .4 : 1 }}>→</button>
            </div>
          </div>
        </div>

        <div style={{ flex: "1.15 1 340px", minWidth: 280 }}>
          {!(reel.script_versions || []).length && (
            <div style={{ ...s.card, marginBottom: 14 }}>
              {reel.agreed_angle && (
                <div style={{ background: COLORS.purpleL, border: `1.5px solid #C4B5FD`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, fontSize: 11, color: COLORS.purple, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700, marginBottom: 3 }}>✓ Угол согласован с Идеологом</div>
                  {reel.topic && <div><strong>Тема:</strong> {reel.topic}</div>}
                  {reel.agreed_angle.angle && <div><strong>Угол:</strong> {reel.agreed_angle.angle}</div>}
                </div>
              )}
              <span style={s.label}>Идея (согласована на прошлом шаге — можно поправить)</span>
              <textarea style={{ ...s.field, minHeight: 60 }} rows={3} value={reel.topic || ""} onChange={e => onUpdate({ topic: e.target.value })} placeholder="Тема карусели..." />
              <button onClick={generateFromIdea} disabled={loading || (!reel.topic?.trim() && !reel.reveal_text)} style={{ ...s.btnRose, width: "100%", marginTop: 8, opacity: (loading || (!reel.topic?.trim() && !reel.reveal_text)) ? .5 : 1 }}>
                {loading ? "Генерирую..." : "✦ Сгенерировать карусель"}
              </button>
            </div>
          )}
          {(reel.script_versions || []).length > 0 && (
            <div style={{ ...s.card, marginBottom: 10 }}>
              <span style={s.label}>Версии карусели</span>
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
            <div style={{ ...s.card, marginBottom: 10 }}>
              {/* Slides are still one edited text block, same as generation
                  always produced — the mockup's "cover as its own block on
                  top" would need parsing slide boundaries out of that text,
                  which isn't part of the data model today and the mockup
                  image wasn't included with this ТЗ to verify a safe split
                  against. Left as one block rather than guessing a parse
                  that could silently mangle real carousels. */}
              <span style={s.label}>Слайды (можно править вручную)</span>
              <textarea value={slidesDraft} onChange={e => setSlidesDraft(e.target.value)} onBlur={saveSlidesEdit} style={{ ...s.field, minHeight: 180 }} rows={9} />
              <button onClick={saveSlidesEdit} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 6 }}>Сохранить правки</button>
            </div>
          )}
          {hasCovers && (
            <div style={{ ...s.card, marginBottom: 10 }}>
              <span style={s.label}>Варианты обложки (⭐ — финальный)</span>
              {reel.hooks.map((h, i) => (
                <div key={i} onClick={() => onUpdate({ selected_hook: i })} style={{ display: "flex", alignItems: "flex-start", gap: 7, background: i === (reel.selected_hook || 0) ? COLORS.roseP : COLORS.cream, border: `1.5px solid ${i === (reel.selected_hook || 0) ? COLORS.rose : COLORS.brd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 5, cursor: "pointer" }}>
                  <span style={{ fontSize: 12, opacity: i === (reel.selected_hook || 0) ? 1 : .35 }}>⭐</span>
                  <span style={{ fontSize: 12, color: COLORS.brown, lineHeight: 1.4, flex: 1 }}>{h}</span>
                </div>
              ))}
              <button onClick={() => send("3 варианта обложки")} disabled={loading} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 4, opacity: loading ? .5 : 1 }}>🔄 Другие варианты</button>
            </div>
          )}
          {coversError && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>{coversError}</div>
              <button onClick={onAdvance} style={{ ...s.btnOutline, ...s.btnSm }}>Перейти без вариантов обложки →</button>
            </div>
          )}
          {hasCovers ? (
            <button onClick={onAdvance} disabled={reel.selected_script < 0} style={{ ...s.btnRose, width: "100%", opacity: reel.selected_script >= 0 ? 1 : .4, cursor: reel.selected_script >= 0 ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              Дальше к Тиму →
            </button>
          ) : (
            <button onClick={requestCovers} disabled={reel.selected_script < 0 || coversLoading} style={{ ...s.btnRose, width: "100%", opacity: (reel.selected_script >= 0 && !coversLoading) ? 1 : .4, cursor: (reel.selected_script >= 0 && !coversLoading) ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {coversLoading ? "Подбираю варианты..." : "Карусель готова — варианты обложки →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── COPY STEP ──
function CopyStep({ reel, profile, onUpdate, onAdvance, standalone }) {
  const [loading, setLoading] = useState(false);

  // No lead magnet is genuinely better than the wrong one — an irrelevant
  // lead magnet CTA reads as spam. The old code fell back to leads?.[0]
  // when nothing matched the Hunt stage; that's gone.
  const getLead = () => {
    if (reel.lead_magnet_idx != null) return profile.leads?.[reel.lead_magnet_idx];
    return profile.leads?.find(l => {
      const h = String(reel.hunt_stage);
      if (l.hunt === "all") return true;
      if (l.hunt === "1-2" && (h === "1" || h === "2")) return true;
      if (l.hunt === "3" && h === "3") return true;
      if (l.hunt === "4-5" && (h === "4" || h === "5")) return true;
      return false;
    });
  };
  const leadText = (lead) => lead ? `${lead.name} · ${lead.link}${lead.desc ? ` · ${lead.desc}` : ""}` : "";

  // When CopyStep is reached directly from Лео (non-video, non-carousel
  // formats skip ScriptStep/CarouselStep entirely — see LeoStep.submit) —
  // reveal_text is the actual draft to adapt, not just background context,
  // so it has to feed the primary generation input here too, not only
  // angleText() below.
  const script = reel.selected_script >= 0 ? reel.script_versions?.[reel.selected_script] : (reel.reveal_text || reel.topic);
  const sourceIsVideo = VIDEO_FORMATS.includes(reel.format);
  const baseFmts = { ig: '{"caption":"...","cta":"..."}', yt: '{"title":"...","description":"...","tags":["..."]}', tg: '{"caption":"..."}', tt: '{"overlay":"...","caption":"..."}', th: '{"text":"...","link_comment":"..."}', vk: '{"caption":"..."}' };
  const scriptFmts = { tt: '{"script":"...","overlay":"...","caption":"..."}', yt: '{"script":"...","title":"...","description":"...","tags":["..."]}' };

  const angleText = () => reel.reveal_text || (reel.strategy_card
    ? [reel.strategy_card.angle, reel.strategy_card.rationale, reel.strategy_card.funnelRole ? `Роль в воронке: ${reel.strategy_card.funnelRole}` : ""].filter(Boolean).join(". ")
    : (reel.agreed_angle?.angle || ""));

  const commonPacketArgs = (lead) => ({
    profile: {
      name: profile.name,
      audience: fieldContext(profile, "ca"),
      products: fieldContext(profile, "prod"),
      toneOfVoice: fieldContext(profile, "tov"),
      manualMemory: fieldContext(profile, "memory"),
      learnedMemory: profile.learnedMemory || [],
    },
    content: {
      topic: reel.topic,
      planAnchor: reel.plan_anchor || "",
      format: reel.format,
      huntStage: reel.hunt_stage,
      huntStageHint: reel.hunt_stage ? HUNT_HINTS[reel.hunt_stage] : "",
      agreedAngle: angleText(),
      selectedHook: reel.strategy_card?.hook || reel.agreed_angle?.hook || "",
      contentGoal: reel.strategy_card?.contentGoal || "",
      allowedFacts: reel.strategy_card?.allowedFacts || "",
      userConstraints: reel.strategy_card?.userConstraints || "",
      selectedLead: leadText(lead),
      strategyCard: reel.strategy_card || null,
    },
    materials: profile.materials,
    // The final script/carousel text is sent as the user-message content
    // below (as it always was) — this only carries cross-agent context
    // (the discussion that shaped the final text isn't part of it).
    conversation: { recentMessages: (reel.script_chat || []) },
  });

  const buildPacket = (key) => {
    const platInstr = (profile.platInstr || DEFAULT_PLAT_INSTR)[key] || DEFAULT_PLAT_INSTR[key] || "";
    const fullScript = copyNeedsFullScript(key, reel.format, sourceIsVideo);
    const lead = getLead();
    const packet = createContextPacket({ agent: "copywriter", ...commonPacketArgs(lead), content: { ...commonPacketArgs(lead).content, platform: PLATFORMS[key]?.name } });
    const coreInstructions = copywriterCore({ key, platformName: PLATFORMS[key]?.name, platformInstr: platInstr, format: reel.format, sourceIsVideo });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "copy", requiresMemory: true });
    return { system, lead, fullScript };
  };

  const buildAllPacket = () => {
    const lead = getLead();
    const instrBlock = Object.entries(profile.platInstr || DEFAULT_PLAT_INSTR).map(([k, v]) => `${PLATFORMS[k]?.name}: ${v}`).join("\n\n");
    const packet = createContextPacket({ agent: "copywriter", ...commonPacketArgs(lead) });
    const coreInstructions = copywriterAllPlatformsCore({ instrBlock, format: reel.format, sourceIsVideo });
    const { system } = renderContextPacket(packet, { coreInstructions, stage: "copy", requiresMemory: true });
    return { system, lead };
  };

  const genMain = async () => {
    setLoading(true);
    const key = reel.platform;
    const { system, lead, fullScript } = buildPacket(key);
    const fmt = fullScript ? (scriptFmts[key] || baseFmts[key]) : baseFmts[key];
    try {
      const raw = await callAPI([{ role: "user", content: `Напиши описание для ${PLATFORMS[key]?.name}.\n\nСценарий: ${script}\nЗаметки: ${reel.notes || "нет"}\n${lead ? `Лид-магнит: ${leadText(lead)}` : "Лид-магнит не выбран — не упоминай его и не ссылайся на него в CTA."}\n\nJSON: ${fmt}` }], system, fullScript ? 1800 : 1000, false, "copywriter");
      const parsed = parseJSON(raw);
      onUpdate({ copy: { ...(reel.copy || {}), [key]: parsed } });
    } catch (e) { alert("Ошибка: " + e.message); }
    setLoading(false);
  };

  const adaptAll = async () => {
    setLoading(true);
    const { system, lead } = buildAllPacket();
    const jsonShape = sourceIsVideo
      ? `{"ig":{"caption":"...","cta":"..."},"yt":{"title":"...","description":"...","tags":["..."]},"tg":{"caption":"..."},"tt":{"overlay":"...","caption":"..."},"th":{"text":"...","link_comment":"..."},"vk":{"caption":"..."}}`
      : `{"ig":{"caption":"...","cta":"..."},"yt":{"script":"...","title":"...","description":"...","tags":["..."]},"tg":{"caption":"..."},"tt":{"script":"...","overlay":"...","caption":"..."},"th":{"text":"...","link_comment":"..."},"vk":{"caption":"..."}}`;
    try {
      const raw = await callAPI([{ role: "user", content: `Адаптируй под все площадки.\nСценарий: ${script}\nЗаметки: ${reel.notes || "нет"}\n${lead ? `Лид-магнит: ${leadText(lead)}` : "Лид-магнит не выбран — не упоминай его и не ссылайся на него в CTA."}\n\nJSON:\n${jsonShape}` }], system, sourceIsVideo ? 3000 : 4000, false, "copywriter");
      const parsed = parseJSON(raw);
      onUpdate({ copy: { ...(reel.copy || {}), ...parsed } });
    } catch (e) { alert("Ошибка: " + e.message); }
    setLoading(false);
  };

  const regenPlat = async (key) => {
    setLoading(true);
    const { system, lead, fullScript } = buildPacket(key);
    const fmt = fullScript ? (scriptFmts[key] || baseFmts[key]) : baseFmts[key];
    try {
      const raw = await callAPI([{ role: "user", content: `Текст для ${PLATFORMS[key]?.name}.\nСценарий: ${script}\n${lead ? `Лид-магнит: ${leadText(lead)}` : "Лид-магнит не выбран — не упоминай его и не ссылайся на него в CTA."}\n\nJSON: ${fmt}` }], system, fullScript ? 1600 : 900, false, "copywriter");
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
  // CopyStep never had a chat/send flow (only button-triggered generation)
  // — the ТЗ's "слева чат" would mean inventing a new conversational call,
  // which the "не меняется логика генерации" constraint rules out. Shown
  // instead: a handoff plaque from whichever agent produced the source
  // text, same visual slot as Кира/Ася's "от Лео" plaque.
  const isCarousel = reel.format === "Карусель";
  const handoffLabel = isCarousel ? "От Аси" : (reel.script_versions?.length ? "От Киры" : "От Лео");

  // Old cards keep the exact pre-Тим single-column layout — same rationale
  // as ScriptStep/CarouselStep above.
  if (!standalone) {
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <img src="/agents/tim.png" alt="Тим" style={{ width: 48, height: 48, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ fontSize: 18, fontWeight: 800 }}>Тим — тексты для площадок</div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <Badge bg={COLORS.blueL} color={COLORS.blue}>{PLATFORMS[reel.platform]?.icon} {PLATFORMS[reel.platform]?.name} · {reel.format}</Badge>
        {reel.hunt_stage ? <Badge bg={COLORS.roseL} color={COLORS.rose}>Ступень {reel.hunt_stage}</Badge> : null}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0.85 1 280px", minWidth: 280 }}>
          <div style={s.card}>
            {script && (
              <div style={{ background: COLORS.roseP, border: `1.5px solid ${COLORS.brd}`, borderRadius: 9, padding: "9px 11px", fontSize: 11, color: COLORS.brown, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 3, color: COLORS.rose }}>{handoffLabel}</div>
                <div>{script.slice(0, 150)}{script.length > 150 ? "…" : ""}</div>
              </div>
            )}
            <div style={{ fontSize: 11, color: COLORS.brownS, marginTop: 10 }}>Копирайтер напишет по структуре: описание / полезность / лид-магнит + CTA. Правки — кнопкой ↺ на карточке нужной площадки справа.</div>
          </div>
        </div>

        <div style={{ flex: "1.15 1 340px", minWidth: 280 }}>
          {loading && <div style={{ height: 3, background: COLORS.brd, borderRadius: 2, overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", background: `linear-gradient(90deg,${COLORS.rose},#F472B6)`, animation: "lp 1.6s ease-in-out infinite" }} /></div>}
          <div style={{ marginBottom: 10, display: "flex", gap: 7, flexWrap: "wrap" }}>
            <button style={{ ...s.btnRose, ...s.btnSm }} onClick={genMain} disabled={loading}>✦ Написать тексты</button>
            <button style={{ ...s.btnOutline, ...s.btnSm }} onClick={adaptAll} disabled={loading}>⇄ Все площадки</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
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
          {onAdvance && (
            <button onClick={onAdvance} style={{ ...s.btnRose, width: "100%" }}>Готово — к заметкам →</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── NOTES STEP ──
function NotesStep({ reel, profile, onUpdate, onUpdateProfile, onDeleteRequest, standalone, onBack }) {
  // Old cards keep getting the status bar from CardModal's own shared
  // chrome — only render it here when this screen has to stand on its own
  // (isNewCard), per the ТЗ's "перенеси статус-бар на экран «Заметки»".
  const statusIdx = STATUSES.findIndex(st => st.key === reel.status);
  const [memorySaved, setMemorySaved] = useState(false);

  // Turns "Реакции аудитории" from a write-only field into something the
  // "идут в следующий цикл" caption below actually means: learnedMemory is
  // already read by every agent's TOV/memory block (contextBuilder.js) — it
  // just never had anything writing to it before.
  const saveReactionsToMemory = () => {
    if (!reel.reactions?.trim() || !onUpdateProfile) return;
    const entry = { rule: `По теме «${reel.topic || "без темы"}»: ${reel.reactions.trim()}` };
    onUpdateProfile({ learnedMemory: [...(profile?.learnedMemory || []), entry] });
    setMemorySaved(true);
  };

  return (
    <div>
      {standalone && (
        <>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>Заметки</div>
          <div style={{ fontSize: 11, color: COLORS.brownS, marginBottom: 14 }}>{reel.topic || "Без темы"} · {PLATFORMS[reel.platform]?.icon} {PLATFORMS[reel.platform]?.name} · {reel.format}</div>
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
          {onBack && <button onClick={onBack} style={{ ...s.btnOutline, ...s.btnSm, marginBottom: 14 }}>← Назад к Тиму</button>}
        </>
      )}
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
        <div style={{ fontSize: 10, color: COLORS.blue, marginBottom: 5 }}>Комментарии, вопросы — сохрани кнопкой ниже, и агенты будут учитывать это в следующих генерациях для этой ниши</div>
        <textarea style={{ ...s.field, minHeight: 50, background: "#fff" }} rows={2} value={reel.reactions || ""} onChange={e => { onUpdate({ reactions: e.target.value }); setMemorySaved(false); }} placeholder="Что писали в комментариях?..." />
        {onUpdateProfile && (
          <button onClick={saveReactionsToMemory} disabled={!reel.reactions?.trim() || memorySaved} style={{ ...s.btnOutline, ...s.btnSm, marginTop: 7, opacity: (!reel.reactions?.trim() || memorySaved) ? .5 : 1 }}>
            {memorySaved ? "✓ Сохранено — учтётся в следующих генерациях" : "🧠 Сохранить как вывод на будущее"}
          </button>
        )}
      </div>
      <div style={{ height: 1, background: COLORS.brd, margin: "12px 0" }} />
      <button onClick={onDeleteRequest} style={{ ...s.btnOutline, fontSize: 11, color: "#DC2626", borderColor: "#FECACA" }}>Удалить ролик</button>
    </div>
  );
}
