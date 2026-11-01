// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 讯飞语音听写（流式版 WebSocket）。本机服务、Worker 和多人房间共用。
// 浏览器只把录好的 PCM 交给后端；后端带签名连讯飞，把识别结果原样转回去。录音不保存。
import { ApiError } from './ai.ts';
import { signature, ttsConfigured, type XfyunEnv } from './tts.ts';
import { LISTEN, type ListenEvent } from '../shared/speech.ts';

const ENDPOINT = 'wss://iat-api.xfyun.cn/v2/iat';
// 讯飞要求每帧的 base64 不超过 13000 字节
const MAX_FRAME_B64 = 13_000;

export const sttConfigured = ttsConfigured;   // 同一组讯飞密钥（应用里要开通“语音听写”）
export interface SttOptions { endpoint?: string; WebSocketImpl?: typeof WebSocket; now?: () => Date; finishTimeoutMs?: number; maxMs?: number }

interface IatFrame { code?: number; message?: string; data?: { status?: number; result?: { sn?: number; pgs?: string; rg?: number[]; ws?: { cw?: { w?: string }[] }[] } } }

// 一段录音：audio() 一帧帧送进来，end() 表示说完了；结果通过 emit 回调，text 总是到目前为止的完整文字
export class Listening {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private opened = false;
  private sentFirst = false;
  private ended = false;
  private done = false;
  private bytes = 0;
  private parts: string[] = [];     // 按讯飞的 sn 存每一段；开启动态修正后，后面的结果可能替换前面几段
  private timers: ReturnType<typeof setTimeout>[] = [];
  private env: XfyunEnv;
  private emit: (e: ListenEvent) => void;
  private options: SttOptions;
  constructor(env: XfyunEnv, emit: (e: ListenEvent) => void, options: SttOptions = {}) {
    this.env = env; this.emit = emit; this.options = options;
  }

  get finished() { return this.done; }

  async start() {
    const { XFYUN_APP_ID: appId, XFYUN_API_KEY: apiKey, XFYUN_API_SECRET: apiSecret } = this.env;
    if (!appId || !apiKey || !apiSecret) throw new ApiError('讯飞语音还没有配置。', 503);
    const url = new URL(this.options.endpoint ?? ENDPOINT);
    const date = (this.options.now?.() ?? new Date()).toUTCString();
    url.searchParams.set('authorization', await signature(apiKey, apiSecret, date, url.host, url.pathname));
    url.searchParams.set('date', date);
    url.searchParams.set('host', url.host);
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    try { this.ws = new Impl(url.toString()); } catch { throw new ApiError('无法连接讯飞语音服务。', 502); }
    this.ws.onopen = () => { this.opened = true; for (const f of this.queue.splice(0)) this.ws!.send(f); };
    this.ws.onmessage = e => this.receive(String(e.data));
    this.ws.onerror = () => this.fail('连接讯飞语音服务失败。');
    this.ws.onclose = () => this.fail('讯飞语音连接中断。');
    // 讯飞单次最长 60 秒：到点自动结束，拿已经说的部分
    this.timers.push(setTimeout(() => this.end(), this.options.maxMs ?? LISTEN.maxMs - 1000));
  }

  audio(b64: unknown) {
    if (this.done || this.ended) return;
    if (typeof b64 !== 'string' || !b64 || b64.length > MAX_FRAME_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return this.fail('音频格式不对。');
    this.bytes += b64.length * 3 / 4 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (this.bytes > LISTEN.maxBytes) return this.end();
    this.frame(this.sentFirst ? 1 : 0, b64);
  }

  end() {
    if (this.done || this.ended) return;
    this.ended = true;
    // 一句没说就结束：不用再等讯飞
    if (!this.sentFirst) return this.finish();
    this.frame(2, '');
    this.timers.push(setTimeout(() => this.fail('语音识别超时，请再说一次。'), this.options.finishTimeoutMs ?? 10_000));
  }

  cancel() { this.close(); this.done = true; }

  private frame(status: 0 | 1 | 2, audio: string) {
    const data = { status, format: `audio/L16;rate=${LISTEN.rate}`, encoding: 'raw', audio };
    const msg = status === 0 && !this.sentFirst
      // 第一帧带上应用和识别参数：普通话、动态修正（边说边改）、自动加标点、说完 3 秒静音算结束
      ? { common: { app_id: this.env.XFYUN_APP_ID }, business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', ptt: 1, eos: 3000 }, data }
      : { data };
    this.sentFirst = true;
    const raw = JSON.stringify(msg);
    if (this.opened) this.ws?.send(raw); else this.queue.push(raw);
  }

  private receive(raw: string) {
    if (this.done) return;
    let m: IatFrame;
    try { m = JSON.parse(raw); } catch { return this.fail('讯飞返回了无法识别的数据。'); }
    // 讯飞的错误码和说明不含密钥，原样给出方便排查（例如应用没开通语音听写）
    if (m.code !== 0) return this.fail(`讯飞语音错误 ${m.code ?? '未知'}：${String(m.message ?? '请求失败').slice(0, 120)}`);
    const r = m.data?.result;
    if (r && Number.isInteger(r.sn)) {
      const text = (r.ws ?? []).map(w => w.cw?.[0]?.w ?? '').join('');
      if (r.pgs === 'rpl' && Array.isArray(r.rg) && r.rg.length === 2) for (let i = r.rg[0]; i <= r.rg[1]; i++) this.parts[i] = '';
      this.parts[r.sn as number] = text;
    }
    const final = m.data?.status === 2;
    this.emit({ type: 'text', text: this.parts.join(''), final });
    if (final) this.finish(false);
  }

  private finish(announce = true) {
    if (announce) this.emit({ type: 'text', text: this.parts.join(''), final: true });
    this.close(); this.done = true;
  }
  private fail(message: string) {
    if (this.done) return;
    this.close(); this.done = true;
    this.emit({ type: 'error', message });
  }
  private close() {
    this.timers.forEach(clearTimeout);
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; this.ws.onmessage = null; try { this.ws.close(1000, 'done'); } catch { /* 已关闭 */ } }
  }
}

// 单人模式的一条 /api/stt 连接：按顺序处理浏览器发来的 start / audio / end / cancel
// authorize：Worker 在这里核对访问口令；本机服务已经凭 Cookie 认过人，直接通过
export function listenRelay(env: XfyunEnv, send: (e: ListenEvent) => void, close: () => void, authorize: (password: unknown) => Promise<boolean> = async () => true, options: SttOptions = {}) {
  let session: Listening | null = null;
  let closed = false;
  const stop = () => { if (closed) return; closed = true; clearTimeout(idle); session?.cancel(); close(); };
  const reply = (e: ListenEvent) => { if (closed) return; send(e); if (e.type === 'error' || (e.type === 'text' && e.final)) stop(); };
  // 连上不说话就断开，不占着连接
  const idle = setTimeout(() => { reply({ type: 'error', message: '太久没有开始，连接已断开。' }); }, LISTEN.startTimeoutMs);
  return {
    async handle(raw: unknown) {
      if (closed) return;
      let msg: { type?: unknown; audio?: unknown; password?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return reply({ type: 'error', message: '消息格式错误。' }); }
      if (msg.type === 'start') {
        if (session) return;
        clearTimeout(idle);
        if (!(await authorize(msg.password))) return reply({ type: 'error', message: '访问口令不正确。' });
        if (!sttConfigured(env)) return reply({ type: 'error', message: '这个后端还没有配置讯飞语音。' });
        session = new Listening(env, reply, options);
        try { await session.start(); } catch (e) { return reply({ type: 'error', message: e instanceof ApiError ? e.message : '无法开始语音识别。' }); }
        return reply({ type: 'ready' });
      }
      if (!session) return reply({ type: 'error', message: '请先开始录音。' });
      if (msg.type === 'audio') return session.audio(msg.audio);
      if (msg.type === 'end') return session.end();
      if (msg.type === 'cancel') return stop();
      reply({ type: 'error', message: '不支持的操作。' });
    },
    close: stop
  };
}
