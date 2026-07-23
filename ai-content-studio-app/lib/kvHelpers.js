import { Redis } from '@upstash/redis';

// Redis.fromEnv() сам находит переменные, которые Vercel создал при
// подключении интеграции (KV_REST_API_URL / KV_REST_API_TOKEN) — ничего
// вручную указывать не нужно.
export const redis = Redis.fromEnv();

/**
 * Простой rate limiter на базе счётчика с TTL.
 * Возвращает true, если запрос ещё в пределах лимита.
 */
export async function checkRateLimit(key, limit, windowSeconds) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}

/**
 * Пожизненный счётчик (без TTL) — используется для пробного лимита:
 * "10 генераций на анонимного пользователя", а не "10 в минуту".
 */
export async function checkLifetimeLimit(key, limit) {
  const count = await redis.incr(key);
  return count <= limit;
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
