// 思辨场 · 可自部署的后端（Cloudflare Worker）
// 和本机服务提供同样的 /api 接口，复用 server/ai.ts 的提示词与校验。
// 密钥由部署者存成 Worker 的加密变量，浏览器里不需要密钥；访问口令防止别人用你的额度。
import { ApiError, normalizeConfig, buildRequest, finalize, complete } from './vendor/server/ai.ts';
import type { Purpose } from './vendor/shared/types.ts';

export interface Env {
  API_KEY?: string;          // 加密变量：AI 服务商的 API Key
  API_BASE_URL?: string;     // 加密变量：服务商的 Base URL 或完整 Chat Completions 地址
  MODEL?: string;            // 加密变量：模型 ID
  ACCESS_PASSWORD?: string;  // 加密变量：访问口令
  ALLOWED_ORIGINS?: string;  // 普通变量：允许调用的网站，逗号分隔
}

const PURPOSES: Purpose[] = ['prepare', 'discuss', 'debate', 'hint', 'explain', 'reflect', 'review'];
const MAX_BODY = 1_000_000;

// 先各自做 SHA-256 再逐字节比较，耗时与口令内容无关，避免按时间猜口令
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export function createHandler(fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 90000) {
  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      const url = new URL(req.url);
      const origin = req.headers.get('Origin');
      const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (origin && allowed.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Sibian-Client');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Max-Age', '86400');
        headers.set('Vary', 'Origin');
      }
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });

      if (origin && !allowed.includes(origin)) return json(403, { error: '这个后端不接受来自该网站的请求。请把网站地址加入 ALLOWED_ORIGINS。' });
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (url.pathname === '/' && req.method === 'GET') return json(200, { name: '思辨场后端', ok: true });
      if (!url.pathname.startsWith('/api/')) return json(404, { error: '接口不存在。' });

      try {
        // 没设口令就拒绝服务：宁可用不了，也不能让任何人用部署者的额度
        if (!env.ACCESS_PASSWORD) throw new ApiError('后端还没有设置访问口令（ACCESS_PASSWORD）。', 503);
        const given = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (!given || !(await sameSecret(given, env.ACCESS_PASSWORD))) throw new ApiError('访问口令不正确。', 401);

        let config;
        try { config = normalizeConfig({ baseURL: env.API_BASE_URL, apiKey: env.API_KEY, model: env.MODEL }); }
        catch (e) { throw new ApiError('后端还没有配置好 AI 接口：' + (e instanceof Error ? e.message : ''), 503); }

        if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { configured: true, verified: false, baseURL: '', model: config.model });
        if (req.method !== 'POST' || (url.pathname !== '/api/test' && url.pathname !== '/api/generate')) throw new ApiError('接口不存在。', 404);

        const raw = await req.text();
        if (raw.length > MAX_BODY) throw new ApiError('请求内容过大。', 413);
        let data: Record<string, unknown>;
        try { data = JSON.parse(raw || '{}'); } catch { throw new ApiError('请求格式错误。'); }
        const purpose = url.pathname === '/api/test' ? 'test' : data.purpose as Purpose;
        if (purpose !== 'test' && !PURPOSES.includes(purpose)) throw new ApiError('不支持的 AI 操作。');

        const request = buildRequest(purpose, data.payload);
        const result = await complete(config, request.messages, { fetchImpl, timeoutMs, redirect: 'manual' });
        return json(200, finalize(request, result));
      } catch (e) {
        return json(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : '后端未能完成请求。' });
      }
    }
  };
}

export default createHandler();
