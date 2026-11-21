// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
import type { ModeId, StageKind } from './types.ts';

export interface ModeInfo {
  name: string;
  short: string;
  /** 学习页卡片上的一句话说明 */
  desc: string;
}

export const MODES: Record<ModeId, ModeInfo> = {
  socratic: {
    name: '苏格拉底追问',
    short: '追问',
    desc: 'AI 一步步追问，陪你把它想清楚。',
  },
  roundtable: {
    name: '圆桌讨论',
    short: '圆桌',
    desc: '三位不同背景的 AI 各说视角，你来主持。',
  },
  teach: {
    name: '讲给 AI 听',
    short: '讲解',
    desc: '你来讲，AI 当学生听你讲、提疑问。',
  },
  debate: {
    name: '正反辩论',
    short: '辩论',
    desc: '分正反方，按赛制交锋。',
  },
  canvas: {
    name: '知识画布',
    short: '画布',
    desc: '从一句话分出枝来深挖，聊完带回主干。',
  },
};

// 学习页能选的讨论方式。“讲给 AI 听”（teach）从概念笔记里开始；知识画布并进了追问和圆桌（#142），
// MODES 里保留它，旧的画布讨论还要显示名字
export const MODE_ORDER: ModeId[] = ['socratic', 'roundtable', 'debate'];

/** 能从一句发言展开分支的讨论方式（知识画布，#142）。辩论不带分支。 */
export const BRANCH_MODES: ModeId[] = ['socratic', 'roundtable', 'canvas'];

export const STAGE_KINDS: Record<StageKind, string> = {
  opening: '立论 · 双方一辩',
  cross: '质询 · 问答配对',
  free: '自由辩论 · 双方轮替',
  closing: '总结 · 双方末辩',
};

export const STATUS_LABEL = { mastered: '已掌握', partial: '还模糊', missing: '没讲到' } as const;
