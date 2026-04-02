import { Redis } from '@upstash/redis';

let _redis = null;

const getRedis = () => {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    // Debug logging
    console.log('Redis Config Debug:');
    console.log('URL present:', !!url);
    console.log('TOKEN present:', !!token);
    console.log('URL value:', url);
    console.log('TOKEN value:', token ? '***masked***' : 'MISSING');

    if (!url || !token) {
      throw new Error(
        `Redis env vars missing — URL: ${url ? 'ok' : 'MISSING'}, TOKEN: ${token ? 'ok' : 'MISSING'}`
      );
    }

    _redis = new Redis({ url, token });
  }
  return _redis;
};

export default getRedis;