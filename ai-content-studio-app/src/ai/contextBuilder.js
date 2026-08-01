// ── CONTEXT BUILDER ──────────────────────────────────────────────────────
// Single place responsible for turning "everything we know about the niche
// and the current task" into a system prompt that fits comfortably under
// the backend's safety ceiling (see api/generate.js) WITHOUT ever silently
// dropping the things that make an answer usable: the agent's own
// instructions, the response format, the current topic, the agreed angle,
// the Hunt stage, and the user's latest edit.
//
// Design in one sentence: guaranteed content is assembled separately and
// never passed through any truncation step; everything else is trimmed
// section-by-section, in priority order, with a fixed budget per section —
// so a long TOV document can never crowd out a long materials document (or
// vice versa) the way the old order-dependent buildMaterialsCtx did.

// ── low-level text helpers ──────────────────────────────────────────────

// Cuts at the nearest paragraph/sentence break instead of mid-word.
export function smartTruncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  if (maxChars <= 0) return "";
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return (lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak + 1) : cut) + "…";
}

// Picks excerpts from a long document. Prefers paragraphs that mention the
// current topic/product/pain/Hunt-stage keywords; if nothing scores (or the
// document has no paragraph breaks to score), falls back to even chunks
// from the start, middle and end rather than just the start — a single
// long doc should never look like "whatever came first in the file".
function selectExcerpts(text, cap, keywords = []) {
  if (text.length <= cap) return { text, truncated: false, method: null };
  if (cap <= 0) return { text: "", truncated: true, method: "dropped" };

  const cleanKeywords = keywords.map((k) => (k || "").toLowerCase().trim()).filter((k) => k.length >= 3);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());

  if (cleanKeywords.length && paragraphs.length > 1) {
    const scored = paragraphs.map((p, i) => {
      const lower = p.toLowerCase();
      const score = cleanKeywords.reduce((sum, kw) => sum + (lower.includes(kw) ? 1 : 0), 0);
      return { p, i, score };
    });
    if (scored.some((x) => x.score > 0)) {
      const picked = [];
      let used = 0;
      for (const item of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
        if (item.score === 0) break;
        if (used + item.p.length > cap) continue;
        picked.push(item);
        used += item.p.length;
        if (used >= cap * 0.92) break;
      }
      if (picked.length) {
        picked.sort((a, b) => a.i - b.i);
        return { text: picked.map((x) => x.p).join("\n\n"), truncated: true, method: "relevance" };
      }
    }
  }

  // Fallback: relevance couldn't be determined — sample start / middle / end
  // instead of only the start, so the important part of a long doc isn't
  // dropped just because it happens to sit in the second half.
  const third = Math.max(1, Math.floor(cap / 3));
  const start = text.slice(0, third);
  const midStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(third / 2));
  const middle = text.slice(midStart, midStart + third);
  const end = text.slice(Math.max(0, text.length - third));
  return { text: `${start}\n[…]\n${middle}\n[…]\n${end}`, truncated: true, method: "even-thirds" };
}

// ── materials section (replaces buildMaterialsCtx) ──────────────────────

// Every material flagged for this stage gets a fair, non-zero share of the
// budget (split evenly, floor guaranteed) — no more "first N materials in
// array order, rest silently skipped".
export function buildMaterialsSection(materials, stage, { keywords = [], budget = 6000, perMaterialMin = 300 } = {}) {
  const relevant = (materials || []).filter((m) => m && m.use && m.use[stage] && m.text);
  if (!relevant.length) return { text: "", meta: [] };

  const perMaterialCap = Math.max(perMaterialMin, Math.floor(budget / relevant.length));
  const meta = [];
  const blocks = relevant.map((m) => {
    const { text: excerpt, truncated, method } = selectExcerpts(m.text, perMaterialCap, keywords);
    const methodLabel = method === "relevance" ? "релевантные фрагменты" : method === "even-thirds" ? "фрагменты начала/середины/конца" : null;
    const label = truncated ? `${(m.name || "материал").toUpperCase()} [СОКРАЩЕНО${methodLabel ? " — " + methodLabel : ""}]` : (m.name || "материал").toUpperCase();
    meta.push({
      name: m.name || "материал",
      truncated,
      method: truncated ? method : null,
      includedChars: excerpt.length,
      originalChars: m.text.length,
    });
    // Excerpt is quoted as-is from the source — the prompt-level instruction
    // (in each agent's coreInstructions) tells the model not to blend it
    // with invented continuation.
    return `=== ${label} ===\n${excerpt}`;
  });

  return { text: blocks.join("\n\n"), meta };
}

// ── conversation section ─────────────────────────────────────────────────

// History is the lowest priority and is trimmed first (smallest budget of
// all sections) — but the user's most recent edit is carried separately and
// is never dropped, even if that means every older message gets cut.
function buildConversationSection(conversation = {}, budget = 1800) {
  const { recentMessages = [], latestUserEdit = "" } = conversation;
  if (!recentMessages.length && !latestUserEdit) return { text: "", meta: { messagesIncluded: 0, messagesTotal: 0, latestEditIncluded: false } };

  const editBlock = latestUserEdit ? `ПОСЛЕДНЯЯ ПРАВКА ПОЛЬЗОВАТЕЛЯ (обязательно учти, это приоритетнее старых сообщений):\n${latestUserEdit}` : "";
  const remainingBudget = Math.max(0, budget - editBlock.length - (editBlock ? 20 : 0));

  const picked = [];
  let used = 0;
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i];
    if (!m || !m.content) continue;
    const speaker = m.role === "user" ? "Пользователь" : "Агент";
    const line = `${speaker}: ${m.content}`;
    if (used + line.length > remainingBudget) {
      if (picked.length === 0 && remainingBudget > 40) {
        picked.unshift(`${speaker}: ${smartTruncate(m.content, remainingBudget - speaker.length - 2)}`);
      }
      break;
    }
    picked.unshift(line);
    used += line.length + 1;
  }

  const historyText = picked.join("\n");
  return {
    text: [historyText, editBlock].filter(Boolean).join("\n\n"),
    meta: { messagesIncluded: picked.length, messagesTotal: recentMessages.length, latestEditIncluded: !!latestUserEdit },
  };
}

// ── fixed decisions (guaranteed, never trimmed) ─────────────────────────

// These are the facts that must survive every handoff between agents
// without being re-derived, re-guessed, or silently dropped when history
// gets cut. Empty fields are simply omitted.
export function serializeFixedDecisions(fd = {}) {
  const lines = [];
  if (fd.topic) lines.push(`Тема: ${fd.topic}`);
  if (fd.planAnchor) lines.push(`Опора из контент-плана: ${fd.planAnchor}`);
  if (fd.audienceSegment) lines.push(`Сегмент аудитории: ${fd.audienceSegment}`);
  if (fd.huntStage != null && fd.huntStage !== "" && fd.huntStage !== 0) {
    lines.push(`Этап Ханта: ${fd.huntStage}${fd.huntStageHint ? ` (${fd.huntStageHint})` : ""}`);
  }
  if (fd.contentGoal) lines.push(`Цель материала: ${fd.contentGoal}`);
  if (fd.agreedAngle) lines.push(`Согласованный угол (приоритетный источник — следуй строго ему):\n${fd.agreedAngle}`);
  if (fd.agreedHook) lines.push(`Согласованный хук: ${fd.agreedHook}`);
  if (fd.allowedFacts) {
    const facts = Array.isArray(fd.allowedFacts) ? fd.allowedFacts.join("; ") : fd.allowedFacts;
    if (facts) lines.push(`Разрешено использовать эти факты/кейсы (не выдумывай других): ${facts}`);
  }
  if (fd.selectedLead) lines.push(`Выбранный лид-магнит: ${fd.selectedLead}`);
  if (fd.userConstraints) {
    const c = Array.isArray(fd.userConstraints) ? fd.userConstraints.join("; ") : fd.userConstraints;
    if (c) lines.push(`Запреты и правки пользователя (обязательны к соблюдению): ${c}`);
  }
  if (!lines.length) return "";
  return `=== ЗАФИКСИРОВАННЫЕ РЕШЕНИЯ (не переопределять без явной причины) ===\n${lines.join("\n")}`;
}

function serializeLearnedMemory(learnedMemory) {
  if (!Array.isArray(learnedMemory) || !learnedMemory.length) return "";
  const lines = learnedMemory.map((r) => `— ${typeof r === "string" ? r : r.rule}`).filter(Boolean);
  if (!lines.length) return "";
  return `Выводы из практики (подтверждены пользователем ранее, используй как ориентир, не как жёсткий шаблон):\n${lines.join("\n")}`;
}

// ── the structured contextPacket, per the shared shape used by every agent ─

// agent: "ideologist" | "trend_researcher" | "scriptwriter" | "carousel" | "copywriter" | "plan"
export function createContextPacket({
  agent,
  profile = {},
  content = {},
  materials = [],
  conversation = {},
}) {
  return {
    agent,
    profile: {
      name: profile.name || "",
      audience: profile.audience || "",
      products: profile.products || "",
      toneOfVoice: profile.toneOfVoice || "",
      manualMemory: profile.manualMemory || "",
      learnedMemory: profile.learnedMemory || [],
    },
    content: {
      topic: content.topic || "",
      planAnchor: content.planAnchor || "",
      platform: content.platform || "",
      format: content.format || "",
      huntStage: content.huntStage ?? null,
      huntStageHint: content.huntStageHint || "",
      contentGoal: content.contentGoal || "",
      agreedAngle: content.agreedAngle || "",
      selectedHook: content.selectedHook || "",
      strategyCard: content.strategyCard || null,
      selectedLead: content.selectedLead || "",
      notes: content.notes || "",
      reactions: content.reactions || "",
      allowedFacts: content.allowedFacts || "",
      userConstraints: content.userConstraints || "",
    },
    materials: materials || [],
    conversation: {
      recentMessages: conversation.recentMessages || [],
      latestUserEdit: conversation.latestUserEdit || "",
    },
  };
}

const DEFAULT_BUDGETS = {
  tovMemory: 3000,
  audienceProduct: 1800,
  materials: 6000,
  conversationHistory: 1800,
};

// requiresMemory=true for ideologist / scriptwriter / carousel / copywriter
// per the spec — trend_researcher and plan don't need per-post TOV/memory.
export function renderContextPacket(packet, { coreInstructions, stage, keywords = [], requiresMemory = true, budgets = {} } = {}) {
  const B = { ...DEFAULT_BUDGETS, ...budgets };
  const { profile, content, materials, conversation } = packet;

  const fixedBlock = serializeFixedDecisions({
    topic: content.topic,
    planAnchor: content.planAnchor,
    audienceSegment: content.strategyCard?.audienceSegment,
    huntStage: content.huntStage,
    huntStageHint: content.huntStageHint,
    contentGoal: content.contentGoal,
    agreedAngle: content.agreedAngle,
    agreedHook: content.selectedHook,
    allowedFacts: content.allowedFacts,
    selectedLead: content.selectedLead,
    userConstraints: content.userConstraints,
  });
  const coreBlock = [(coreInstructions || "").trim(), fixedBlock].filter(Boolean).join("\n\n");

  let tovMemoryBlock = "";
  if (requiresMemory) {
    const tov = smartTruncate(profile.toneOfVoice, Math.floor(B.tovMemory * 0.5));
    const learned = serializeLearnedMemory(profile.learnedMemory);
    const memoryCombined = smartTruncate([profile.manualMemory, learned].filter(Boolean).join("\n\n"), Math.floor(B.tovMemory * 0.5));
    const parts = [];
    if (tov) parts.push(`TOV:\n${tov}`);
    if (memoryCombined) parts.push(`ПАМЯТЬ:\n${memoryCombined}`);
    if (parts.length) tovMemoryBlock = `=== TOV И ПАМЯТЬ ===\n${parts.join("\n\n")}`;
  }

  const audienceTrimmed = smartTruncate(profile.audience, Math.floor(B.audienceProduct * 0.5));
  const productsTrimmed = smartTruncate(profile.products, Math.floor(B.audienceProduct * 0.5));
  const audienceProductParts = [audienceTrimmed && `ЦА:\n${audienceTrimmed}`, productsTrimmed && `ПРОДУКТ:\n${productsTrimmed}`].filter(Boolean);
  const audienceProductBlock = audienceProductParts.length ? `=== АУДИТОРИЯ И ПРОДУКТ ===\n${audienceProductParts.join("\n\n")}` : "";

  const materialKeywords = [content.topic, content.agreedAngle, content.contentGoal, ...keywords].filter(Boolean);
  const { text: materialsText, meta: materialsMeta } = buildMaterialsSection(materials, stage, { keywords: materialKeywords, budget: B.materials });
  const materialsBlock = materialsText ? `=== МАТЕРИАЛЫ ===\n${materialsText}` : "";

  const { text: conversationText, meta: conversationMeta } = buildConversationSection(conversation, B.conversationHistory);
  const conversationBlock = conversationText ? `=== ИСТОРИЯ ОБСУЖДЕНИЯ ===\n${conversationText}` : "";

  const system = [coreBlock, tovMemoryBlock, audienceProductBlock, materialsBlock, conversationBlock].filter(Boolean).join("\n\n");

  const warnings = [];
  if (requiresMemory && !tovMemoryBlock && (profile.toneOfVoice || profile.manualMemory?.length)) {
    warnings.push("TOV/память заданы в профиле, но не попали в промпт — проверьте бюджет.");
  }
  if (system.length > 32000) {
    warnings.push("System prompt приближается к серверному лимиту (40000 симв.) — проверьте объём материалов.");
  }

  return {
    system,
    meta: {
      agent: packet.agent,
      stage,
      systemChars: system.length,
      coreChars: coreBlock.length,
      tovMemoryIncluded: !!tovMemoryBlock,
      materials: materialsMeta,
      conversation: conversationMeta,
      warnings,
    },
  };
}
