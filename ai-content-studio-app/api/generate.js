import { redis, checkRateLimit, checkLifetimeLimit, getClientIp } from '../lib/kvHelpers.js';

// Ключ Anthropic живёт только здесь, на сервере.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const TRIAL_GENERATION_LIMIT = parseInt(process.env.TRIAL_GENERATION_LIMIT || '10', 10);
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
