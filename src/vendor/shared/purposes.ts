// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// AI 的用途清单：前端、本机服务和 Worker 都从这里取，新增用途只改这一处
import type { Purpose } from './types.ts';

export const PURPOSES: Purpose[] = ['prepare', 'discuss', 'debate', 'hint', 'explain', 'reflect', 'review', 'term', 'point'];

// 这些用途输出的是给人读的文字，可以边生成边显示；准备、复盘、术语卡片要等完整 JSON 校验后才能用
export const STREAMABLE: Purpose[] = ['discuss', 'debate', 'hint', 'explain', 'reflect'];
