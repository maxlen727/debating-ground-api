// 自动生成，请勿修改。源文件在仓库根目录，修改后运行 npm run sync:worker。
// 读材料（#144、#157）：从链接取正文。本机服务、Worker 和原生版（打包进 sibian-ai.js）共用这一份。
// 取哪个地址由这里的规则决定（学习者给的链接，或者 arXiv 这类正规途径），不由模型决定：
// 网页内容是资料不是指令，不能让它把研读助手引到别的地址去。
// 这里只做纯计算（地址检查、该取哪几个地址、从 HTML 里提取正文、判断是不是全文），真正的网络请求由各端自己做。

export const PAGE_LIMITS = {
  bytes: 3_000_000, // 页面最大多少字节
  redirects: 4, // 最多跳转几次
  timeoutMs: 15_000,
  text: 300_000, // 和研读的材料上限一样
  short: 1000, // 正文少于这么多字，多半不是全文
} as const;

export const FETCH_HEADERS = {
  // 如实说明是谁在取，不伪装成浏览器
  'User-Agent':
    'Mozilla/5.0 (compatible; SibianReader/1.0; +https://github.com/maxlen727/debating-ground)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/* ---------- 地址检查（防 SSRF） ---------- */

/** IPv4 地址是不是本机、局域网或保留地址。 */
export function isBlockedIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 运营商级 NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // 组播和保留
  );
}

/** IPv6 地址（不带方括号）是不是本机、局域网或保留地址。 */
export function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (!ip.includes(':')) return false;
  if (ip === '::' || ip === '::1') return true;
  // 末尾写成 IPv4 的地址：IPv4 映射（::ffff:a.b.c.d）按 IPv4 判断，其余（NAT64 之类）一律不认
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return /^::(ffff:)?(\d|$)/.test(ip) ? isBlockedIPv4(v4[1]) : true;
  const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16),
      lo = parseInt(mapped[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (first & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
    (first & 0xff00) === 0xff00 || // 组播
    first === 0x64 || // 64:ff9b::/96 这类转换地址
    first === 0 // ::/8 里的其余保留地址
  );
}

export const isBlockedIP = (ip: string) => isBlockedIPv4(ip) || isBlockedIPv6(ip);

/** 能不能去取这个地址：返回 null 表示可以，否则是给学习者看的原因。连接时还要再查一次解析出的 IP。 */
export function checkTarget(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '这不是一个有效的链接。';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return '只能读取 http 或 https 开头的链接。';
  if (u.username || u.password) return '链接里不能带用户名和密码。';
  // 只走默认端口：不让链接去探局域网里别的服务
  if (u.port) return '只能读取用默认端口的网页链接。';
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa') ||
    // 只写一段数字、十六进制这类地址，浏览器会当成 IP：一律不认
    (/^[0-9.]+$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ||
    /(^|\.)0x[0-9a-f]*(\.|$)/i.test(host) ||
    isBlockedIP(host) ||
    !host.includes('.')
  )
    return '不能读取本机或局域网里的地址。';
  return null;
}

/* ---------- 该取哪几个地址 ---------- */

export type PageKind = 'arxiv-html' | 'arxiv-abstract' | 'page';
export interface Candidate {
  url: string;
  kind: PageKind;
}

const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/;

/** arXiv 的论文号：链接（abs、pdf、html）或者“arXiv:2401.01234”这样的写法。 */
export function arxivId(link: string): string | null {
  const t = link.trim();
  const bare = t.match(new RegExp(`^(?:arxiv:)?${ARXIV_ID.source}$`, 'i'));
  if (bare) return bare[1] + (bare[2] ?? '');
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (!/^(www\.|export\.)?arxiv\.org$/i.test(u.hostname)) return null;
  const m = u.pathname.match(new RegExp(`^/(?:abs|pdf|html)/${ARXIV_ID.source}(?:\\.pdf)?/?$`));
  return m ? m[1] + (m[2] ?? '') : null;
}

/**
 * 一个链接要依次试哪几个地址：arXiv 的论文先试 HTML 全文，没有再用 arXiv 的接口拿摘要；
 * 其他链接就取它本身。返回字符串是不能读取的原因。
 */
export function candidatesFor(link: string): Candidate[] | string {
  const id = arxivId(link);
  if (id)
    return [
      { url: `https://arxiv.org/html/${id}`, kind: 'arxiv-html' },
      {
        url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id.replace(/v\d+$/, ''))}`,
        kind: 'arxiv-abstract',
      },
    ];
  let t = link.trim();
  if (!/^[a-z]+:\/\//i.test(t) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t)) t = 'https://' + t;
  const bad = checkTarget(t);
  if (bad) return bad;
  return [{ url: new URL(t).toString(), kind: 'page' }];
}

/* ---------- 从 HTML 里提取正文 ---------- */

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
// 内容原样跳过的元素（里面不是正文）
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp']);
// 整块去掉的元素
const DROP = new Set([
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'dialog',
  'svg',
  'canvas',
  'iframe',
  'object',
  'video',
  'audio',
  'picture',
  'img',
  'script',
  'style',
  'noscript',
  'template',
]);
// class 或 id 里带这些词的块多半不是正文
const NOISE =
  /(^|[\s_-])(nav|navbar|menu|footer|sidebar|comments?|share|social|related|recommend|advert|ads|cookie|subscribe|newsletter|banner|breadcrumbs?|toolbar|popup|modal|ltx_page_footer|ltx_bibliography|ltx_note|editsection|infobox|navbox|reflist|catlinks|toc|hatnote|noprint|sitesub|jump-link)($|[\s_-])/i;
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dl',
  'dt',
  'dd',
  'hr',
  'address',
  'details',
  'summary',
  'caption',
]);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  minus: '−',
  laquo: '«',
  raquo: '»',
  shy: '',
  zwj: '',
  zwnj: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi, (all, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    const v = ENTITIES[name.toLowerCase()];
    return v ?? all;
  });
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** 把 HTML 读成一棵很简单的树：容错，只为了提取正文，不追求和浏览器一模一样。 */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  const close = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--)
      if (stack[i].tag === tag) {
        stack.length = i;
        return;
      }
  };
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      top().children.push(html.slice(i));
      break;
    }
    if (lt > i) top().children.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const m = html
      .slice(lt, lt + 4096)
      .match(/^<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/);
    if (!m) {
      top().children.push('<');
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      close(tag);
      continue;
    }
    // 段落和列表项不一定写结束标签：遇到新的块就先关掉上一个
    if (BLOCK.has(tag) && top().tag === 'p') stack.pop();
    if (tag === 'li') {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === 'ul' || stack[k].tag === 'ol') break;
        if (stack[k].tag === 'li') {
          stack.length = k;
          break;
        }
      }
    }
    const el: El = { tag, attrs: attrsOf(m[3]), children: [] };
    top().children.push(el);
    if (RAW.has(tag)) {
      const end = lower.indexOf(`</${tag}`, i);
      const body = html.slice(i, end < 0 ? html.length : end);
      el.children.push(body);
      i = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
      continue;
    }
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) stack.push(el);
  }
  return root;
}

const isEl = (n: El | string): n is El => typeof n !== 'string';

function find(el: El, pred: (e: El) => boolean, out: El[] = []): El[] {
  for (const c of el.children)
    if (isEl(c)) {
      if (pred(c)) out.push(c);
      find(c, pred, out);
    }
  return out;
}

const dropped = (e: El) =>
  DROP.has(e.tag) ||
  e.attrs.hidden !== undefined ||
  e.attrs['aria-hidden'] === 'true' ||
  /display\s*:\s*none/i.test(e.attrs.style ?? '') ||
  NOISE.test(e.attrs.class ?? '') ||
  NOISE.test(e.attrs.id ?? '') ||
  ['navigation', 'banner', 'contentinfo', 'complementary', 'search'].includes(e.attrs.role ?? '');

/** 把一块元素排成纯文字：标题变成 Markdown 标题（研读时按节切），段落之间空一行。 */
function render(el: El): string {
  const out: string[] = [];
  const walk = (n: El | string, pre: boolean) => {
    if (!isEl(n)) {
      out.push(pre ? decodeEntities(n) : decodeEntities(n).replace(/\s+/g, ' '));
      return;
    }
    if (dropped(n) || RAW.has(n.tag)) return;
    // 公式：用它的文字形式
    if (n.tag === 'math') {
      const alt = n.attrs.alttext;
      if (alt) out.push(` ${alt} `);
      else n.children.forEach(c => walk(c, pre));
      return;
    }
    if (n.tag === 'br') return void out.push('\n');
    const h = n.tag.match(/^h([1-6])$/);
    if (h) {
      const text = render({ ...n, tag: 'span' })
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push(`\n\n${'#'.repeat(Math.min(4, Number(h[1])))} ${text}\n\n`);
      return;
    }
    const block = BLOCK.has(n.tag);
    if (n.tag === 'li') out.push('\n- ');
    else if (n.tag === 'tr') out.push('\n');
    else if (block) out.push('\n\n');
    for (const c of n.children) walk(c, pre || n.tag === 'pre');
    if (n.tag === 'td' || n.tag === 'th') out.push(' ');
    if (block && n.tag !== 'li') out.push('\n\n');
  };
  walk(el, false);
  return out
    .join('')
    .split('\n')
    .map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n- \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const textLength = (el: El) => render(el).replace(/\s+/g, '').length;

function titleOf(doc: El): string {
  const meta = find(
    doc,
    e =>
      e.tag === 'meta' &&
      /^(og:title|citation_title)$/i.test(e.attrs.property ?? e.attrs.name ?? ''),
  )[0];
  const title = find(doc, e => e.tag === 'title')[0];
  const h1 = find(doc, e => e.tag === 'h1')[0];
  const raw =
    meta?.attrs.content ||
    (title && decodeEntities(title.children.filter(c => typeof c === 'string').join(''))) ||
    (h1 ? render(h1) : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 从一个网页里挑出正文区域（article、main 里字最多的那个；都很短就用整个 body），排成纯文字。 */
export function extractHtml(html: string): { title: string; text: string } {
  const doc = parseHtml(html);
  const body = find(doc, e => e.tag === 'body')[0] ?? doc;
  const all = textLength(body);
  const regions = find(
    body,
    e =>
      e.tag === 'article' ||
      e.tag === 'main' ||
      e.attrs.role === 'main' ||
      /(^|\s)ltx_document(\s|$)/.test(e.attrs.class ?? ''),
  )
    .filter(e => !dropped(e))
    .map(e => ({ e, n: textLength(e) }))
    .sort((a, b) => b.n - a.n);
  const best = regions[0] && regions[0].n >= Math.min(1000, all * 0.3) ? regions[0].e : body;
  return { title: titleOf(doc), text: render(best).slice(0, PAGE_LIMITS.text) };
}

/** arXiv 接口返回的 Atom：标题和摘要。 */
export function extractArxivAtom(xml: string): { title: string; text: string } | null {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const pick = (tag: string) =>
    decodeEntities(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const title = pick('title');
  const summary = pick('summary');
  if (!title || !summary) return null;
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m =>
    decodeEntities(m[1]).trim(),
  );
  return {
    title,
    text: `${authors.length ? '作者：' + authors.slice(0, 8).join('、') + (authors.length > 8 ? ' 等' : '') + '\n\n' : ''}## 摘要\n\n${summary}`,
  };
}

/* ---------- 判断取到的是不是全文 ---------- */

/** 一次请求的结果（各端自己做网络请求，交给这里判断）。 */
export interface Fetched {
  status: number;
  url: string; // 跳转之后的地址
  contentType: string;
  body: string;
}

export type LinkResult =
  | {
      ok: true;
      title: string;
      text: string;
      url: string;
      kind: PageKind;
      complete: boolean;
      note: string;
    }
  | { ok: false; reason: string };

const PASTE = '可以在浏览器里打开它，把正文复制过来贴上。';
const BLOCKED =
  /(just a moment|cf-chl|cf_chl|challenge-platform|captcha|are you a robot|verify you are human|access denied|请完成安全验证|安全验证|人机验证|验证码|访问受限|请登录后|登录后查看|访问过于频繁)/i;
const PAYWALL =
  /(subscribe to (continue|read)|subscribers only|sign in to (continue|read)|purchase (this )?article|buy this article|paywall|订阅后|付费阅读|开通会员|购买后|登录后阅读)/i;

/** 判断一次请求拿到的内容：能不能用、是不是全文。返回 null 表示这个地址不行，该试下一个（比如 arXiv 没有 HTML 版）。 */
export function readFetched(c: Candidate, f: Fetched): LinkResult | null {
  const type = f.contentType.toLowerCase();
  if (c.kind === 'arxiv-html' && f.status === 404) return null;
  if ([401, 403, 429, 503].includes(f.status))
    return {
      ok: false,
      reason: `这个网站拦住了自动读取（${f.status === 429 ? '请求太频繁' : `HTTP ${f.status}`}）。${PASTE}`,
    };
  if (f.status === 404 || f.status === 410)
    return { ok: false, reason: '这个链接打不开（页面不存在）。请检查链接是不是完整。' };
  if (f.status >= 400)
    return { ok: false, reason: `网站返回了错误（HTTP ${f.status}），没能读取。${PASTE}` };
  if (type.includes('application/pdf') || f.body.startsWith('%PDF'))
    return { ok: false, reason: `这是一个 PDF 文件。读取 PDF 还在做，${PASTE}` };
  if (c.kind === 'arxiv-abstract') {
    const a = extractArxivAtom(f.body);
    if (!a) return { ok: false, reason: 'arXiv 上没有找到这篇论文，请检查论文号。' };
    return {
      ok: true,
      ...a,
      url: f.url,
      kind: c.kind,
      complete: false,
      note: '这篇论文在 arXiv 上没有网页版全文，只拿到了标题和摘要。想读全文，打开 PDF 把正文复制过来贴上。',
    };
  }
  if (!/(text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml)/.test(type) && type)
    return { ok: false, reason: `这个链接不是网页（${type.split(';')[0]}），没法读取。${PASTE}` };
  const page = type.includes('text/plain')
    ? { title: '', text: f.body.slice(0, PAGE_LIMITS.text).trim() }
    : extractHtml(f.body);
  const chars = page.text.replace(/\s+/g, '').length;
  // 验证页：几乎没有正文，看得见的标题和文字里是人机验证的字样（只看页面上的字，不看脚本：很多正常网页的脚本里也有 captcha）
  if (
    chars < 500 &&
    (BLOCKED.test(page.title + '\n' + page.text) ||
      /cf-chl|cf_chl|challenge-platform/.test(f.body.slice(0, 50000)))
  )
    return { ok: false, reason: `这个网站要先通过人机验证，拦住了自动读取。${PASTE}` };
  if (chars < 200)
    return {
      ok: false,
      reason: `这个页面里几乎没有正文（可能要登录，或者正文是网页加载后才出现的）。${PASTE}`,
    };
  const paywall = PAYWALL.test(page.text.slice(-3000)) || PAYWALL.test(page.text.slice(0, 3000));
  const short = chars < PAGE_LIMITS.short;
  return {
    ok: true,
    ...page,
    url: f.url,
    kind: c.kind,
    complete: !paywall && !short,
    note: paywall
      ? '这个页面像是要订阅或登录才能看全文，拿到的可能只是开头。核对一下，缺的部分可以补贴进来。'
      : short
        ? '拿到的正文很短，可能不是全文。核对一下，缺的部分可以补贴进来。'
        : c.kind === 'arxiv-html'
          ? '从 arXiv 拿到了网页版全文。'
          : '',
  };
}

/** 一个请求函数：取一个地址（自己检查每一跳），失败时抛出带原因的错误。 */
export type Get = (url: string) => Promise<Fetched>;

/** 读一个链接：按规则依次试几个地址，返回第一个能用的结果。 */
export async function importLink(link: string, get: Get): Promise<LinkResult> {
  const list = candidatesFor(link);
  if (typeof list === 'string') return { ok: false, reason: list };
  let last: LinkResult = { ok: false, reason: '没能读取这个链接。' };
  for (const c of list) {
    let f: Fetched;
    try {
      f = await get(c.url);
    } catch (e) {
      last = {
        ok: false,
        reason: e instanceof Error && e.message ? e.message : '没能读取这个链接。',
      };
      continue;
    }
    const r = readFetched(c, f);
    if (r) {
      if (r.ok || c.kind !== 'arxiv-html') return r;
      last = r;
    }
  }
  return last;
}

/** 跳转的下一跳：相对地址补全，并且检查。 */
export function nextHop(from: string, location: string): string {
  let to: string;
  try {
    to = new URL(location, from).toString();
  } catch {
    throw new Error('网站跳转到了一个无效的地址。');
  }
  const bad = checkTarget(to);
  if (bad) throw new Error('网站跳转到了不能读取的地址：' + bad);
  return to;
}

/** 按网页声明的编码把字节转成文字（默认 UTF-8）。 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  let head = '';
  for (const b of bytes.slice(0, 2048)) head += String.fromCharCode(b);
  const charset =
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
