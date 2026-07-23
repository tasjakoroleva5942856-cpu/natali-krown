import { redis } from '../lib/kvHelpers.js';

export const config = {
  api: {
    bodyParser: true,
  },
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const STUDIO_URL = process.env.STUDIO_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  if (!TELEGRAM_WEBHOOK_SECRET || secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  const update = req.body || {};
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text || '';

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  if (text.startsWith('/start')) {
    const token = await redis.get(`tg:${chatId}`);
    const access = token ? await redis.get(`access:${token}`) : null;

    if (access && access.status === 'active' && (!access.expiresAt || Date.now() < access.expiresAt)) {
      await sendMessage(
        chatId,
        `Добро пожаловать! Ваша ссылка на AI Content Studio:\n${STUDIO_URL}/?token=${token}\n\nСсылка персональная, не передавайте её другим.`
      );
    } else {
      await sendMessage(
        chatId,
        `У вас пока нет активной подписки на AI Content Studio. Оформите подписку, чтобы получить доступ.`
      );
    }
  }

  return res.status(200).json({ ok: true });
}

async function sendMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
