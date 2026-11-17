// 房间的纯函数：令牌与哈希、输入清洗、讨论设置校验、发给 AI 的讨论快照。
// 不碰房间状态，单独放一个文件，房间类（room.ts）只管状态和消息。
import { ApiError } from './vendor/server/ai.ts';
import type { ChatMessage, Persona, SessionSnapshot, Stage, StageKind, Turn } from './vendor/shared/types.ts';
import { ROOM_LIMITS, type RoomSeat, type RoomSetup } from './vendor/shared/room.ts';
import type { StoredRoom } from './room.ts';

/* ---------- 工具 ---------- */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 只保存邀请码和成员凭据的哈希，比较哈希值不会因为长度或前缀泄露信息
export async function hash(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
export function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export const uid = () => randomToken().slice(0, 10);
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function str(v: unknown, max: number, label: string, required = true): string {
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
export const KINDS: StageKind[] = ['opening', 'cross', 'free', 'closing'];
export function validateSetup(v: unknown): RoomSetup {
  if (!isObj(v) || (v.mode !== 'roundtable' && v.mode !== 'debate')) throw new ApiError('多人讨论只支持圆桌讨论和正反辩论。');
  const mode = v.mode;
  const keyPoints = Array.isArray(v.keyPoints) ? v.keyPoints.map(k => str(k, 60, '要点')) : [];
  if (keyPoints.length < 2 || keyPoints.length > 6) throw new ApiError('要点需要 2 到 6 个。');
  const setup: RoomSetup = {
    mode, concept: str(v.concept, 80, '概念'), topic: str(v.topic, 300, '讨论题'), keyPoints,
    personas: [], opening: '', seats: [], stages: [], turns: [],
    turnSeconds: [0, 30, 60, 90, 120].includes(v.turnSeconds as number) ? v.turnSeconds as number : 0,
    context: typeof v.context === 'string' && v.context.trim() ? v.context.trim().slice(0, 600) : undefined,
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
    stages: debate ? setup.stages : undefined, finished: room.status === 'finished', context: setup.context
  };
}

/* ---------- 房间 ---------- */
