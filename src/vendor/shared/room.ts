// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 多人房间：浏览器与后端（Durable Object）之间的消息格式。
// 房间状态以后端为准，浏览器只发“意图”（发言、跳过、点名），由后端判断是否轮到这个人。
import type { ChatMessage, ExplainKind, Persona, Seat, Stage, SystemLine, Turn } from './types.ts';

export type RoomMode = 'roundtable' | 'debate';
export type RoomStatus = 'lobby' | 'live' | 'finished';

// 这些上限保护房主的 AI 额度，也限制房间里能存多少内容
export const ROOM_LIMITS = {
  members: 8,
  nameLength: 20,
  textLength: 2000,
  entries: 300,
  aiCalls: 150,          // 整个房间（AI 发言 + 每个人的提示、讲解、小结、复盘）
  personalCalls: 30,     // 每位成员自己的提示、讲解、小结、复盘
  reflections: 6,
  lifetimeMs: 4 * 3600_000,       // 创建后最多存在 4 小时
  afterFinishMs: 3600_000         // 结束后保留 1 小时，让每个人取到自己的复盘
} as const;

export interface RoomSeat extends Seat { name: string }

// 房主创建房间时提交的内容（来自准备页）
export interface RoomSetup {
  mode: RoomMode;
  concept: string;
  topic: string;
  keyPoints: string[];
  personas: Persona[];   // 圆桌的 AI 嘉宾
  opening: string;       // 圆桌的开场白（准备阶段已经生成）
  seats: RoomSeat[];     // 辩论席位
  stages: Stage[];
  turns: Turn[];
  model?: string;
}

export interface RoomMember { id: string; name: string; host: boolean; online: boolean; seat?: string }

// 当前该谁说：成员、AI 嘉宾（圆桌）或辩论席位
export type Speaker = { kind: 'member'; id: string } | { kind: 'ai'; id: string } | null;

export interface RoomView {
  id: string;
  status: RoomStatus;
  setup: RoomSetup;
  members: RoomMember[];
  entries: (ChatMessage | SystemLine)[];
  covered: number[];
  cursor: number;        // 辩论进行到第几次发言
  speaker: Speaker;      // 圆桌当前发言者；辩论由 cursor 决定
  aiBusy: string | null; // 正在生成的 AI 发言说明
  error: string;         // AI 发言失败的原因，房主可以重试
  aiCalls: number;
  expiresAt: number;
}

export type PersonalPurpose = 'hint' | 'explain' | 'reflect' | 'review' | 'term';

export type ClientMessage =
  | { type: 'hello'; invite: string; name: string }
  | { type: 'resume'; token: string }
  | { type: 'start' }                                   // 房主
  | { type: 'say'; text: string }
  | { type: 'pass' }                                    // 当前发言者自己跳过，或房主跳过当前发言
  | { type: 'callOn'; target: Speaker }                 // 房主点名（圆桌）
  | { type: 'aiTakeover' }                              // 房主让 AI 代答当前同学的席位（辩论）
  | { type: 'seat'; seat: string | null }               // 辩论：选择席位，null 表示旁听
  | { type: 'retry' }                                   // 房主重试失败的 AI 发言
  | { type: 'finish' }                                  // 房主结束讨论
  | { type: 'ask'; reqId: string; purpose: 'hint'; task?: string }
  | { type: 'ask'; reqId: string; purpose: 'explain'; entryId: string; kind: ExplainKind }
  | { type: 'ask'; reqId: string; purpose: 'reflect'; answer: string }
  | { type: 'ask'; reqId: string; purpose: 'term'; entryId: string; term: string }
  | { type: 'ask'; reqId: string; purpose: 'review'; reflections: string[] };

export type ServerMessage =
  | { type: 'welcome'; memberId: string; token: string; room: RoomView }
  | { type: 'state'; room: RoomView }
  | { type: 'answer'; reqId: string; ok: true; result: unknown }
  | { type: 'answer'; reqId: string; ok: false; error: string }
  | { type: 'error'; message: string }
  | { type: 'stream'; id: string; text: string }       // AI 正在生成的发言（目前能显示的完整文字），完成后以同一个 id 出现在讨论记录里
  | { type: 'closed'; reason: string };                // 房间不存在、已过期或邀请无效，不要再重连

export interface CreatedRoom { roomId: string; invite: string; hostToken: string; expiresAt: number }

export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
