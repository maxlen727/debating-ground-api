// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 朗读：前端和后端共用的切分规则。
// 讯飞单次合成有长度上限，而且整段合成完才能播；按句子切成小段，第一段合成好就能开始播放。
export const DEFAULT_VOICE = 'x4_xiaoyan';
export const VOICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SPEECH_SEGMENT = 300;      // 每段最多这么多字（讯飞上限约 8000 字节，留足余量）
export const SPEECH_MAX = 4000;         // 一次朗读最多这么多字

export const cleanVoice = (v: unknown) => typeof v === 'string' && VOICE_RE.test(v) ? v : DEFAULT_VOICE;

export function splitForSpeech(text: string, max = SPEECH_SEGMENT): string[] {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, SPEECH_MAX);
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { const s = cur.join('').trim(); if (s) out.push(s); cur = []; };
  for (const ch of chars) {
    cur.push(ch);
    // 句末标点处断开；实在太长就在上限处硬断
    if ((cur.length >= max * 0.6 && /[。！？!?；;\n]/.test(ch)) || cur.length >= max) flush();
  }
  flush();
  return out;
}

/* ---------- 语音输入（讯飞语音听写） ---------- */
// 浏览器录音 → 16k 单声道 16 位 PCM，每 40ms 一帧（1280 字节）→ 后端转给讯飞 → 边说边回文字
export const LISTEN = {
  rate: 16000,
  frameBytes: 1280,
  maxMs: 60_000,                 // 讯飞单次最长 60 秒
  maxBytes: 60 * 16000 * 2,      // 对应的 PCM 字节数，后端按这个截断
  startTimeoutMs: 10_000         // 连上后这么久不开始就断开
} as const;

// 浏览器 → 后端（单人走 /api/stt；房间里包在 { type: 'listen' } 里）
export type ListenRequest =
  | { type: 'start'; password?: string }   // password：单人连自己部署的后端时，浏览器的 WebSocket 带不了请求头
  | { type: 'audio'; audio: string }        // base64 的 PCM
  | { type: 'end' }                         // 说完了，等最后的结果
  | { type: 'cancel' };
// 后端 → 浏览器
export type ListenEvent =
  | { type: 'ready' }
  | { type: 'text'; text: string; final: boolean }   // text 总是到目前为止的完整结果
  | { type: 'error'; message: string };
