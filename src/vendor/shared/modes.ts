// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
import type { ModeId, StageKind } from './types.ts';

export interface ModeInfo { name: string; short: string; desc: string; when: string }

export const MODES: Record<ModeId, ModeInfo> = {
  socratic: { name: '苏格拉底追问', short: '追问', desc: 'AI 陪你一步步想，用好问题和例子帮你发现哪里没想清；想检验自己，可以换你来讲给它听。', when: '刚接触一个概念，或者想检验能不能讲清楚' },
  roundtable: { name: '圆桌讨论', short: '圆桌', desc: '三位不同学科背景的 AI 各说各的视角，你来主持。', when: '想从几个角度看同一个概念' },
  teach: { name: '反向讲解', short: '讲解', desc: '你当老师，AI 扮演困惑的学生，听你讲、复述、提疑问。', when: '已经有些理解，检验能不能讲清楚' },
  debate: { name: '正反辩论', short: '辩论', desc: '分正反方按赛制交锋，席位和流程都可以自定。', when: '概念有争议或有多种解释' },
  canvas: { name: '知识画布', short: '画布', desc: '讨论像一棵树：遇到想深挖的词，就从那句话分出一枝单独聊，聊完带回主干。', when: '一个概念牵出很多新概念，想深挖又怕聊跑题' }
};

// 反向讲解已并进苏格拉底追问（讨论中“换我来讲”）；MODES 里保留它，旧的讨论和知识卡片还要显示名字
export const MODE_ORDER: ModeId[] = ['socratic', 'roundtable', 'debate', 'canvas'];

export const STAGE_KINDS: Record<StageKind, string> = {
  opening: '立论 · 双方一辩',
  cross: '质询 · 问答配对',
  free: '自由辩论 · 双方轮替',
  closing: '总结 · 双方末辩'
};

export const STATUS_LABEL = { mastered: '已掌握', partial: '还模糊', missing: '没讲到' } as const;
