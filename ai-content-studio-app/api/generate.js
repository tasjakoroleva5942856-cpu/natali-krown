import { redis, checkRateLimit, checkLifetimeLimit, getClientIp } from '../lib/kvHelpers.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const TRIAL_GENERATION_LIMIT = parseInt(process.env.TRIAL_GENERATION_LIMIT || '10', 10);
const DAILY_GENERATION_LIMIT = parseInt(process.env.DAILY_GENERATION_LIMIT || '100', 10);
const MAX_MESSAGE_CHARS = 6000;

export default async function handler(req, res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);

  const ipOk = await checkRateLimit(`rl:ip:${ip}`, 30, 60);
  if (!ipOk) {
    return res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });
  }

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

  if (!isPaid) {
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

  const { system, messages, maxTokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }

  const safeMessages = messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (safeMessages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }

  const safeMaxTokens = Math.min(parseInt(maxTokens, 10) || 1000, 8000);
  const safeSystem = typeof system === 'string' ? system.slice(0, MAX_MESSAGE_CHARS) : undefined;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: safeMaxTokens,
        ...(safeSystem ? { system: safeSystem } : {}),
        messages: safeMessages,
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
