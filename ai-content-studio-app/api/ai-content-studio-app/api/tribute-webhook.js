import crypto from 'crypto';
import { redis } from '../lib/kvHelpers.js';

// Отключаем автопарсинг тела запроса — подпись Tribute считается по
// сырым байтам запроса, а не по уже распарсенному JSON.
export const config = {
  api: {
    bodyParser: false,
  },
};

const TRIBUTE_API_KEY = process.env.TRIBUTE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STUDIO_URL = process.env.STUDIO_URL;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  const signature = req.headers['trbt-signature'];
  if (!signature || !isValidSignature(rawBody, signature)) {
    console.warn('Отклонён вебхук с неверной подписью');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'invalid json' });
  }

  const { name, payload } = event || {};
  if (!payload || !payload.telegram_user_id) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  try {
    switch (name) {
      case 'new_subscription':
      case 'renewed_subscription': {
        const token = await getOrCreateToken(payload.telegram_user_id);
        await redis.set(`access:${token}`, {
          status: 'active',
          telegramUserId: payload.telegram_user_id,
          subscriptionId: payload.subscription_id,
          period: payload.period || null,
          expiresAt: payload.expires_at ? new Date(payload.expires_at).getTime() : null,
        });
        if (name === 'new_subscription') {
          await sendTelegramLink(payload.telegram_user_id, token);
        }
        break;
      }
      case 'cancelled_subscription': {
        const token = await redis.get(`tg:${payload.telegram_user_id}`);
        if (token) {
          const access = await redis.get(`access:${token}`);
          if (access) {
            await redis.set(`access:${token}`, { ...access, status: 'cancelled' });
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('tribute-webhook processing error', err);
    return res.status(500).json({ error: 'internal error' });
  }

  return res.status(200).json({ ok: true });
}

function isValidSignature(rawBody, signatureHeader) {
  if (!TRIBUTE_API_KEY) {
    console.error('TRIBUTE_API_KEY не задан — вебхуки не могут быть проверены');
    return false;
  }
  const expected = crypto.createHmac('sha256', TRIBUTE_API_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signatureHeader).trim(), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getOrCreateToken(telegramUserId) {
  const existing = await redis.get(`tg:${telegramUserId}`);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set(`tg:${telegramUserId}`, token);
  return token;
}

async function sendTelegramLink(telegramUserId, token) {
  if (!TELEGRAM_BOT_TOKEN || !STUDIO_URL) {
    console.error('TELEGRAM_BOT_TOKEN или STUDIO_URL не заданы — не могу отправить ссылку');
    return;
  }
  const text = `Спасибо за подписку! Ваша ссылка на AI Content Studio:\n${STUDIO_URL}/?token=${token}\n\nСсылка персональная, не передавайте её другим — она даёт доступ к вашей подписке.`;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: telegramUserId, text }),
  });
}
