// 思辨场 · 可自部署的后端（Cloudflare Worker）
// 和本机服务提供同样的 /api 接口，复用 server/ai.ts 的提示词与校验。
// 密钥由部署者存成 Worker 的加密变量，浏览器里不需要密钥；访问口令防止别人用你的额度。
// 多人讨论：/api/rooms 创建房间（需要访问口令），/api/rooms/<id>/ws 用邀请码加入（不需要口令）。
import { ApiError, normalizeConfig, buildRequest, finalize, complete, streamGenerate, STREAMABLE } from './vendor/server/ai.ts';
import type { Purpose } from './vendor/shared/types.ts';
import { PURPOSES } from './vendor/shared/purposes.ts';
import { ROOM_ID } from './vendor/shared/room.ts';
import { randomToken, roomClass, type Generate } from './room.ts';
import { synthesizeXfyun, ttsConfigured } from './vendor/server/tts.ts';
import { SPEECH_SEGMENT } from './vendor/shared/speech.ts';
import { Listening, listenRelay, sttConfigured } from './vendor/server/stt.ts';

export interface Env {
  API_KEY?: string;          // 加密变量：AI 服务商的 API Key
  API_BASE_URL?: string;     // 加密变量：服务商的 Base URL 或完整 Chat Completions 地址
  MODEL?: string;            // 加密变量：模型 ID
  ACCESS_PASSWORD?: string;  // 加密变量：访问口令
  ALLOWED_ORIGINS?: string;  // 普通变量：允许调用的网站，逗号分隔
  ROOMS?: RoomNamespace;     // Durable Object：多人讨论房间
  XFYUN_APP_ID?: string;      // 加密变量（可选）：讯飞语音朗读
  XFYUN_API_KEY?: string;
  XFYUN_API_SECRET?: string;
}

// 只用到 Durable Object 命名空间的这两个方法
export interface RoomNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }

const MAX_BODY = 1_000_000;

// 读取 JSON 请求体，按字节数限制大小（中文一个字占 3 个字节，按字符数算会放进来三倍大的内容）；超了就停止读取
async function readBody(req: Request, max: number, tooLarge = '请求内容过大。'): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('Content-Length')) > max) throw new ApiError(tooLarge, 413);
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); throw new ApiError(tooLarge, 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes) || '{}'); } catch { throw new ApiError('请求格式错误。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('请求格式错误。');
  return data as Record<string, unknown>;
}

// 口令连续输错太多次，就让这个来源等一会儿再试，防止靠不停地猜撞出口令。
// 计数只在这个 Worker 实例的内存里：实例会被回收，不同机房各算各的，所以这是减速带，不是保险箱；口令本身仍要够长。
const GUESS_LIMIT = 10, GUESS_WINDOW = 10 * 60_000;
function guessGuard() {
  const failures = new Map<string, { count: number; until: number }>();
  const who = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown';
  return {
    blocked(req: Request) { const f = failures.get(who(req)); return !!f && f.until > Date.now() && f.count >= GUESS_LIMIT; },
    failed(req: Request) {
      const now = Date.now();
      if (failures.size > 5000) for (const [k, f] of failures) if (f.until <= now) failures.delete(k);
      const f = failures.get(who(req));
      if (f && f.until > now) f.count++; else failures.set(who(req), { count: 1, until: now + GUESS_WINDOW });
    }
  };
}
const TOO_MANY_GUESSES = '访问口令输错的次数太多了，请 10 分钟后再试。';

// 先各自做 SHA-256 再逐字节比较，耗时与口令内容无关，避免按时间猜口令
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

function configOf(env: Env) {
  try { return normalizeConfig({ baseURL: env.API_BASE_URL, apiKey: env.API_KEY, model: env.MODEL }); }
  catch (e) { throw new ApiError('后端还没有配置好 AI 接口：' + (e instanceof Error ? e.message : ''), 503); }
}

// 房间里的 AI 调用和单人模式走同一套提示词与校验
export function makeGenerate(env: Env, fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 90000): Generate {
  return async (purpose, payload, onText) => {
    const config = configOf(env);
    const request = buildRequest(purpose, payload);
    const result = await complete(config, request.messages, { fetchImpl, timeoutMs, redirect: 'manual', onText });
    return finalize(request, result) as Awaited<ReturnType<Generate>>;
  };
}

// Workers 运行时自带的 WebSocketPair；只声明用到的部分，保持可在 Node 里类型检查
interface PairSocket { accept(): void; send(d: string): void; close(code?: number, reason?: string): void; addEventListener(type: 'message' | 'close' | 'error', fn: (e: Event) => void): void }
declare const WebSocketPair: { new(): { 0: PairSocket; 1: PairSocket } };

const NO_ROOMS = '这个后端还不支持多人讨论。请把后端更新到最新代码并重新部署。';

export function createHandler(fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 90000) {
  const guesses = guessGuard();
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

      // 加入房间：浏览器的 WebSocket 不能带口令，凭邀请码在房间里验证，房主的访问口令不需要交给同学
      const ws = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (ws) {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: '请用 WebSocket 连接房间。' });
        if (!ROOM_ID.test(ws[1])) return json(404, { error: '这个房间不存在或已经结束。' });
        if (!env.ROOMS) return json(503, { error: NO_ROOMS });
        return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(new Request('https://room/ws', { headers: req.headers }));
      }

      // 语音输入：浏览器的 WebSocket 带不了 Authorization，访问口令放在第一条消息里核对
      if (url.pathname === '/api/stt') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: '请用 WebSocket 连接语音输入。' });
        if (!origin) return json(403, { error: '语音输入只接受浏览器里的思辨场。' });
        const pair = new WebSocketPair();
        const client = pair[0], server = pair[1];
        server.accept();
        const authorize = async (given: unknown) => {
          if (!env.ACCESS_PASSWORD || typeof given !== 'string' || !given || guesses.blocked(req)) return false;
          if (await sameSecret(given, env.ACCESS_PASSWORD)) return true;
          guesses.failed(req);
          return false;
        };
        const relay = listenRelay(env, e => { try { server.send(JSON.stringify(e)); } catch { /* 已断开 */ } }, () => { try { server.close(1000, 'done'); } catch { /* 已关闭 */ } }, authorize);
        server.addEventListener('message', e => { void relay.handle((e as MessageEvent).data); });
        server.addEventListener('close', () => relay.close());
        server.addEventListener('error', () => relay.close());
        return new Response(null, { status: 101, webSocket: client } as ResponseInit);
      }

      try {
        // 没设口令就拒绝服务：宁可用不了，也不能让任何人用部署者的额度
        if (!env.ACCESS_PASSWORD) throw new ApiError('后端还没有设置访问口令（ACCESS_PASSWORD）。', 503);
        const given = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (guesses.blocked(req)) throw new ApiError(TOO_MANY_GUESSES, 429);
        if (!given || !(await sameSecret(given, env.ACCESS_PASSWORD))) { if (given) guesses.failed(req); throw new ApiError('访问口令不正确。', 401); }

        const config = configOf(env);

        if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { configured: true, verified: false, baseURL: '', model: config.model, rooms: !!env.ROOMS, ttsConfigured: ttsConfigured(env), sttConfigured: sttConfigured(env) });
        if (req.method === 'POST' && url.pathname === '/api/tts') {
          const data = await readBody(req, 8_000, '朗读请求内容过大。');
          // 前端按 splitForSpeech 分段请求，每段不长
          if (typeof data.text !== 'string' || Array.from(data.text).length > SPEECH_SEGMENT) throw new ApiError('朗读文本无效或太长。');
          return json(200, await synthesizeXfyun(data.text, data.voice, env));
        }
        if (req.method === 'POST' && url.pathname === '/api/rooms') {
          if (!env.ROOMS) throw new ApiError(NO_ROOMS, 503);
          const body = await readBody(req, 200_000);
          const roomId = randomToken();
          const res = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ setup: body.setup, hostName: body.hostName, roomId }) }));
          return json(res.status, await res.json());
        }
        if (req.method !== 'POST' || (url.pathname !== '/api/test' && url.pathname !== '/api/generate')) throw new ApiError('接口不存在。', 404);

        const data = await readBody(req, MAX_BODY);
        const purpose = url.pathname === '/api/test' ? 'test' : data.purpose as Purpose;
        if (purpose !== 'test' && !PURPOSES.includes(purpose)) throw new ApiError('不支持的 AI 操作。');

        const request = buildRequest(purpose, data.payload);
        // 浏览器要求流式、而且这种用途输出的是文字：用 SSE 边生成边发；之后的失败以 error 事件告知
        if (data.stream === true && purpose !== 'test' && STREAMABLE.includes(purpose)) {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          const writer = writable.getWriter(), enc = new TextEncoder();
          const done = streamGenerate(config, request, { fetchImpl, timeoutMs, redirect: 'manual', signal: req.signal }, chunk => { void writer.write(enc.encode(chunk)).catch(() => {}); })
            .finally(() => writer.close().catch(() => {}));
          void done;
          headers.set('Content-Type', 'text/event-stream; charset=utf-8');
          return new Response(readable, { status: 200, headers });
        }
        const result = await complete(config, request.messages, { fetchImpl, timeoutMs, redirect: 'manual' });
        return json(200, finalize(request, result));
      } catch (e) {
        return json(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : '后端未能完成请求。' });
      }
    }
  };
}

export default createHandler();
export const Room = roomClass<Env>(env => makeGenerate(env), env => ttsConfigured(env) ? (text, voice) => synthesizeXfyun(text, voice, env) : undefined,
  env => sttConfigured(env) ? emit => new Listening(env, emit) : undefined);
