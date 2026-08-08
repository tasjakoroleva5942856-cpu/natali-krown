import { checkRateLimit, getClientIp } from '../lib/kvHelpers.js';

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const BASE_URL = 'https://api.scrapecreators.com';
// Keep the per-competitor payload small — this feeds straight into an LLM
// call afterward (see competitorAnalysis.js), not a dashboard.
const POSTS_PER_COMPETITOR = 15;

async function scGet(path) {
  const r = await fetch(`${BASE_URL}${path}`, { headers: { 'x-api-key': SCRAPECREATORS_API_KEY } });
  if (!r.ok) {
    const err = new Error(`ScrapeCreators ${path} -> ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ScrapeCreators' exact response envelope for each endpoint isn't
// verifiable from this environment (network to the third-party API is
// blocked here) — this tries the common wrapper shapes a scraping API
// tends to use. If real responses come back empty once the key is live,
// adjust the candidate keys/paths below against an actual payload.
function extractList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['posts', 'reels', 'videos', 'items', 'data', 'results']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

// Only strings and numbers count as "found" — an object (like Instagram's
// caption, which wraps the actual text as { text, user, pk, ... }) is
// truthy too, so a plain existence check would stop here without ever
// trying the nested candidate path that has the real value.
function pick(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if ((typeof val === 'string' && val !== '') || typeof val === 'number') return val;
  }
  return null;
}

function normalizeInstagram(p) {
  return {
    title_or_caption: pick(p, ['caption.text', 'title', 'text']) || '',
    likes: Number(pick(p, ['like_count', 'likes', 'edge_media_preview_like.count'])) || 0,
    comments: Number(pick(p, ['comment_count', 'comments', 'edge_media_to_comment.count'])) || 0,
    views: Number(pick(p, ['view_count', 'video_view_count', 'play_count', 'views'])) || 0,
    postedAt: pick(p, ['taken_at', 'timestamp', 'posted_at', 'date']) || null,
    url: pick(p, ['url', 'permalink', 'link']) || (p?.shortcode ? `https://www.instagram.com/p/${p.shortcode}/` : ''),
  };
}

function normalizeTiktok(p) {
  return {
    title_or_caption: pick(p, ['desc', 'description', 'title', 'text']) || '',
    likes: Number(pick(p, ['digg_count', 'like_count', 'likes'])) || 0,
    comments: Number(pick(p, ['comment_count', 'comments'])) || 0,
    views: Number(pick(p, ['play_count', 'view_count', 'views'])) || 0,
    postedAt: pick(p, ['create_time', 'createTime', 'posted_at', 'timestamp']) || null,
    url: pick(p, ['url', 'share_url', 'video_url', 'link']) || '',
  };
}

function normalizeYoutube(p) {
  return {
    title_or_caption: pick(p, ['title', 'snippet.title']) || '',
    likes: Number(pick(p, ['likeCount', 'like_count', 'statistics.likeCount'])) || 0,
    comments: Number(pick(p, ['commentCount', 'comment_count', 'statistics.commentCount'])) || 0,
    views: Number(pick(p, ['viewCount', 'view_count', 'statistics.viewCount'])) || 0,
    postedAt: pick(p, ['publishedAt', 'published_at', 'snippet.publishedAt']) || null,
    url: pick(p, ['url', 'link']) || ((p?.videoId || p?.id) ? `https://www.youtube.com/watch?v=${p.videoId || p.id}` : ''),
  };
}

async function fetchInstagram(handle) {
  // Existence/access check first — surfaces 403/404 with a clear meaning
  // before we bother with the (more expensive) posts/reels calls.
  await scGet(`/v1/instagram/profile?handle=${encodeURIComponent(handle)}`);
  const results = await Promise.allSettled([
    scGet(`/v2/instagram/user/posts?handle=${encodeURIComponent(handle)}`),
    scGet(`/v1/instagram/user/reels?handle=${encodeURIComponent(handle)}`),
  ]);
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => extractList(r.value));
  if (!lists.length) throw results.find((r) => r.status === 'rejected').reason;
  return lists.flat().map(normalizeInstagram);
}

async function fetchTiktok(handle) {
  await scGet(`/v1/tiktok/profile?handle=${encodeURIComponent(handle)}`);
  const data = await scGet(`/v3/tiktok/profile/videos?handle=${encodeURIComponent(handle)}`);
  return extractList(data).map(normalizeTiktok);
}

async function fetchYoutube(handle) {
  await scGet(`/v1/youtube/channel?handle=${encodeURIComponent(handle)}`);
  const data = await scGet(`/v1/youtube/channel-videos?handle=${encodeURIComponent(handle)}`);
  return extractList(data).map(normalizeYoutube);
}

const FETCHERS = { instagram: fetchInstagram, tiktok: fetchTiktok, youtube: fetchYoutube };

const TRANSCRIPT_TOP_N = 5; // не транскрибируем все посты — только самые залетевшие

const TRANSCRIPT_PATH = {
  instagram: (url) => `/v2/instagram/media/transcript?url=${encodeURIComponent(url)}`,
  tiktok: (url) => `/v1/tiktok/video/transcript?url=${encodeURIComponent(url)}`,
  youtube: (url) => `/v1/youtube/video/transcript?url=${encodeURIComponent(url)}`,
};

async function fetchTranscript(platform, url) {
  if (!url) return null;
  try {
    const data = await scGet(TRANSCRIPT_PATH[platform](url));
    // Формат ответа по каждой площадке тоже не проверен вживую — попробуй
    // разумные варианты и, если после мёржа окажется, что транскрипт не
    // приходит при рабочем URL, посмотри реальный ответ тем же способом,
    // что и с подписями (временный debug-лог, попроси прислать).
    return pick(data, ['transcript', 'text']) || null;
  } catch {
    return null; // отсутствие транскрипта — не ошибка всего запроса, а норма (нет речи/фото-пост/видео длиннее 2 мин у IG)
  }
}

export default async function handler(req, res) {
  if (ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  // Each call here costs real ScrapeCreators credits, unlike a normal page
  // view — a low per-IP ceiling is enough to stop casual abuse of an
  // otherwise-unauthenticated endpoint without needing the full paywall
  // that /api/generate has (this ТЗ doesn't ask for gating it the same way).
  const ok = await checkRateLimit(`rl:scrape:ip:${ip}`, 10, 60);
  if (!ok) return res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });

  const { platform, handle } = req.body || {};
  if (!FETCHERS[platform] || typeof handle !== 'string' || !handle.trim()) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }
  if (!SCRAPECREATORS_API_KEY) {
    console.error('scrape: SCRAPECREATORS_API_KEY is not set');
    return res.status(500).json({ error: 'Сервис анализа конкурентов не настроен' });
  }

  const cleanHandle = handle.trim().replace(/^@/, '');

  try {
    const posts = (await FETCHERS[platform](cleanHandle)).slice(0, POSTS_PER_COMPETITOR);

    const topPosts = [...posts]
      .sort((a, b) => (b.likes + b.comments + b.views) - (a.likes + a.comments + a.views))
      .slice(0, TRANSCRIPT_TOP_N);

    await Promise.all(topPosts.map(async (post) => {
      post.transcript = await fetchTranscript(platform, post.url);
    }));

    return res.status(200).json({ posts });
  } catch (err) {
    const status = err.status;
    if (status === 401) {
      console.error('scrape: ScrapeCreators auth failed — check SCRAPECREATORS_API_KEY in Vercel');
      return res.status(401).json({ error: 'Ошибка доступа к сервису анализа конкурентов' });
    }
    if (status === 402) {
      return res.status(402).json({ error: 'Кончились кредиты на сервисе анализа конкурентов' });
    }
    if (status === 403 || status === 404) {
      return res.status(status).json({ error: `Не удалось получить данные для @${cleanHandle} — проверьте, что аккаунт публичный и хэндл указан верно` });
    }
    console.error('scrape handler error', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
