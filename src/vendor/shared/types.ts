// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 前端与本机服务共用的数据结构

export type ModeId = 'socratic' | 'roundtable' | 'teach' | 'debate';
export type Team = 'A' | 'B';
export type PointStatus = 'mastered' | 'partial' | 'missing';
export type StageKind = 'opening' | 'cross' | 'free' | 'closing';
export type ExplainKind = 'unclear' | 'example' | 'fact';
export type Source = 'human' | 'demo' | 'api';

export interface Persona { id: string; name: string; title: string; persona: string; tone: 'a' | 'b' | 'c' }

// human：我；peer：留给同学（多人讨论时等同学入座，单人讨论时由 AI 担任）；ai：AI 担任（多人讨论时同学也可以坐）
export interface SeatConfig { type: 'human' | 'peer' | 'ai'; bg: string }
export interface Seat extends SeatConfig { id: string; team: Team; index: number }
export interface Stage { name: string; kind: StageKind; rounds: number }
export interface Turn { role: Seat; action: string; target?: string; stage: number; round: number }

export interface ChatMessage {
  id: string;
  kind: 'msg';
  who: string;          // 'learner'、角色 id 或席位 id
  name: string;
  text: string;
  source: Source;
  model?: string;
  human?: boolean;
  team?: Team;
  stage?: number;
  action?: string;
  target?: string;
  skipped?: boolean;
  memberId?: string;    // 多人房间里，这条发言来自哪位成员
  terms?: string[];     // 发言里学习者可能不熟悉的术语（不含概念本身和要点）
}
export interface SystemLine { id: string; kind: 'sys'; text: string }
export interface Reflection { id: string; kind: 'reflect'; text: string; feedback: string; draft: string }
export type Entry = ChatMessage | SystemLine | Reflection;

export interface QuizItem { q: string; options: string[]; answer: number; why: string }
export interface Review {
  oneLine: string;
  points: { label: string; status: PointStatus; note: string }[];
  misconceptions: { said: string; fix: string }[];
  stances?: { said: string; note: string }[];   // 学习者的立场：只点评理由，不判对错（旧卡片没有这一项）
  quiz: QuizItem[];
}

export interface Previous { oneLine: string; weak: string[] }

// 发给本机服务的讨论快照（不含界面状态）
export interface SessionSnapshot {
  mode: ModeId;
  concept: string;
  topic: string;
  keyPoints: string[];
  roles: { id: string; name: string; title: string; persona: string }[];
  messages: { kind: 'msg' | 'reflect'; name: string; text: string; action?: string }[];
  turns?: Turn[];
  cursor?: number;
  stages?: Stage[];
  finished?: boolean;
  context?: string;     // 学习者交代的背景（具体事件类的话题）
}

// needsContext：输入是一件具体的事、模型不了解经过时，先请学习者交代背景（这时其他字段为空）
export interface PrepareResult { concept: string; topic: string; keyPoints: string[]; roles: { name: string; title: string; persona: string }[]; opening: string; needsContext?: string }

export type Purpose = 'prepare' | 'discuss' | 'debate' | 'hint' | 'explain' | 'reflect' | 'review' | 'term' | 'point';

// 术语小卡片：讨论中遇到的陌生词
export interface TermCard { term: string; definition: string; relation: string }
// AI 提议的新讨论要点：要经过人确认才进入要点清单
export interface PointSuggestion { point: string; why: string }

export interface TextResult { text: string; model?: string }
export interface CoverResult { text: string; covered: number[]; terms?: string[]; model?: string }
export interface DataResult<T> { data: T; model?: string }

export interface PayloadMap {
  prepare: { concept: string; mode: ModeId; previous?: Previous | null; context?: string };
  discuss: { session: SessionSnapshot; roleId: string; task?: string };
  debate: { session: SessionSnapshot };
  hint: { session: SessionSnapshot; covered: number[]; task?: string };
  explain: { session: SessionSnapshot; quote: string; kind: ExplainKind };
  reflect: { session: SessionSnapshot; answer: string };
  review: { session: SessionSnapshot };
  term: { session: SessionSnapshot; term: string; quote?: string };
  point: { session: SessionSnapshot };
}
export interface ResultMap {
  prepare: DataResult<PrepareResult>;
  discuss: CoverResult;
  debate: CoverResult;
  hint: TextResult;
  explain: TextResult;
  reflect: CoverResult;
  review: DataResult<Review>;
  term: DataResult<TermCard>;
  point: DataResult<PointSuggestion>;
}
