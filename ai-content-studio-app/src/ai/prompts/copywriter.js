// Копирайтер — platform description writer. Unlike the other agents this
// one's instructions genuinely depend on structural facts (is the target
// platform's description physically separate from the video? was the
// source content itself a video?), so buildCoreInstructions takes those
// as params instead of being one fixed block of text.

// tt/yt always show their description separate from the video regardless
// of the source reel's own format; ig only does when the reel itself is a
// Reels (i.e. exactly the case where sourceIsVideo is also true) — so ig
// can structurally never need a full video script written for it here.
export function isVideoAdjacentPlatform(key, format) {
  return key === "tt" || key === "yt" || (key === "ig" && format === "Reels");
}

export function needsFullScript(key, format, sourceIsVideo) {
  return isVideoAdjacentPlatform(key, format) && !sourceIsVideo;
}

function bonusStructureInstr(key, format) {
  return isVideoAdjacentPlatform(key, format)
    ? `Описание физически отдельно от видео — не пересказывай видео/карусель в описании. Структура: 1) короткая зацепка, обещающая доп. пользу (например "сохрани", "вот 5 способов") 2) самостоятельная бонусная польза — конкретный список/чек-лист/лайфхак, которого НЕТ в самом видео, основанный только на продуктах/материалах из контекста выше, не выдумывай 3) CTA по ступени Ханта: 1-2 — просто польза + "сохрани", без давления и без "сохрани"/"подпишись" если для этого нет реальной причины в тексте; 3 — интерес к методу; 4-5 — бонус ведёт к лид-магниту/офферу.`
    : `Структура: 1. Описание о чём материал (не пересказ дословно) 2. Полезность, основанная на продуктах/материалах из контекста, не выдумывай 3. Лид-магнит (если выбран) + CTA.`;
}

const fullScriptInstr = `Исходный контент не был видео-форматом — помимо описания напиши ПОЛНЫЙ сценарий для видео (поле script): хук (3 сек, до 12 слов: шок-факт/цифра/незаконченная мысль/вопрос в боль) → было плохо (конкретная деталь) → перелом → стало так (результат) → CTA по ступени Ханта. Длина 30-60 сек речи.`;

// Shared tail every variant below ends with.
function commonRules() {
  return `Дополнительная польза — только на данных профиля/продуктов/материалов из контекста выше, не выдумывай. Полезность пиши конкретно, без слов "полезно"/"качественный"/"уникальный" без опоры на факт.

CTA — до 15 слов, без давления, исходит из темы и этапа Ханта (см. зафиксированные решения в контексте выше). На этапах Ханта 1-2 не вставляй "сохрани"/"подпишись" без реальной причины в самом тексте. Если выбран лид-магнит — используй его описание (не только название) для конкретного CTA, а не общую фразу.

Без канцеляризмов и конструкций "не X, а Y".`;
}

// genMain / regenPlat — single platform, one call.
export function buildCoreInstructions({ key, platformName, platformInstr, format, sourceIsVideo }) {
  const fullScript = needsFullScript(key, format, sourceIsVideo);
  return `Ты — Копирайтер. Пишешь описание для ${platformName}.

Инструкция площадки: ${platformInstr}
${key === "tt" ? "overlay — короткий текст НА видео (6-8 слов), caption — развёрнутый текст под видео." : ""}
${key === "th" ? "Ссылку клади в link_comment, не в text — так принято в Threads." : ""}

${bonusStructureInstr(key, format)}
${fullScript ? fullScriptInstr : ""}

${commonRules()}

Отвечай JSON без другого текста.`;
}

// adaptAll — every platform in one call.
export function buildAllPlatformsCoreInstructions({ instrBlock, format, sourceIsVideo }) {
  return `Ты — Копирайтер. Адаптируешь один источник под все площадки студии сразу.

Инструкции площадок:
${instrBlock}

Для TikTok (tt): overlay — короткий текст НА видео (6-8 слов), caption — текст под видео. Для Threads (th): ссылку клади в link_comment, не в text.

Для площадок, где описание физически отдельно от видео (tt, yt, а также ig если формат ролика — Reels) — не пересказывай видео/карусель в описании: 1) короткая зацепка, обещающая доп. пользу 2) самостоятельная бонусная польза — список/чек-лист/лайфхак, которого нет в видео, основанный только на продуктах/материалах из контекста, не выдумывай 3) CTA по ступени Ханта (1-2 мягко+сохрани только при реальной причине, 3 интерес к методу, 4-5 бонус ведёт к офферу). Для остальных площадок (tg, th, vk, ig не-Reels) — структура описание/полезность/лид-магнит+CTA не меняется.
${!sourceIsVideo ? fullScriptInstr + " Это касается только tt и yt — ig структурно не может требовать полного сценария здесь." : ""}

${commonRules()}

Отвечай JSON.`;
}
