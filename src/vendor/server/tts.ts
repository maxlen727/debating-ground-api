// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 讯飞在线语音合成（WebSocket 接口）。本机服务和 Worker 共用。
// 密钥只在后端使用：签名放在连接地址里，只发给讯飞；错误信息里不带任何密钥。
import { ApiError } from './ai.ts';
import { cleanVoice } from '../shared/speech.ts';

const HOST = 'tts-api.xfyun.cn';
const ENDPOINT = `wss://${HOST}/v2/tts`;

export interface XfyunEnv { XFYUN_APP_ID?: string; XFYUN_API_KEY?: string; XFYUN_API_SECRET?: string }
export interface Speech { audio: string; mime: 'audio/mpeg' }
// 测试时换成假的讯飞服务
export interface TtsOptions { timeoutMs?: number; endpoint?: string; WebSocketImpl?: typeof WebSocket; now?: () => Date }

export const ttsConfigured = (env: XfyunEnv) => !!(env.XFYUN_APP_ID && env.XFYUN_API_KEY && env.XFYUN_API_SECRET);

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signature(apiKey: string, apiSecret: string, date: string, host = HOST, path = '/v2/tts'): Promise<string> {
  const source = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(source));
  const sig = base64(new Uint8Array(mac));
  return base64(new TextEncoder().encode(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`));
}

// 合成一段文字（调用方先用 splitForSpeech 切好）
export async function synthesizeXfyun(text: string, voice: unknown, env: XfyunEnv, options: TtsOptions = {}): Promise<Speech> {
  const { XFYUN_APP_ID: appId, XFYUN_API_KEY: apiKey, XFYUN_API_SECRET: apiSecret } = env;
  if (!appId || !apiKey || !apiSecret) throw new ApiError('讯飞语音还没有配置。', 503);
  const clean = text.trim();
  if (!clean) throw new ApiError('没有可以朗读的文字。');
  if (new TextEncoder().encode(clean).length > 7900) throw new ApiError('这段文字太长，超过了讯飞单次合成的上限。');
  const { timeoutMs = 20000, WebSocketImpl = WebSocket } = options;
  const url = new URL(options.endpoint ?? ENDPOINT);
  const date = (options.now?.() ?? new Date()).toUTCString();
  url.searchParams.set('authorization', await signature(apiKey, apiSecret, date, url.host, url.pathname));
  url.searchParams.set('date', date);
  url.searchParams.set('host', url.host);

  return new Promise((resolve, reject) => {
    let ws: WebSocket | undefined;
    let settled = false;
    // 每个分片的 base64 是独立编码的（可能带补位符），必须先解码再拼接，否则拼出的不是合法 MP3
    const chunks: Uint8Array[] = [];
    let total = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws?.close(1000, 'done'); } catch { /* 已关闭 */ }
      if (error) return reject(error);
      if (!total) return reject(new ApiError('讯飞没有返回音频。', 502));
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      resolve({ audio: base64(merged), mime: 'audio/mpeg' });
    };
    const timer = setTimeout(() => finish(new ApiError('讯飞语音请求超时，请稍后再试。', 504)), timeoutMs);
    try { ws = new WebSocketImpl(url.toString()); }
    catch { return finish(new ApiError('无法连接讯飞语音服务。', 502)); }
    ws.onopen = () => {
      ws!.send(JSON.stringify({
        common: { app_id: appId },
        business: { aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: cleanVoice(voice), speed: 50, volume: 50, pitch: 50, tte: 'UTF8' },
        data: { status: 2, text: base64(new TextEncoder().encode(clean)) }
      }));
    };
    ws.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as { code?: number; message?: string; data?: { audio?: string; status?: number } };
        // 讯飞的错误码和说明不含密钥，原样给出，方便排查（例如发音人未开通）
        if (message.code !== 0) return finish(new ApiError(`讯飞语音错误 ${message.code ?? '未知'}：${String(message.message ?? '请求失败').slice(0, 120)}`, 502));
        if (message.data?.audio) { const chunk = decodeBase64(message.data.audio); if (chunk.length) { chunks.push(chunk); total += chunk.length; } }
        if (message.data?.status === 2) finish();
      } catch { finish(new ApiError('讯飞返回了无法识别的数据。', 502)); }
    };
    ws.onerror = () => finish(new ApiError('连接讯飞语音服务失败。', 502));
    ws.onclose = () => finish(new ApiError('讯飞语音连接中断。', 502));
  });
}
