import { redis, checkRateLimit, checkLifetimeLimit, getClientIp } from '../lib/kvHelpers.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const TRIAL_GENERATION_LIMIT = parseInt(process.env.TRIAL_GENERATION_LIMIT || '10', 10);
const DAILY_GENERATION_LIMIT = parseInt(process.env.DAILY_GENERATION_LIMIT || '100', 10);
// This is a SAFETY CEILING against abuse/runaway payloads, not a content
// budget. Real context budgeting (what to keep, what to trim, what must
// never be cut) happens client-side in src/ai/contextBuilder.js, which
// targets a much smaller size than this. If a request still exceeds this
// ceiling, something upstream is broken — we reject with 413 and tell the
// caller, instead of silently slicing the request (which used to cut off
// TOV, memory, and the agent's own instructions with no warning to anyone).
const MAX_SYSTEM_CHARS = 40000;
const MAX_MESSAGE_CHARS = 20000;
const MAX_TOTAL_CHARS = 80000;

export default async function handler(req, res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id, X-User-Api-Key');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);

  // Basic per-IP abuse protection applies regardless of who's paying for the
  // call — it's not a generation-count limit, just a floor against hammering
  // the server itself.
  const ipOk = await checkRateLimit(`rl:ip:${ip}`, 30, 60);
  if (!ipOk) {
    return res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });
  }

  // A user's own Anthropic key is used only for the outbound request below —
  // never logged or persisted (not even in Redis) — and exempts them from
  // the studio's trial/daily limits since they're paying Anthropic directly.
  const userApiKey = req.headers['x-user-api-key'];
  const hasOwnKey = typeof userApiKey === 'string' && /^sk-ant-[A-Za-z0-9_-]+$/.test(userApiKey);

  const authHeader = req.headers['authorization'] || '';
  const paidToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let isPaid = false;

  if (paidToken) {
    if (!/^[a-f0-9]{48}$/.test(paidToken)) {
      await checkRateLimit(`rl:badtoken:${ip}`, 5, 60);
      return res.status(401).json({ error: 'Нет доступа' });
    }

    const access = await redis.get(`access:${paidToken}`);
    if (!access || access.status !== 'active') {
      const stillOk = await checkRateLimit(`rl:badtoken:${ip}`, 5, 60);
      if (!stillOk) {
        return res.status(429).json({ error: 'Слишком много неудачных попыток. Попробуйте позже.' });
      }
      return res.status(401).json({ error: 'Нет доступа' });
    }
    if (access.expiresAt && Date.now() > access.expiresAt) {
      return res.status(403).json({ error: 'Подписка истекла' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `usage:${paidToken}:${today}`;
    const used = await redis.incr(dailyKey);
    if (used === 1) await redis.expire(dailyKey, 60 * 60 * 26);
    if (used > DAILY_GENERATION_LIMIT) {
      return res.status(429).json({ error: `Дневной лимит генераций (${DAILY_GENERATION_LIMIT}) исчерпан. Попробуйте завтра.` });
    }

    isPaid = true;
  }

  if (!isPaid && !hasOwnKey) {
    const clientId = req.headers['x-client-id'];
    if (!clientId || typeof clientId !== 'string' || clientId.length < 10 || clientId.length > 100) {
      return res.status(400).json({ error: 'Некорректный запрос' });
    }
    const trialOk = await checkLifetimeLimit(`trial:${clientId}`, TRIAL_GENERATION_LIMIT);
    if (!trialOk) {
      return res.status(429).json({
        error: `Пробный лимит (${TRIAL_GENERATION_LIMIT} генераций) исчерпан. Оформите подписку для продолжения.`,
        trialExhausted: true,
      });
    }
  }

  const { system, messages, maxTokens, enableWebSearch, agentType } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }

  const cleanMessages = messages.filter(
    (m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')
  );
  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }

  const systemStr = typeof system === 'string' ? system : '';
  const systemLen = systemStr.length;
  const messagesLen = cleanMessages.reduce((sum, m) => sum + m.content.length, 0);
  const totalLen = systemLen + messagesLen;
  const oversizedMessage = cleanMessages.find((m) => m.content.length > MAX_MESSAGE_CHARS);

  // Refuse clearly-oversized requests instead of silently cutting them —
  // a truncated request can quietly drop the agent's own instructions or
  // the user's latest edit with no signal to the caller. The client is
  // expected to have already budgeted content to fit well under these
  // ceilings (see src/ai/contextBuilder.js); hitting this means that
  // budgeting failed or was bypassed, and the caller needs to know.
  if (systemLen > MAX_SYSTEM_CHARS || oversizedMessage || totalLen > MAX_TOTAL_CHARS) {
    console.error('generate: payload too large', {
      agentType: typeof agentType === 'string' ? agentType.slice(0, 40) : 'unknown',
      systemLen,
      messagesLen,
      totalLen,
      messageCount: cleanMessages.length,
    });
    return res.status(413).json({
      error: 'Запрос слишком большой. Сократите материалы или историю переписки и попробуйте снова.',
      details: { systemLen, messagesLen, totalLen },
    });
  }

  const safeMessages = cleanMessages.map((m) => ({ role: m.role, content: m.content }));
  const safeMaxTokens = Math.min(parseInt(maxTokens, 10) || 1000, 12000);
  const safeSystem = systemStr || undefined;

  // Size/shape only — never log document text, user drafts, or API keys.
  console.log('generate: request', {
    agentType: typeof agentType === 'string' ? agentType.slice(0, 40) : 'unknown',
    systemLen,
    messagesLen,
    messageCount: safeMessages.length,
  });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': hasOwnKey ? userApiKey : ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: safeMaxTokens,
        ...(safeSystem ? { system: safeSystem } : {}),
        messages: safeMessages,
        // web_search is a paid tool billed per search call — only attach it
        // when the frontend explicitly opts in, never by default.
        ...(enableWebSearch === true ? { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } : {}),
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error', anthropicRes.status, errText);
      return res.status(502).json({ error: 'Ошибка генерации. Попробуйте ещё раз.' });
    }

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return res.status(200).json({ text });
  } catch (err) {
    console.error('generate handler error', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
