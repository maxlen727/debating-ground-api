// 读材料（#157）：Worker 替网页版取链接的正文。规则和提取在 shared/pages.ts（vendor 里的副本），这里只做网络请求。
// Worker 的请求从 Cloudflare 的网络发出，连不到部署者的局域网；链接本身和跳转的每一跳照样检查，不让它去访问 IP 写死的内网地址。
import {
  FETCH_HEADERS,
  PAGE_LIMITS,
  checkTarget,
  decodeBody,
  nextHop,
  type Fetched,
  type Get,
} from './vendor/shared/pages.ts';

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > PAGE_LIMITS.bytes) {
      await reader.cancel().catch(() => {});
      throw new Error('这个页面太大了（超过 3 MB），没法读取。可以把正文复制过来贴上。');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 取一个地址：自己跟着跳转走（Workers 不支持 redirect: 'error'，用 manual），每一跳都检查。 */
export function workerGet(fetchImpl: typeof fetch, timeoutMs: number = PAGE_LIMITS.timeoutMs): Get {
  return async (start: string): Promise<Fetched> => {
    const bad = checkTarget(start);
    if (bad) throw new Error(bad);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let url = start;
      for (let hop = 0; ; hop++) {
        let res: Response;
        try {
          res = await fetchImpl(url, {
            headers: FETCH_HEADERS,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (e) {
          throw new Error(
            (e as Error).name === 'AbortError'
              ? '网站太久没有回应，没能读取。可以稍后再试，或者把正文复制过来贴上。'
              : '没能连上这个网站。可以稍后再试，或者把正文复制过来贴上。',
            { cause: e },
          );
        }
        const location = res.headers.get('Location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => {});
          if (hop >= PAGE_LIMITS.redirects) throw new Error('这个链接跳转了太多次，没能读取。');
          url = nextHop(url, location);
          continue;
        }
        const contentType = res.headers.get('Content-Type') ?? '';
        return {
          status: res.status,
          url,
          contentType,
          body: decodeBody(await readCapped(res), contentType),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
