const STATIC_KB = require('../data/teacher-kb');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID || '3c9a0cff-dadd-8091-b962-caa4ac112d53';
const NOTION_VERSION = '2022-06-28';
const NOTION_REFRESH_MS = 30 * 60 * 1000;
const NOTION_REQUEST_TIMEOUT_MS = 2000;
const NOTION_CRAWL_DEADLINE_MS = 8000;
const OPENAI_TIMEOUT_MS = 15000;
const MAX_DOCS = 6;
const MAX_PAGES = 100;
const MAX_DEPTH = 6;
const CHUNK_SIZE = 2600;
const CHUNK_OVERLAP = 280;

const STOPWORDS = new Set([
  '그리고','그런데','그러면','어떻게','어디서','언제','무엇','뭐','관련','학교','선생님','교사','학생','우리','아리울초','군산아리울초','되나요','하나요','인가요','있나요','알려줘','알려주세요','해주세요','합니다','입니다','오면','뭐부터'
]);

const DEFAULT_DENY_TITLE_PATTERNS = ['비밀번호','개인정보','인증서'];

const state = globalThis.__ARIUL_NOTION_INDEX__ || {
  chunks: [],
  pages: [],
  refreshedAt: 0,
  syncError: null
};
globalThis.__ARIUL_NOTION_INDEX__ = state;
globalThis.__ARIUL_NOTION_REFRESH_PROMISE__ = globalThis.__ARIUL_NOTION_REFRESH_PROMISE__ || null;

function normalize(text = '') {
  return String(text).toLowerCase().replace(/[^0-9a-zA-Z가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text = '') {
  return normalize(text).split(' ').filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function richTextToPlain(rich = []) {
  return rich.map((r) => r?.plain_text || r?.text?.content || '').join('');
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const texts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') texts.push(content.text);
    }
  }
  return texts.join('\n').trim();
}

function getPageTitle(page) {
  for (const prop of Object.values(page?.properties || {})) {
    if (prop?.type === 'title') {
      const title = richTextToPlain(prop.title || []).trim();
      if (title) return title;
    }
  }
  return '제목 없음';
}

function getDatabaseTitle(database) {
  return richTextToPlain(database?.title || []).trim() || '데이터베이스';
}

function blockToText(block) {
  const type = block?.type;
  const data = block?.[type] || {};
  if (type === 'child_page' || type === 'child_database') return '';
  if (type === 'divider') return '---';
  if (type === 'table_row') return (data.cells || []).map((cell) => richTextToPlain(cell)).join(' | ');
  if (type === 'bookmark' || type === 'link_preview') return data.url ? `링크: ${data.url}` : '';
  if (['file','pdf','image','video','audio'].includes(type)) {
    const caption = richTextToPlain(data.caption || []);
    return caption ? `첨부자료: ${caption}` : '';
  }
  const text = richTextToPlain(data.rich_text || []);
  if (!text) return '';
  if (type === 'heading_1') return `# ${text}`;
  if (type === 'heading_2') return `## ${text}`;
  if (type === 'heading_3') return `### ${text}`;
  if (type === 'bulleted_list_item' || type === 'numbered_list_item') return `- ${text}`;
  if (type === 'to_do') return `- ${data.checked ? '[완료]' : '[ ]'} ${text}`;
  if (type === 'quote') return `> ${text}`;
  if (type === 'callout') return `안내: ${text}`;
  return text;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch {
        const err = new Error(`서버가 JSON이 아닌 응답을 반환했습니다. (${response.status})`);
        err.status = response.status;
        throw err;
      }
    }
    return { response, data };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function notionRequest(path, token, options = {}) {
  const { response, data } = await fetchJsonWithTimeout(
    `https://api.notion.com/v1${path}`,
    {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    },
    NOTION_REQUEST_TIMEOUT_MS,
    `Notion API 응답 시간이 ${NOTION_REQUEST_TIMEOUT_MS / 1000}초를 초과했습니다.`
  );
  if (!response.ok) {
    const err = new Error(data?.message || `Notion API 오류 (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function envList(name) {
  return String(process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function buildDenyRules() {
  return {
    ids: new Set(envList('NOTION_AI_DENY_PAGE_IDS').map((x) => x.replace(/-/g, '').toLowerCase())),
    titles: [...DEFAULT_DENY_TITLE_PATTERNS, ...envList('NOTION_AI_DENY_TITLES')].map(normalize)
  };
}

function isDenied(id, title, rules) {
  const normalizedId = String(id || '').replace(/-/g, '').toLowerCase();
  if (rules.ids.has(normalizedId)) return true;
  const t = normalize(title);
  return rules.titles.some((pattern) => pattern && t.includes(pattern));
}

async function listBlockChildren(blockId, token, assertWithinDeadline) {
  const results = [];
  let cursor = null;
  do {
    assertWithinDeadline();
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notionRequest(`/blocks/${blockId}/children?${qs.toString()}`, token);
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function collectBlockContent(blockId, token, depth, assertWithinDeadline) {
  assertWithinDeadline();
  if (depth > MAX_DEPTH) return { text: '', childPages: [], childDatabases: [] };
  const lines = [], childPages = [], childDatabases = [];
  const blocks = await listBlockChildren(blockId, token, assertWithinDeadline);
  for (const block of blocks) {
    assertWithinDeadline();
    if (block.type === 'child_page') {
      childPages.push({ id: block.id, title: block.child_page?.title || '' });
      continue;
    }
    if (block.type === 'child_database') {
      childDatabases.push({ id: block.id, title: block.child_database?.title || '' });
      continue;
    }
    const line = blockToText(block);
    if (line) lines.push(line);
    if (block.has_children) {
      const nested = await collectBlockContent(block.id, token, depth + 1, assertWithinDeadline);
      if (nested.text) lines.push(nested.text);
      childPages.push(...nested.childPages);
      childDatabases.push(...nested.childDatabases);
    }
  }
  return { text: lines.join('\n'), childPages, childDatabases };
}

async function queryDatabase(databaseId, token, assertWithinDeadline) {
  const pages = [];
  let cursor = null;
  do {
    assertWithinDeadline();
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(`/databases/${databaseId}/query`, token, { method: 'POST', body });
    pages.push(...(data.results || []).filter((x) => x.object === 'page' && !x.archived));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

function pageUrl(page) {
  if (page?.url) return page.url;
  const compact = String(page?.id || '').replace(/-/g, '');
  return compact ? `https://www.notion.so/${compact}` : '';
}

async function crawlNotion(token) {
  const deadlineAt = Date.now() + NOTION_CRAWL_DEADLINE_MS;
  const assertWithinDeadline = () => {
    if (Date.now() >= deadlineAt) {
      const err = new Error(`Notion 색인 시간이 ${NOTION_CRAWL_DEADLINE_MS / 1000}초를 초과했습니다.`);
      err.code = 'NOTION_CRAWL_TIMEOUT';
      throw err;
    }
  };
  const denyRules = buildDenyRules();
  const visitedPages = new Set(), visitedDatabases = new Set(), pages = [];

  async function crawlPage(pageId, depth, knownPage = null, knownTitle = '') {
    assertWithinDeadline();
    if (depth > MAX_DEPTH || pages.length >= MAX_PAGES || visitedPages.has(pageId)) return;
    visitedPages.add(pageId);
    let page = knownPage;
    try { if (!page) page = await notionRequest(`/pages/${pageId}`, token); }
    catch (error) {
      console.error('Notion page fetch failed:', pageId, error.message);
      return;
    }
    const title = getPageTitle(page) || knownTitle || '제목 없음';
    if (isDenied(page.id, title, denyRules)) return;
    let content;
    try { content = await collectBlockContent(page.id, token, depth, assertWithinDeadline); }
    catch (error) {
      console.error('Notion block fetch failed:', title, error.message);
      return;
    }
    pages.push({ id: page.id, title, url: pageUrl(page), text: String(content.text || '').trim(), lastEdited: page.last_edited_time || '', live: true });
    for (const child of content.childPages) {
      assertWithinDeadline();
      if (pages.length >= MAX_PAGES) break;
      if (!isDenied(child.id, child.title, denyRules)) await crawlPage(child.id, depth + 1, null, child.title);
    }
    for (const childDb of content.childDatabases) {
      assertWithinDeadline();
      if (pages.length >= MAX_PAGES) break;
      await crawlDatabase(childDb.id, depth + 1, childDb.title);
    }
  }

  async function crawlDatabase(databaseId, depth, knownTitle = '') {
    assertWithinDeadline();
    if (depth > MAX_DEPTH || pages.length >= MAX_PAGES || visitedDatabases.has(databaseId)) return;
    visitedDatabases.add(databaseId);
    let database;
    try { database = await notionRequest(`/databases/${databaseId}`, token); }
    catch (error) { console.error('Notion database fetch failed:', databaseId, error.message); return; }
    const title = getDatabaseTitle(database) || knownTitle;
    if (isDenied(database.id, title, denyRules)) return;
    let dbPages = [];
    try { dbPages = await queryDatabase(database.id, token, assertWithinDeadline); }
    catch (error) { console.error('Notion database query failed:', title, error.message); return; }
    for (const page of dbPages) {
      assertWithinDeadline();
      if (pages.length >= MAX_PAGES) break;
      await crawlPage(page.id, depth + 1, page);
    }
  }

  await crawlPage(ROOT_PAGE_ID, 0);
  return pages;
}

function chunkPage(page) {
  const raw = String(page.text || '').trim();
  if (!raw) return [];
  const paragraphs = raw.split(/\n{2,}|(?=^#{1,3}\s)/m).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  const pushCurrent = () => {
    const text = current.trim();
    if (!text) return;
    chunks.push({ pageId: page.id, title: page.title, url: page.url, lastEdited: page.lastEdited, text, live: page.live });
    current = text.slice(Math.max(0, text.length - CHUNK_OVERLAP));
  };
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > CHUNK_SIZE) pushCurrent();
    current += `${current ? '\n\n' : ''}${para}`;
    while (current.length > CHUNK_SIZE) pushCurrent();
  }
  if (current.trim()) pushCurrent();
  return chunks;
}

function staticChunks() {
  return STATIC_KB.flatMap((doc) => chunkPage({ id: doc.id, title: doc.title, url: doc.url, text: `${(doc.keywords || []).join(' ')}\n${doc.text}`, lastEdited: null, live: false }));
}

function mergeChunks(liveChunks = []) {
  const staticList = staticChunks();
  const merged = [...liveChunks, ...staticList];
  const seen = new Set();
  return merged.filter((chunk) => {
    const key = `${normalize(chunk.title)}|${normalize(chunk.text).slice(0, 180)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function performRefresh(token) {
  const now = Date.now();
  try {
    const pages = await crawlNotion(token);
    const chunks = pages.flatMap(chunkPage);
    if (!chunks.length) throw new Error('Notion에서 검색 가능한 텍스트를 찾지 못했습니다.');
    state.pages = pages;
    state.chunks = chunks;
    state.refreshedAt = now;
    state.syncError = null;
  } catch (error) {
    console.error('Full Notion index refresh failed:', error);
    state.syncError = error.message;
    state.refreshedAt = now;
  }
  return state;
}

async function refreshIndex(token) {
  const now = Date.now();
  if (state.refreshedAt && now - state.refreshedAt < NOTION_REFRESH_MS) return state;
  if (globalThis.__ARIUL_NOTION_REFRESH_PROMISE__) return globalThis.__ARIUL_NOTION_REFRESH_PROMISE__;
  globalThis.__ARIUL_NOTION_REFRESH_PROMISE__ = performRefresh(token).finally(() => {
    globalThis.__ARIUL_NOTION_REFRESH_PROMISE__ = null;
  });
  return globalThis.__ARIUL_NOTION_REFRESH_PROMISE__;
}

async function getIndex() {
  const notionToken = String(process.env.NOTION_TOKEN || '').trim();
  if (!notionToken) {
    return { chunks: staticChunks(), pages: [], syncMode: 'snapshot', refreshedAt: null, syncError: null };
  }
  const index = await refreshIndex(notionToken);
  const liveCount = index.pages.filter((p) => p.live).length;
  return {
    ...index,
    chunks: mergeChunks(index.chunks),
    syncMode: liveCount ? 'notion-live+snapshot' : 'snapshot-fallback'
  };
}

function scoreChunk(question, chunk) {
  const q = normalize(question);
  const qTokens = tokens(question);
  const title = normalize(chunk.title);
  const haystack = normalize(`${chunk.title} ${chunk.text}`);
  let score = 0;
  if (title && q.includes(title)) score += 16;
  for (const token of qTokens) {
    if (title.includes(token)) score += token.length >= 4 ? 8 : 5;
    if (haystack.includes(token)) score += token.length >= 4 ? 4 : 2;
  }
  const phrases = [
    ['전입 학생', 24], ['전입생', 24], ['전학생', 18], ['전입', 16], ['전출', 14], ['전편입', 14],
    ['교외체험학습', 14], ['생활기록부', 14], ['수행평가', 12], ['평가계획', 12],
    ['웨일북', 14], ['웨일스페이스', 12], ['연가', 10], ['병가', 10], ['출장', 10],
    ['결재', 10], ['결석', 10], ['출결', 10], ['스마트기기', 10], ['업무', 6], ['담당', 6],
    ['급여', 10], ['수당', 10], ['정근수당', 12], ['명절휴가비', 12], ['전보', 12], ['학적', 10]
  ];
  for (const [phrase, boost] of phrases) {
    if (q.includes(phrase) && haystack.includes(phrase)) score += boost;
  }
  return score;
}

function retrieve(question, chunks) {
  const ranked = chunks.map((chunk) => ({ ...chunk, score: scoreChunk(question, chunk) })).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score);
  const selected = [], perPage = new Map();
  for (const chunk of ranked) {
    const count = perPage.get(chunk.pageId) || 0;
    if (count >= 2) continue;
    selected.push(chunk);
    perPage.set(chunk.pageId, count + 1);
    if (selected.length >= MAX_DOCS) break;
  }
  return selected;
}

function sourceStatus(source) {
  const text = String(source.text || ''), title = String(source.title || '');
  const year2026 = /2026/.test(`${title}\n${text}`);
  const needs2027 = /2027[^\n]{0,40}(확인|재확인|안내|기준|예정)/.test(text) || /해당 학년도|다음 학년도|최신.*확인|2027 확인 필요/.test(text);
  if (needs2027) return 'confirm-2027';
  if (year2026) return 'year-2026';
  return 'current';
}

function uniqueSources(chunks) {
  const map = new Map();
  for (const chunk of chunks) {
    const key = chunk.url || chunk.pageId;
    const prev = map.get(key);
    if (!prev || chunk.score > prev.score) map.set(key, chunk);
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 4).map((chunk) => ({
    pageId: chunk.pageId,
    title: chunk.title,
    url: chunk.url,
    score: chunk.score,
    status: sourceStatus(chunk),
    lastEdited: chunk.lastEdited || null
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 지원합니다.' });

  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: '질문을 입력해 주세요.' });
    if (question.length > 500) return res.status(400).json({ error: '질문은 500자 이내로 입력해 주세요.' });
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });

    const index = await getIndex();
    const docs = retrieve(question, index.chunks);
    if (!docs.length || docs[0].score < 3) {
      return res.status(200).json({
        answer: '현재 전입교원 가이드에서 이 질문에 대한 근거를 확인하지 못했습니다. 학교 담당 업무 또는 관리자에게 확인해 주세요.',
        sources: [], grounded: false,
        badges: [{ type: 'unknown', label: '가이드에서 확인되지 않음' }],
        syncMode: index.syncMode, indexedPages: index.pages?.length || 0,
        refreshedAt: index.refreshedAt || null, syncError: index.syncError || null
      });
    }

    const context = docs.map((doc, i) => `[자료 ${i + 1}] ${doc.title}\n${doc.text}`).join('\n\n---\n\n');
    const instructions = `당신은 군산아리울초 전입교원 적응 가이드 전용 AI 도우미입니다.\n\n반드시 아래 규칙을 지키세요.\n1. 제공된 [자료]에 명시된 내용만 근거로 답하세요. 일반 지식이나 추측으로 빈틈을 채우지 마세요.\n2. 자료에 답이 없거나 확실하지 않으면 "현재 전입교원 가이드에서 확인되지 않습니다"라고 명확히 말하세요.\n3. 2026 기준 자료를 2027 확정 정보처럼 표현하지 마세요. 연도 확인이 필요한 내용에는 "2026 기준" 또는 "2027학년도 안내에서 재확인"이라고 적으세요.\n4. 서로 다른 자료가 충돌하면 임의로 하나를 고르지 말고, 충돌 사실을 짧게 알리고 최신 공문·해당 학년도 지침 확인이 필요하다고 답하세요.\n5. 답변은 교직원이 바로 읽을 수 있도록 짧은 문단 2~4개로 작성하세요. 절차는 짧은 목록으로 정리할 수 있습니다.\n6. 중요한 핵심어는 **굵게** 표시할 수 있습니다. 복잡한 마크다운은 쓰지 마세요.\n7. 사람 이름, 학생 정보, 비밀번호, 개인정보, 인증서 정보를 만들어내거나 추정하지 마세요. 자료에 이런 정보가 있더라도 질문에 불필요하면 답변에 노출하지 마세요.\n8. 답변 안에 URL이나 출처 목록을 만들지 마세요. 출처는 시스템이 별도로 표시합니다.`;

    const { response, data } = await fetchJsonWithTimeout(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, instructions, input: `질문: ${question}\n\n검색된 전입교원 가이드 자료:\n\n${context}`, max_output_tokens: 800 })
      },
      OPENAI_TIMEOUT_MS,
      `AI 답변 생성 시간이 ${OPENAI_TIMEOUT_MS / 1000}초를 초과했습니다. 잠시 후 다시 시도해 주세요.`
    );

    if (!response.ok) return res.status(502).json({ error: data?.error?.message || `OpenAI API 오류 (${response.status})` });
    const answer = extractOutputText(data);
    if (!answer) return res.status(502).json({ error: 'AI 답변을 생성하지 못했습니다.' });

    const sources = uniqueSources(docs);
    const statuses = new Set(sources.map((s) => s.status));
    const badges = [];
    if (statuses.has('confirm-2027')) badges.push({ type: 'confirm-2027', label: '2027 확인 필요' });
    if (statuses.has('year-2026') || statuses.has('confirm-2027')) badges.push({ type: 'year-2026', label: '2026 자료 기준 포함' });
    if (!badges.length) badges.push({ type: 'current', label: '가이드 근거 확인' });

    return res.status(200).json({
      answer, sources, grounded: true, badges,
      syncMode: index.syncMode, indexedPages: index.pages?.length || 0,
      refreshedAt: index.refreshedAt || null, syncError: index.syncError || null, model: MODEL
    });
  } catch (error) {
    console.error('teacher ai error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'AI 도우미 처리 중 오류가 발생했습니다.' });
  }
};
