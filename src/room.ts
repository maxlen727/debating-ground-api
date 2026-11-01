// 多人讨论房间：一场讨论一个 Durable Object。
// RoomCore 不依赖 Workers 运行时（存储、WebSocket、AI 调用都由外部传入），可以直接在 Node 里测试；
// 文件末尾的 Room 类把它接到 Durable Object 上。
import { ApiError } from './vendor/server/ai.ts';
import { cleanVoice, splitForSpeech, type ListenEvent } from './vendor/shared/speech.ts';
import type { ChatMessage, ExplainKind, Persona, Purpose, SessionSnapshot, Stage, StageKind, SystemLine, Turn } from './vendor/shared/types.ts';
import { QUICK_MESSAGES, ROOM_LIMITS, type ClientMessage, type PointProposal, type CreatedRoom, type RoomMember, type RoomSeat, type RoomSetup, type RoomStatus, type RoomView, type ServerMessage, type Speaker } from './vendor/shared/room.ts';

interface StoredMember { id: string; name: string; host: boolean; seat?: string; tokenHash: string; personalCalls: number; voiceCalls?: number; listenCalls?: number }
export interface StoredRoom {
  id: string; status: RoomStatus; setup: RoomSetup; members: StoredMember[];
  entries: (ChatMessage | SystemLine)[]; covered: number[]; cursor: number; speaker: Speaker; turnStartedAt: number;
  nextPersona: number; lastMember: string | null; takeover: boolean;
  inviteHash: string; aiCalls: number; aiBusy: string | null; error: string; created: number; expiresAt: number;
  voiceCalls?: number; listenCalls?: number; proposals?: PointProposal[];   // 这几项是后加的，旧房间里可能没有
}

export interface SocketLike { send(data: string): void; close(code?: number, reason?: string): void; memberId(): string | null; setMember(id: string): void }
const cleanTerms = (v: unknown) => Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, 3) : undefined;
export type Generate = (purpose: Purpose, payload: unknown, onText?: (visible: string) => void) => Promise<{ text?: string; covered?: number[]; terms?: string[]; data?: unknown; model?: string }>;
// 一段语音输入（server/stt.ts 的 Listening）；测试里换成假的
export interface ListenSession { start(): Promise<void>; audio(b64: unknown): void; end(): void; cancel(): void; readonly finished: boolean }

export interface RoomDeps {
  load(): Promise<StoredRoom | undefined>;
  save(room: StoredRoom): Promise<void>;
  destroy(): Promise<void>;
  sockets(): SocketLike[];
  setAlarm(at: number): Promise<void>;
  synthesize?(text: string, voice: string): Promise<{ audio: string; mime: string }>;
  listen?(emit: (e: ListenEvent) => void): ListenSession;   // 讯飞语音听写；没配就是 undefined
  generate: Generate;
  now(): number;
}

/* ---------- 工具 ---------- */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 只保存邀请码和成员凭据的哈希，比较哈希值不会因为长度或前缀泄露信息
async function hash(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const uid = () => randomToken().slice(0, 10);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function str(v: unknown, max: number, label: string, required = true): string {
  if (!required && v == null) return '';
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new ApiError(`${label}无效。`);
  return v.trim();
}
export function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!name || name.length > ROOM_LIMITS.nameLength) throw new ApiError(`请填写 1 到 ${ROOM_LIMITS.nameLength} 个字的名字。`);
  return name;
}

/* ---------- 校验房主提交的讨论设置 ---------- */
const KINDS: StageKind[] = ['opening', 'cross', 'free', 'closing'];
export function validateSetup(v: unknown): RoomSetup {
  if (!isObj(v) || (v.mode !== 'roundtable' && v.mode !== 'debate')) throw new ApiError('多人讨论只支持圆桌讨论和正反辩论。');
  const mode = v.mode;
  const keyPoints = Array.isArray(v.keyPoints) ? v.keyPoints.map(k => str(k, 60, '要点')) : [];
  if (keyPoints.length < 2 || keyPoints.length > 6) throw new ApiError('要点需要 2 到 6 个。');
  const setup: RoomSetup = {
    mode, concept: str(v.concept, 80, '概念'), topic: str(v.topic, 300, '讨论题'), keyPoints,
    personas: [], opening: '', seats: [], stages: [], turns: [],
    turnSeconds: [0, 30, 60, 90, 120].includes(v.turnSeconds as number) ? v.turnSeconds as number : 0,
    model: typeof v.model === 'string' ? v.model.slice(0, 200) : undefined
  };
  if (mode === 'roundtable') {
    const list = Array.isArray(v.personas) ? v.personas.slice(0, 3) : [];
    setup.personas = list.map((p, i): Persona => {
      if (!isObj(p)) throw new ApiError('圆桌嘉宾无效。');
      return { id: 'r' + i, name: str(p.name, 20, '嘉宾名字'), title: str(p.title, 20, '嘉宾身份', false), persona: str(p.persona, 500, '嘉宾背景', false), tone: (['c', 'a', 'b'] as const)[i % 3] };
    });
    if (!setup.personas.length) throw new ApiError('圆桌至少需要一位 AI 嘉宾。');
    setup.opening = str(v.opening, 400, '开场白', false) || '我们开始吧。大家怎么理解这个概念？';
    return setup;
  }
  const seats = Array.isArray(v.seats) ? v.seats.slice(0, 8) : [];
  setup.seats = seats.map((r): RoomSeat => {
    if (!isObj(r) || (r.team !== 'A' && r.team !== 'B') || !Number.isInteger(r.index) || (r.index as number) < 0 || (r.index as number) > 3 || (r.type !== 'human' && r.type !== 'peer' && r.type !== 'ai')) throw new ApiError('辩论席位无效。');
    const index = r.index as number;
    return { id: r.team + (index + 1), team: r.team, index, type: r.type, bg: str(r.bg, 500, '认知背景', false), name: `${r.team === 'A' ? '正' : '反'}方 ${index + 1} 辩` };
  });
  if (new Set(setup.seats.map(s => s.id)).size !== setup.seats.length || !setup.seats.some(s => s.team === 'A') || !setup.seats.some(s => s.team === 'B')) throw new ApiError('辩论席位无效。');
  // 房间里谁坐哪个席位由大家自己选；这里的 type 只决定房主默认坐哪里
  const stages = Array.isArray(v.stages) ? v.stages.slice(0, 6) : [];
  setup.stages = stages.map((s): Stage => {
    if (!isObj(s) || !KINDS.includes(s.kind as StageKind) || !Number.isInteger(s.rounds) || (s.rounds as number) < 1 || (s.rounds as number) > 3) throw new ApiError('比赛流程无效。');
    return { name: str(s.name, 20, '环节名称'), kind: s.kind as StageKind, rounds: s.rounds as number };
  });
  if (!setup.stages.length) throw new ApiError('比赛流程无效。');
  // 发言顺序由界面按赛制算好，这里核对每一步都指向真实的席位和环节，并换成后端自己的席位数据
  const turns = Array.isArray(v.turns) ? v.turns : [];
  if (!turns.length || turns.length > 120) throw new ApiError('比赛流程无效。');
  const seatOf = (id: unknown) => setup.seats.find(s => s.id === id);
  setup.turns = turns.map((t): Turn => {
    const role = isObj(t) && isObj(t.role) ? seatOf(t.role.id) : undefined;
    if (!isObj(t) || !role || !Number.isInteger(t.stage) || (t.stage as number) < 0 || (t.stage as number) >= setup.stages.length || !Number.isInteger(t.round)) throw new ApiError('比赛流程无效。');
    const target = t.target === undefined ? undefined : seatOf(t.target)?.id;
    if (t.target !== undefined && !target) throw new ApiError('比赛流程无效。');
    const { name: _name, ...seat } = role;
    return { role: seat, action: str(t.action, 20, '发言类型'), target, stage: t.stage as number, round: t.round as number };
  });
  return setup;
}

/* ---------- 发给 AI 的讨论快照 ---------- */
// viewer 为空：AI 发言时用，所有真人都标为“学习者”。
// viewer 为某位成员：个人提示与复盘用，只有这位成员标为“学习者”，其他真人标为“同学”，
// 这样复盘只依据这个人自己的发言。
export function snapshotFor(room: StoredRoom, viewer: string | null, reflections: string[] = []): SessionSnapshot {
  const { setup } = room;
  const memberName = (id?: string) => room.members.find(m => m.id === id)?.name ?? '同学';
  const label = (m: ChatMessage) => {
    if (!m.memberId) return m.name;
    const base = setup.mode === 'debate' ? setup.seats.find(s => s.id === m.who)?.name ?? m.name : memberName(m.memberId);
    return `${base}（${viewer === null || viewer === m.memberId ? '学习者' : '同学'}）`;
  };
  const messages: SessionSnapshot['messages'] = room.entries.flatMap((m): SessionSnapshot['messages'] =>
    m.kind === 'msg' && !m.skipped ? [{ kind: 'msg', name: label(m), text: m.text, action: m.action }] : []);
  for (const text of reflections) messages.push({ kind: 'reflect', name: '学习者', text });
  const debate = setup.mode === 'debate';
  return {
    mode: setup.mode, concept: setup.concept, topic: setup.topic, keyPoints: setup.keyPoints,
    roles: setup.personas.map(r => ({ id: r.id, name: r.name, title: r.title, persona: r.persona })),
    messages,
    // 有人坐的席位是真人，没人坐的由 AI 担任
    turns: debate ? setup.turns.map(t => ({ ...t, role: { ...t.role, type: room.members.some(m => m.seat === t.role.id) ? 'human' as const : 'ai' as const } })) : undefined, cursor: debate ? room.cursor : undefined,
    stages: debate ? setup.stages : undefined, finished: room.status === 'finished'
  };
}

/* ---------- 房间 ---------- */
export class RoomCore {
  private room: StoredRoom | undefined;
  private loading: Promise<StoredRoom | undefined> | null = null;
  private running = false;                    // 同一时间只生成一条 AI 发言
  private asking = new Set<string>();         // 每位成员同一时间只有一个个人请求
  // 以下只在内存里：Durable Object 休眠后清空也没关系
  private typingUntil = new Map<string, number>();   // 正在输入，按成员
  private lastQuick = new Map<string, number>();     // 上一次快捷短语的时间
  private speaking = new Set<string>();              // 每位成员同一时间只合成一条朗读
  private voiceCache = new Map<string, string[]>();  // 合成过的音频（按发言和音色），同一条再听不用重新合成
  private voiceBytes = 0;
  private listening = new Map<string, ListenSession>();  // 正在语音输入的成员
  private deps: RoomDeps;
  constructor(deps: RoomDeps) { this.deps = deps; }

  private async get(): Promise<StoredRoom | undefined> {
    if (this.room) return this.room;
    this.loading ??= this.deps.load().then(r => {
      // 进程重启后，之前没生成完的 AI 发言已经中断
      if (r && r.aiBusy) r.aiBusy = null;
      this.room = r; return r;
    });
    return this.loading;
  }
  private async save() { if (this.room) await this.deps.save(this.room); }

  async init(input: { roomId?: unknown; setup?: unknown; hostName?: unknown }): Promise<CreatedRoom> {
    if (await this.get()) throw new ApiError('房间已经存在。', 409);
    if (typeof input.roomId !== 'string') throw new ApiError('房间编号无效。');
    const setup = validateSetup(input.setup);
    const hostName = cleanName(input.hostName);
    const now = this.deps.now();
    const invite = randomToken(), hostToken = randomToken();
    const host: StoredMember = { id: uid(), name: hostName, host: true, tokenHash: await hash(hostToken), personalCalls: 0 };
    const entries: StoredRoom['entries'] = [{ id: uid(), kind: 'sys', text: `${setup.mode === 'debate' ? '辩题' : '讨论题'}：${setup.topic}` }];
    if (setup.mode === 'roundtable') {
      const first = setup.personas[0];
      entries.push({ id: uid(), kind: 'msg', who: first.id, name: first.name, text: setup.opening, source: 'api', model: setup.model });
    }
    this.room = {
      id: input.roomId, status: 'lobby', setup, members: [host], entries, covered: [], cursor: 0, speaker: null, turnStartedAt: now,
      nextPersona: setup.personas.length > 1 ? 1 : 0, lastMember: null, takeover: false,
      inviteHash: await hash(invite), aiCalls: 0, aiBusy: null, error: '', created: now, expiresAt: now + ROOM_LIMITS.lifetimeMs
    };
    if (setup.mode === 'debate') host.seat = this.freeSeat();
    await this.save();
    await this.deps.setAlarm(this.room.expiresAt);
    return { roomId: input.roomId, invite, hostToken, expiresAt: this.room.expiresAt };
  }

  /* ---------- 连接 ---------- */
  async onOpen(ws: SocketLike) {
    if (!(await this.get())) { this.close(ws, '这个房间不存在或已经结束。'); }
  }
  async onClose(ws?: SocketLike) {
    const id = ws?.memberId();
    if (id) { this.typingUntil.delete(id); this.listening.get(id)?.cancel(); this.listening.delete(id); }
    if (await this.get()) this.broadcast();
  }

  async alarm() {
    const room = await this.get();
    if (!room) return;
    if (this.deps.now() < room.expiresAt) return this.deps.setAlarm(room.expiresAt);
    for (const ws of this.deps.sockets()) this.close(ws, '房间已到期，讨论内容已从后端删除。');
    this.room = undefined; this.loading = null;
    await this.deps.destroy();
  }

  async onMessage(ws: SocketLike, raw: unknown) {
    const room = await this.get();
    if (!room) return this.close(ws, '这个房间不存在或已经结束。');
    let msg: ClientMessage;
    try {
      if (typeof raw !== 'string' || raw.length > 16_000) throw new Error();
      msg = JSON.parse(raw);
      if (!isObj(msg) || typeof msg.type !== 'string') throw new Error();
    } catch { return this.send(ws, { type: 'error', message: '消息格式错误。' }); }
    try {
      if (msg.type === 'hello') return await this.hello(ws, room, msg.invite, msg.name);
      if (msg.type === 'resume') return await this.resume(ws, room, msg.token);
      const me = room.members.find(m => m.id === ws.memberId());
      if (!me) return this.send(ws, { type: 'error', message: '请先加入房间。' });
      if (msg.type === 'ask') return await this.ask(ws, room, me, msg);
      if (msg.type === 'speak') return await this.speak(ws, room, me, msg.entryId, msg.voice);
      // 这两种消息很频繁：不写存储，也不触发 AI
      if (msg.type === 'typing') return this.typing(me, msg.active);
      if (msg.type === 'quickMessage') return this.quick(room, me, msg.text);
      if (msg.type === 'listen') return await this.listen(ws, room, me, msg);
      await this.act(room, me, msg);
    } catch (e) {
      this.send(ws, { type: 'error', message: e instanceof ApiError ? e.message : '后端未能完成这个操作。' });
    }
  }

  private async hello(ws: SocketLike, room: StoredRoom, invite: unknown, name: unknown) {
    if (ws.memberId()) return this.send(ws, { type: 'error', message: '你已经在房间里了。' });
    if (typeof invite !== 'string' || !sameHash(await hash(invite), room.inviteHash)) return this.close(ws, '邀请链接无效或已经失效。');
    if (room.status === 'finished') return this.close(ws, '这场讨论已经结束。');
    if (room.members.length >= ROOM_LIMITS.members) return this.close(ws, `房间已满（最多 ${ROOM_LIMITS.members} 人）。`);
    const token = randomToken();
    const member: StoredMember = { id: uid(), name: cleanName(name), host: false, tokenHash: await hash(token), personalCalls: 0 };
    if (room.members.some(m => m.name === member.name)) member.name = member.name.slice(0, ROOM_LIMITS.nameLength - 2) + ' ' + (room.members.length + 1);
    room.members.push(member);
    room.entries.push({ id: uid(), kind: 'sys', text: `${member.name} 加入了讨论。` });
    await this.save();
    ws.setMember(member.id);
    this.send(ws, { type: 'welcome', memberId: member.id, token, room: this.view() });
    this.broadcast();
  }

  private async resume(ws: SocketLike, room: StoredRoom, token: unknown) {
    const h = typeof token === 'string' ? await hash(token) : '';
    const member = room.members.find(m => sameHash(h, m.tokenHash));
    if (!member) return this.close(ws, '邀请链接无效或已经失效。');
    ws.setMember(member.id);
    this.send(ws, { type: 'welcome', memberId: member.id, token: token as string, room: this.view() });
    this.broadcast();
  }

  /* ---------- 讨论流程 ---------- */
  private async act(room: StoredRoom, me: StoredMember, msg: Exclude<ClientMessage, { type: 'hello' | 'resume' | 'ask' | 'speak' | 'typing' | 'quickMessage' | 'listen' }>) {
    const hostOnly = () => { if (!me.host) throw new ApiError('只有房主可以这样做。'); };
    const live = () => { if (room.status !== 'live') throw new ApiError(room.status === 'lobby' ? '讨论还没有开始。' : '讨论已经结束。'); };
    const idle = () => { if (this.running) throw new ApiError('AI 正在发言，请稍等。'); };
    switch (msg.type) {
      case 'propose': {
        if (room.status === 'finished') throw new ApiError('讨论已经结束。');
        const text = str(msg.text, 40, '要点');
        const list = room.proposals ??= [];
        if (room.setup.keyPoints.length >= 6) throw new ApiError('讨论要点最多 6 个。');
        if (list.length >= ROOM_LIMITS.proposals || list.filter(p => p.by === me.id).length >= 2) throw new ApiError('待审核的提案太多了，请房主先处理。');
        const same = (a: string) => a.trim().toLocaleLowerCase() === text.toLocaleLowerCase();
        if (room.setup.keyPoints.some(same) || list.some(p => same(p.text))) throw new ApiError('这条要点已经有了。');
        // 房主自己写的要点直接加入；同学写的和 AI 提议的都要房主确认
        if (me.host && msg.source !== 'ai') { this.addPoint(room, text); break; }
        list.push({ id: uid(), text, source: msg.source === 'ai' ? 'ai' : 'human', proposer: me.name, by: me.id });
        break;
      }
      case 'decidePoint': {
        hostOnly();
        const list = room.proposals ?? [];
        const p = list.find(x => x.id === msg.id);
        if (!p) throw new ApiError('找不到这条提案。');
        room.proposals = list.filter(x => x !== p);
        if (msg.accept) this.addPoint(room, p.text);
        break;
      }
      case 'start': {
        hostOnly();
        if (room.status !== 'lobby') throw new ApiError('讨论已经开始。');
        room.status = 'live';
        const firstTurn = room.setup.turns[room.cursor];
        room.turnStartedAt = room.setup.mode === 'debate' && firstTurn && !this.waitsForPerson(firstTurn.role) ? 0 : this.deps.now();
        room.entries.push({ id: uid(), kind: 'sys', text: '讨论开始。' });
        if (room.setup.mode === 'roundtable') room.speaker = { kind: 'member', id: me.id };
        break;
      }
      case 'say': {
        live(); idle();
        const text = str(msg.text, ROOM_LIMITS.textLength, '发言');
        this.roomFull(room);
        this.typingUntil.delete(me.id);
        if (room.setup.mode === 'roundtable') {
          if (room.speaker?.kind !== 'member' || room.speaker.id !== me.id) throw new ApiError('还没轮到你发言。');
          room.entries.push({ id: uid(), kind: 'msg', who: me.id, memberId: me.id, name: me.name, human: true, text, source: 'human' });
          room.lastMember = me.id;
          room.speaker = { kind: 'ai', id: this.nextPersona(room) };
          room.turnStartedAt = 0;
        } else {
          const t = room.setup.turns[room.cursor];
          if (!t || me.seat !== t.role.id) throw new ApiError('还没轮到你的席位发言。');
          room.entries.push({ id: uid(), kind: 'msg', who: t.role.id, memberId: me.id, name: `${this.seatName(t.role.id)}（${me.name}）`, team: t.role.team, human: true, text, stage: t.stage, action: t.action, target: t.target, source: 'human' });
          this.advanceDebate(room);
        }
        break;
      }
      case 'pass': {
        live(); idle();
        if (room.setup.mode === 'roundtable') {
          const sp = room.speaker;
          if (!(me.host || (sp?.kind === 'member' && sp.id === me.id))) throw new ApiError('只有当前发言的人或房主可以跳过。');
          room.speaker = { kind: 'member', id: this.nextMember(room, sp?.kind === 'member' ? sp.id : room.lastMember) };
          room.turnStartedAt = this.deps.now();
          room.error = '';
        } else {
          const t = room.setup.turns[room.cursor];
          if (!t) throw new ApiError('比赛已经结束。');
          if (!(me.host || me.seat === t.role.id)) throw new ApiError('只有当前席位的同学或房主可以跳过。');
          room.entries.push({ id: uid(), kind: 'msg', who: t.role.id, name: this.seatName(t.role.id), team: t.role.team, text: '主席宣布：本席放弃本次发言。', stage: t.stage, action: t.action, target: t.target, skipped: true, source: 'human' });
          room.error = '';
          this.advanceDebate(room);
        }
        break;
      }
      case 'callOn': {
        hostOnly(); live(); idle();
        if (room.setup.mode !== 'roundtable') throw new ApiError('辩论按赛制轮流发言。');
        const target = msg.target;
        if (target?.kind === 'member' && room.members.some(m => m.id === target.id)) room.speaker = { kind: 'member', id: target.id };
        else if (target?.kind === 'ai' && room.setup.personas.some(p => p.id === target.id)) room.speaker = { kind: 'ai', id: target.id };
        else throw new ApiError('找不到这位发言者。');
        room.turnStartedAt = target?.kind === 'member' ? this.deps.now() : 0;
        room.error = '';
        break;
      }
      case 'aiTakeover': {
        hostOnly(); live(); idle();
        const t = room.setup.turns[room.cursor];
        if (room.setup.mode !== 'debate' || !t || !this.waitsForPerson(t.role)) throw new ApiError('现在不是同学的席位。');
        room.takeover = true;
        break;
      }
      case 'seat': {
        if (room.setup.mode !== 'debate') throw new ApiError('圆桌讨论没有席位。');
        if (room.status === 'finished') throw new ApiError('讨论已经结束。');
        const seat = msg.seat === null ? undefined : room.setup.seats.find(s => s.id === msg.seat)?.id;
        if (msg.seat !== null && !seat) throw new ApiError('找不到这个席位。');
        if (seat === me.seat) return;
        const other = seat ? this.owner(seat) : undefined;
        if (other) throw new ApiError(`${other.name} 已经坐在这个席位了。`);
        // 正在替这个席位生成发言时不能换，免得发言和人对不上
        const current = room.setup.turns[room.cursor]?.role.id;
        if (this.running && room.status === 'live' && (current === seat || current === me.seat)) throw new ApiError('这个席位正在发言，稍后再换。');
        me.seat = seat;
        room.entries.push({ id: uid(), kind: 'sys', text: seat ? `${me.name} 担任${this.seatName(seat)}。` : `${me.name} 离开席位，改为旁听。` });
        break;
      }
      case 'retry': { hostOnly(); live(); idle(); room.error = ''; break; }
      case 'finish': { hostOnly(); idle(); if (room.status === 'finished') return; this.finish(room); break; }
      default: throw new ApiError('不支持的操作。');
    }
    await this.save();
    this.broadcast();
    if (!['finish', 'propose', 'decidePoint'].includes(msg.type)) await this.runAI(room);
  }

  private advanceDebate(room: StoredRoom) {
    room.cursor++; room.takeover = false;
    const nextTurn = room.setup.turns[room.cursor];
    room.turnStartedAt = nextTurn && !this.waitsForPerson(nextTurn.role) ? 0 : this.deps.now();
    if (room.cursor >= room.setup.turns.length) this.finish(room);
  }
  private finish(room: StoredRoom) {
    room.status = 'finished'; room.speaker = null; room.takeover = false;
    room.entries.push({ id: uid(), kind: 'sys', text: '讨论结束。每个人可以查看自己的复盘。' });
    room.expiresAt = Math.min(room.expiresAt, this.deps.now() + ROOM_LIMITS.afterFinishMs);
    void this.deps.setAlarm(room.expiresAt);
  }
  private roomFull(room: StoredRoom) {
    if (room.entries.length >= ROOM_LIMITS.entries) { this.finish(room); throw new ApiError('这场讨论的记录已经很长了，讨论已结束，请查看复盘。'); }
  }

  // 轮到 AI 时连续生成，直到轮到真人；失败时停下并显示原因，不改变讨论进度
  private async runAI(room: StoredRoom) {
    if (this.running) return;
    this.running = true;
    try {
      while (room.status === 'live') {
        const debate = room.setup.mode === 'debate';
        const t = debate ? room.setup.turns[room.cursor] : undefined;
        const persona = !debate && room.speaker?.kind === 'ai' ? room.setup.personas.find(p => p.id === room.speaker!.id) : undefined;
        if (debate ? !(t && (!this.waitsForPerson(t.role) || room.takeover)) : !persona) break;
        if (room.error) break;
        if (room.aiCalls >= ROOM_LIMITS.aiCalls) {
          room.error = '这个房间的 AI 调用次数已经用完。房主可以结束讨论，大家各自复盘。';
          break;
        }
        const busy = debate ? `${this.seatName(t!.role.id)}正在组织发言` : `${persona!.name} 正在思考`;
        const cursor = room.cursor, speaker = JSON.stringify(room.speaker);
        room.aiBusy = busy; room.aiCalls++;
        await this.save(); this.broadcast();
        // 边生成边广播，大约每 150 毫秒合并一次，省消息数；完成后的正式发言沿用这个 id，界面能接着动画显示
        const id = uid();
        const relay = this.relay(id);
        try {
          const res = debate
            ? await this.deps.generate('debate', { session: snapshotFor(room, null) }, relay.push)
            : await this.deps.generate('discuss', { session: snapshotFor(room, null), roleId: persona!.id, task: room.lastMember ? undefined : '主持人请你接着前面的发言说。' }, relay.push);
          relay.stop();
          // 等待期间房主可能结束了讨论
          if (room.status !== 'live' || room.cursor !== cursor || JSON.stringify(room.speaker) !== speaker) break;
          const text = typeof res.text === 'string' ? res.text : '';
          if (!text) throw new ApiError('模型没有返回可用文本，请重试。');
          for (const i of res.covered ?? []) if (i >= 0 && i < room.setup.keyPoints.length && !room.covered.includes(i)) room.covered.push(i);
          if (debate) {
            room.entries.push({ id, kind: 'msg', who: t!.role.id, name: this.seatName(t!.role.id), team: t!.role.team, text, stage: t!.stage, action: t!.action, target: t!.target, source: 'api', model: res.model, terms: cleanTerms(res.terms) });
            this.advanceDebate(room);
          } else {
            room.entries.push({ id, kind: 'msg', who: persona!.id, name: persona!.name, text, source: 'api', model: res.model, terms: cleanTerms(res.terms) });
            room.speaker = { kind: 'member', id: this.nextMember(room, room.lastMember) };
            room.turnStartedAt = this.deps.now();
          }
        } catch (e) {
          relay.stop();
          room.error = e instanceof ApiError ? e.message : 'AI 发言失败。';
        } finally {
          relay.stop();
          room.aiBusy = null;
          await this.save(); this.broadcast();
        }
      }
      if (room.error) { await this.save(); this.broadcast(); }
    } finally { this.running = false; }
  }

  private relay(id: string) {
    let latest = '', sent = '', last = 0, timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const flush = () => {
      timer = undefined;
      if (stopped || latest === sent) return;
      sent = latest; last = this.deps.now();
      const data = JSON.stringify({ type: 'stream', id, text: latest } satisfies ServerMessage);
      for (const ws of this.deps.sockets()) if (ws.memberId()) { try { ws.send(data); } catch { /* 连接已断开 */ } }
    };
    return {
      push: (text: string) => {
        latest = text;
        if (stopped || timer) return;
        const wait = 150 - (this.deps.now() - last);
        if (wait <= 0) flush(); else timer = setTimeout(flush, wait);
      },
      stop: () => { stopped = true; clearTimeout(timer); }
    };
  }

  private nextPersona(room: StoredRoom) {
    const list = room.setup.personas;
    const p = list[room.nextPersona % list.length];
    room.nextPersona = (room.nextPersona + 1) % list.length;
    return p.id;
  }
  // 圆桌里下一位真人：按加入顺序轮流，跳过不在线的人；都不在线时交给房主
  private nextMember(room: StoredRoom, after: string | null) {
    const online = new Set(this.deps.sockets().map(s => s.memberId()));
    const list = room.members;
    const start = after ? list.findIndex(m => m.id === after) : -1;
    for (let k = 1; k <= list.length; k++) {
      const m = list[(start + k + list.length) % list.length];
      if (online.has(m.id)) return m.id;
    }
    return list.find(m => m.host)!.id;
  }
  private freeSeat() {
    const taken = new Set(this.room!.members.map(m => m.seat));
    return this.room!.setup.seats.find(s => s.type === 'human' && !taken.has(s.id))?.id;
  }
  // 有人坐的席位等这个人；留给同学（或标为“我”）但没人坐的席位也等，房主可以跳过或让 AI 代答；只有 AI 席位没人坐时由 AI 自动发言
  private waitsForPerson(seat: { id: string; type: string }) { return !!this.owner(seat.id) || seat.type !== 'ai'; }
  private owner(seat: string) { return this.room!.members.find(m => m.seat === seat); }
  private seatName(id: string) { return this.room!.setup.seats.find(s => s.id === id)?.name ?? id; }

  private addPoint(room: StoredRoom, text: string) {
    if (room.setup.keyPoints.length >= 6) throw new ApiError('讨论要点最多 6 个。');
    room.setup.keyPoints.push(text);
    if (room.entries.length < ROOM_LIMITS.entries) room.entries.push({ id: uid(), kind: 'sys', text: `新增讨论要点：${text}` });
  }

  /* ---------- 正在输入、快捷短语 ---------- */
  private typing(me: StoredMember, active: unknown) {
    if (typeof active !== 'boolean') throw new ApiError('输入状态无效。');
    const now = this.deps.now();
    const was = (this.typingUntil.get(me.id) ?? 0) > now;
    // 前端每隔几秒续一次；没续上（断网、关页面）就自动消失
    if (active) this.typingUntil.set(me.id, now + 6000); else this.typingUntil.delete(me.id);
    if (was !== active) this.broadcast();
  }
  private quick(room: StoredRoom, me: StoredMember, text: unknown) {
    if (room.status !== 'live') throw new ApiError('讨论进行中才能发送。');
    if (!(QUICK_MESSAGES as readonly unknown[]).includes(text)) throw new ApiError('只能发送列表里的快捷短语。');
    const now = this.deps.now();
    if (now - (this.lastQuick.get(me.id) ?? -Infinity) < ROOM_LIMITS.quickGapMs) throw new ApiError('发得太快了，过几秒再发。');
    this.lastQuick.set(me.id, now);
    const m: ServerMessage = { type: 'quick', memberId: me.id, name: me.name, text: text as string };
    for (const ws of this.deps.sockets()) if (ws.memberId()) this.send(ws, m);
  }

  /* ---------- 朗读 ---------- */
  // 走房主配置的讯飞额度，和 AI 调用分开计数；音频只发给点朗读的人
  private async speak(ws: SocketLike, room: StoredRoom, me: StoredMember, entryId: unknown, voice: unknown) {
    if (!this.deps.synthesize) throw new ApiError('房主的后端还没有配置讯飞语音。', 503);
    const entry = room.entries.find(e => e.id === entryId && e.kind === 'msg' && !e.skipped);
    if (!entry || entry.kind !== 'msg') throw new ApiError('找不到这条发言。');
    const vcn = cleanVoice(voice), key = entry.id + '|' + vcn;
    const cached = this.voiceCache.get(key);
    if (cached) {
      cached.forEach((audio, seq) => this.send(ws, { type: 'audio', entryId: entry.id, seq, last: seq === cached.length - 1, audio, mime: 'audio/mpeg' }));
      return;
    }
    if (this.speaking.has(me.id)) throw new ApiError('上一条朗读还在合成，请稍等。');
    if ((me.voiceCalls ?? 0) >= ROOM_LIMITS.personalVoice) throw new ApiError('你在这个房间里的朗读次数已经用完。', 429);
    if ((room.voiceCalls ?? 0) >= ROOM_LIMITS.voiceCalls) throw new ApiError('这个房间的朗读次数已经用完。', 429);
    const parts = splitForSpeech(entry.text);
    if (!parts.length) throw new ApiError('这条发言没有可以朗读的文字。');
    me.voiceCalls = (me.voiceCalls ?? 0) + 1; room.voiceCalls = (room.voiceCalls ?? 0) + 1;
    await this.save();
    this.speaking.add(me.id);
    try {
      const audio: string[] = [];
      // 一段一段合成、一段一段发，第一段到了就能开始播
      for (const [seq, part] of parts.entries()) {
        const r = await this.deps.synthesize(part, vcn);
        audio.push(r.audio);
        this.send(ws, { type: 'audio', entryId: entry.id, seq, last: seq === parts.length - 1, audio: r.audio, mime: r.mime });
      }
      this.remember(key, audio);
    } finally { this.speaking.delete(me.id); }
  }
  /* ---------- 语音输入 ---------- */
  // 也走房主的讯飞额度，单独计数；录音只转发不保存，识别结果只回给说话的人，由他自己决定发不发
  private async listen(ws: SocketLike, room: StoredRoom, me: StoredMember, msg: Extract<ClientMessage, { type: 'listen' }>) {
    const reply = (event: ListenEvent) => this.send(ws, { type: 'heard', event });
    const current = this.listening.get(me.id);
    if (msg.op !== 'start') {
      if (!current) return;
      if (msg.op === 'audio') current.audio(msg.audio);
      else if (msg.op === 'end') current.end();
      else { current.cancel(); this.listening.delete(me.id); }
      return;
    }
    try {
      if (!this.deps.listen) throw new ApiError('房主的后端还没有配置讯飞语音。', 503);
      if (room.status === 'finished') throw new ApiError('讨论已经结束。');
      if (current && !current.finished) throw new ApiError('上一段语音还没有识别完。');
      if ((me.listenCalls ?? 0) >= ROOM_LIMITS.personalListen) throw new ApiError('你在这个房间里的语音输入次数已经用完。', 429);
      if ((room.listenCalls ?? 0) >= ROOM_LIMITS.listenCalls) throw new ApiError('这个房间的语音输入次数已经用完。', 429);
      me.listenCalls = (me.listenCalls ?? 0) + 1; room.listenCalls = (room.listenCalls ?? 0) + 1;
      await this.save();
      const session = this.deps.listen(e => {
        reply(e);
        if (e.type === 'error' || (e.type === 'text' && e.final)) { if (this.listening.get(me.id) === session) this.listening.delete(me.id); }
      });
      this.listening.set(me.id, session);
      try { await session.start(); }
      catch (e) { this.listening.delete(me.id); throw e; }
      reply({ type: 'ready' });
    } catch (e) {
      // 只撤掉这次没开起来的；上一段还在识别的不受影响
      reply({ type: 'error', message: e instanceof ApiError ? e.message : '无法开始语音识别。' });
    }
  }

  private remember(key: string, audio: string[]) {
    const size = audio.reduce((n, a) => n + a.length, 0);
    if (size > VOICE_CACHE_BYTES / 4) return;
    this.voiceCache.set(key, audio); this.voiceBytes += size;
    // 超出上限时丢掉最早的
    for (const [k, v] of this.voiceCache) {
      if (this.voiceBytes <= VOICE_CACHE_BYTES) break;
      this.voiceCache.delete(k); this.voiceBytes -= v.reduce((n, a) => n + a.length, 0);
    }
  }

  /* ---------- 个人请求：提示、讲解、小结、复盘 ---------- */

  private async ask(ws: SocketLike, room: StoredRoom, me: StoredMember, msg: Extract<ClientMessage, { type: 'ask' }>) {
    const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 40) : '';
    const reply = (m: ServerMessage) => this.send(ws, m);
    try {
      if (this.asking.has(me.id)) throw new ApiError('上一个请求还没有完成。');
      if (me.personalCalls >= ROOM_LIMITS.personalCalls) throw new ApiError('你在这个房间里的提示和复盘次数已经用完。');
      if (room.aiCalls >= ROOM_LIMITS.aiCalls) throw new ApiError('这个房间的 AI 调用次数已经用完。');
      let purpose: Purpose, payload: unknown;
      if (msg.purpose === 'review') {
        if (room.status !== 'finished') throw new ApiError('讨论结束后才能复盘。');
        const reflections = Array.isArray(msg.reflections) ? msg.reflections.slice(0, ROOM_LIMITS.reflections).map(r => str(r, 1000, '小结')) : [];
        const spoke = room.entries.some(e => e.kind === 'msg' && e.memberId === me.id && !e.skipped);
        if (!spoke && !reflections.length) throw new ApiError('你在这场讨论里还没有发言，没有可以复盘的内容。');
        purpose = 'review'; payload = { session: snapshotFor(room, me.id, reflections) };
      } else {
        // 术语卡片结束后也能查，方便回看讨论
        if (room.status !== 'live' && !(msg.purpose === 'term' && room.status === 'finished')) throw new ApiError('讨论进行中才能使用。');
        const session = snapshotFor(room, me.id);
        if (msg.purpose === 'hint') {
          const t = room.setup.mode === 'debate' ? room.setup.turns[room.cursor] : undefined;
          purpose = 'hint'; payload = { session, covered: room.covered, task: t && me.seat === t.role.id ? `${this.seatName(t.role.id)}要进行${t.action}` : undefined };
        } else if (msg.purpose === 'explain') {
          const entry = room.entries.find(e => e.id === msg.entryId && e.kind === 'msg');
          if (!entry || entry.kind !== 'msg' || !(['unclear', 'example', 'fact'] as ExplainKind[]).includes(msg.kind)) throw new ApiError('找不到这句发言。');
          purpose = 'explain'; payload = { session, quote: entry.text.slice(0, 4000), kind: msg.kind };
        } else if (msg.purpose === 'term') {
          const entry = room.entries.find(e => e.id === msg.entryId && e.kind === 'msg');
          const term = typeof msg.term === 'string' ? msg.term.trim() : '';
          // 只能查房间里 AI 标出来的词，不能借这个接口随便调用模型
          if (!entry || entry.kind !== 'msg' || !entry.terms?.includes(term)) throw new ApiError('找不到这个词。');
          purpose = 'term'; payload = { session, term, quote: entry.text.slice(0, 400) };
        } else if (msg.purpose === 'reflect') {
          purpose = 'reflect'; payload = { session, answer: str(msg.answer, 1000, '小结') };
        } else if (msg.purpose === 'point') {
          if (room.setup.keyPoints.length >= 6) throw new ApiError('讨论要点最多 6 个。');
          purpose = 'point'; payload = { session };
        } else throw new ApiError('不支持的请求。');
      }
      this.asking.add(me.id);
      me.personalCalls++; room.aiCalls++;
      await this.save();
      try {
        const result = await this.deps.generate(purpose, payload);
        reply({ type: 'answer', reqId, ok: true, result });
      } finally { this.asking.delete(me.id); }
    } catch (e) {
      reply({ type: 'answer', reqId, ok: false, error: e instanceof ApiError ? e.message : 'AI 请求失败。' });
    }
  }

  /* ---------- 广播 ---------- */
  view(): RoomView {
    const room = this.room!;
    const online = new Set(this.deps.sockets().map(s => s.memberId()).filter(Boolean));
    const now = this.deps.now();
    const members: RoomMember[] = room.members.map(m => ({ id: m.id, name: m.name, host: m.host, seat: m.seat, online: online.has(m.id), typing: online.has(m.id) && (this.typingUntil.get(m.id) ?? 0) > now }));
    return {
      id: room.id, status: room.status, setup: room.setup, members, entries: room.entries, covered: room.covered,
      cursor: room.cursor, speaker: room.speaker, aiBusy: room.aiBusy, error: room.error, aiCalls: room.aiCalls, expiresAt: room.expiresAt,
      now, turnStartedAt: room.turnStartedAt, voiceAvailable: !!this.deps.synthesize, listenAvailable: !!this.deps.listen, proposals: room.proposals ?? []
    };
  }
  private broadcast() {
    if (!this.room) return;
    const data = JSON.stringify({ type: 'state', room: this.view() } satisfies ServerMessage);
    for (const ws of this.deps.sockets()) if (ws.memberId()) { try { ws.send(data); } catch { /* 连接已断开 */ } }
  }
  private send(ws: SocketLike, m: ServerMessage) { try { ws.send(JSON.stringify(m)); } catch { /* 连接已断开 */ } }
  private close(ws: SocketLike, reason: string) {
    this.send(ws, { type: 'closed', reason });
    try { ws.close(4000, 'closed'); } catch { /* 已关闭 */ }
  }
}

/* ---------- 接到 Durable Object ---------- */
// 只用到 Durable Object 的这几个能力；不引入 @cloudflare/workers-types，保持可在 Node 里类型检查
interface HibernatingSocket { send(d: string): void; close(code?: number, reason?: string): void; serializeAttachment(v: unknown): void; deserializeAttachment(): unknown }
interface DOState {
  storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; deleteAll(): Promise<void>; setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void> };
  acceptWebSocket(ws: HibernatingSocket): void;
  getWebSockets(): HibernatingSocket[];
}
declare const WebSocketPair: { new(): { 0: HibernatingSocket; 1: HibernatingSocket } };

// 内存里最多缓存这么多音频（base64 字节数）
const VOICE_CACHE_BYTES = 16 * 1024 * 1024;

const wrap = (ws: HibernatingSocket): SocketLike => ({
  send: d => ws.send(d),
  close: (c, r) => ws.close(c, r),
  memberId: () => { const a = ws.deserializeAttachment(); return isObj(a) && typeof a.memberId === 'string' ? a.memberId : null; },
  setMember: id => ws.serializeAttachment({ memberId: id })
});

export function roomClass<E>(makeGenerate: (env: E) => Generate, makeSynthesize?: (env: E) => RoomDeps['synthesize'], makeListen?: (env: E) => RoomDeps['listen']) {
  return class Room {
    core: RoomCore;
    ctx: DOState;
    constructor(ctx: DOState, env: E) {
      this.ctx = ctx;
      this.core = new RoomCore({
        load: () => ctx.storage.get<StoredRoom>('room'),
        save: r => ctx.storage.put('room', r),
        destroy: async () => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); },
        sockets: () => ctx.getWebSockets().map(wrap),
        setAlarm: at => ctx.storage.setAlarm(at),
        generate: makeGenerate(env),
        synthesize: makeSynthesize?.(env),
        listen: makeListen?.(env),
        now: () => Date.now()
      });
    }
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path === '/init' && req.method === 'POST') {
        try {
          return Response.json(await this.core.init(await req.json()));
        } catch (e) {
          return Response.json({ error: e instanceof ApiError ? e.message : '没能创建房间。' }, { status: e instanceof ApiError ? e.status : 500 });
        }
      }
      if (path === '/ws' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        await this.core.onOpen(wrap(pair[1]));
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
      }
      return Response.json({ error: '接口不存在。' }, { status: 404 });
    }
    async webSocketMessage(ws: HibernatingSocket, message: string | ArrayBuffer) { await this.core.onMessage(wrap(ws), message); }
    async webSocketClose(ws: HibernatingSocket) { try { ws.close(1000); } catch { /* 已关闭 */ } await this.core.onClose(wrap(ws)); }
    async webSocketError() { await this.core.onClose(); }
    async alarm() { await this.core.alarm(); }
  };
}
