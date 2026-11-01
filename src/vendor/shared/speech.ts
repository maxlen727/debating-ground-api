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
