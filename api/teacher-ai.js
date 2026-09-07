const STATIC_KB = require('../data/teacher-kb');
const SOURCES = require('../data/teacher-sources');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const MAX_DOCS = 4;
const NOTION_VERSION = '2022-06-28';
const NOTION_REFRESH_MS = 60 * 1000;

const STOPWORDS = new Set([
  '그리고','그런데','그러면','어떻게','어디서','언제','무엇','뭐','관련','학교','선생님','교사','학생','우리','아리울초','군산아리울초','되나요','하나요','인가요','있나요','알려줘','알려주세요'
]);

const notionCache = globalThis.__ARIUL_NOTION_CACHE__ || new Map();
globalThis.__ARIUL_NOTION_CACHE__ = notionCache;
let lastRefreshAt = globalThis.__ARIUL_NOTION_REFRESH_AT__ || 0;

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text = '') {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreDoc(question, doc) {
  const q = normalize(question);
  const qTokens = tokens(question);
  const haystack = normalize(`${doc.title} ${(doc.keywords || []).join(' ')} ${doc.text}`);
  let score = 0;

  for (const keyword of doc.keywords || []) {
    const k = normalize(keyword);
    if (k && q.includes(k)) score += 9;
  }

  for (const token of qTokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 4 : 2;
  }

  if (q.includes(normalize(doc.title))) score += 12;
  return score;
}

function retrieve(question, kb) {
  return kb
    .map((doc) => ({ ...doc, score: scoreDoc(question, doc) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DOCS);
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const texts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') texts.push(content.text);
    }
  }
  return texts.join('\n').trim();
}

function richTextToPlain(rich = []) {
  return rich.map((r) => r?.plain_text || '').join('');
}

function blockToText(block) {
  const type = block?.type;
  const data = block?.[type] || {};

  if (type === 'child_page') return `하위 페이지: ${data.title || ''}`;
  if (type === 'table_row') {
    return (data.cells || []).map((cell) => richTextToPlain(cell)).join(' | ');
  }

  const text = richTextToPlain(data.rich_text || []);
  if (!text) return '';

  if (type === 'heading_1') return `# ${text}`;
  if (type === 'heading_2') return `## ${text}`;
  if (type === 'heading_3') return `### ${text}`;
  if (type === 'bulleted_list_item') return `- ${text}`;
  if (type === 'numbered_list_item') return `- ${text}`;
  if (type === 'to_do') return `- ${data.checked ? '[완료]' : '[ ]'} ${text}`;
  if (type === 'quote') return `> ${text}`;
  if (type === 'callout') return `주의/안내: ${text}`;
  if (type === 'toggle') return `${text}`;
  return text;
}

async function notionFetch(path, token) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data?.message || `Notion API 오류 (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function fetchBlockText(blockId, token, depth = 0) {
  if (depth > 5) return '';

  let cursor = null;
  const lines = [];

  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notionFetch(`/blocks/${blockId}/children?${qs.toString()}`, token);

    for (const block of data.results || []) {
      const line = blockToText(block);
      if (line) lines.push(line);
      if (block.has_children) {
        const childText = await fetchBlockText(block.id, token, depth + 1);
        if (childText) lines.push(childText);
      }
    }

    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return lines.join('\n');
}

async function refreshNotionKB(token) {
  const now = Date.now();
  if (now - lastRefreshAt < NOTION_REFRESH_MS && notionCache.size) {
    return SOURCES.map((source) => notionCache.get(source.id)).filter(Boolean);
  }

  const docs = await Promise.all(SOURCES.map(async (source) => {
    try {
      const page = await notionFetch(`/pages/${source.pageId}`, token);
      const lastEdited = page.last_edited_time || '';
      const cached = notionCache.get(source.id);

      if (cached && cached.lastEdited === lastEdited) return cached;

      const text = await fetchBlockText(source.pageId, token);
      const doc = {
        ...source,
        text,
        lastEdited,
        live: true
      };
      notionCache.set(source.id, doc);
      return doc;
    } catch (error) {
      console.error(`Notion sync failed: ${source.title}`, error.message);
      const cached = notionCache.get(source.id);
      if (cached) return cached;
      const fallback = STATIC_KB.find((d) => d.id === source.id);
      return fallback ? { ...fallback, live: false } : null;
    }
  }));

  lastRefreshAt = now;
  globalThis.__ARIUL_NOTION_REFRESH_AT__ = now;
  return docs.filter(Boolean);
}

async function getKnowledgeBase() {
  const notionToken = String(process.env.NOTION_TOKEN || '').trim();
  if (!notionToken) return { kb: STATIC_KB, syncMode: 'snapshot' };

  try {
    const kb = await refreshNotionKB(notionToken);
    if (kb.length) return { kb, syncMode: 'notion-live' };
  } catch (error) {
    console.error('Notion knowledge refresh error:', error);
  }
  return { kb: STATIC_KB, syncMode: 'snapshot-fallback' };
}

function sourceStatus(doc) {
  const text = String(doc.text || '');
  const year2026 = /2026/.test(text);
  const needs2027 = /2027[^\n]{0,30}(확인|재확인|안내|기준)/.test(text) || /해당 학년도|다음 학년도|최신.*확인/.test(text);
  if (needs2027) return 'confirm-2027';
  if (year2026) return 'year-2026';
  return 'current';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: '질문을 입력해 주세요.' });
    if (question.length > 500) return res.status(400).json({ error: '질문은 500자 이내로 입력해 주세요.' });

    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
    }

    const { kb, syncMode } = await getKnowledgeBase();
    const docs = retrieve(question, kb);
    if (!docs.length || docs[0].score < 3) {
      return res.status(200).json({
        answer: '현재 전입교원 가이드에서 이 질문에 대한 근거를 확인하지 못했습니다. 학교 담당 업무 또는 관리자에게 확인해 주세요.',
        sources: [],
        grounded: false,
        badges: [{ type: 'unknown', label: '가이드에서 확인되지 않음' }],
        syncMode
      });
    }

    const context = docs
      .map((doc, i) => `[자료 ${i + 1}] ${doc.title}\n${doc.text}`)
      .join('\n\n');

    const instructions = `당신은 군산아리울초 전입교원 적응 가이드 전용 AI 도우미입니다.\n\n반드시 아래 규칙을 지키세요.\n1. 제공된 [자료]에 명시된 내용만 근거로 답하세요. 일반 지식이나 추측으로 빈틈을 채우지 마세요.\n2. 자료에 답이 없거나 확실하지 않으면 "현재 전입교원 가이드에서 확인되지 않습니다"라고 명확히 말하세요.\n3. 2026 기준 자료를 2027 확정 정보처럼 표현하지 마세요. 연도 확인이 필요한 내용에는 "2026 기준" 또는 "2027학년도 안내에서 재확인"이라고 적으세요.\n4. 답변은 교직원이 바로 읽을 수 있도록 짧은 문단 2~4개로 작성하세요. 한 문단이 너무 길지 않게 하세요.\n5. 절차가 있으면 줄바꿈 후 짧은 목록으로 정리하세요.\n6. 중요한 핵심어는 **굵게** 표시할 수 있습니다. 다른 복잡한 마크다운은 쓰지 마세요.\n7. 사람 이름, 비밀번호, 개인정보를 만들어내거나 추정하지 마세요.\n8. 답변 안에 URL이나 '출처' 목록을 만들지 마세요. 출처는 시스템이 별도로 표시합니다.`;

    const input = `질문: ${question}\n\n아래는 검색된 전입교원 가이드 자료입니다.\n\n${context}`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input,
        max_output_tokens: 700
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI API error:', data);
      return res.status(502).json({
        error: data?.error?.message || `OpenAI API 오류 (${response.status})`
      });
    }

    const answer = extractOutputText(data);
    if (!answer) {
      return res.status(502).json({ error: 'AI 답변을 생성하지 못했습니다.' });
    }

    const sources = docs.slice(0, 3).map((doc) => ({
      title: doc.title,
      url: doc.url,
      score: doc.score,
      status: sourceStatus(doc),
      lastEdited: doc.lastEdited || null
    }));

    const statuses = new Set(sources.map((s) => s.status));
    const badges = [];
    if (statuses.has('confirm-2027')) badges.push({ type: 'confirm-2027', label: '2027 확인 필요' });
    if (statuses.has('year-2026') || statuses.has('confirm-2027')) badges.push({ type: 'year-2026', label: '2026 자료 기준 포함' });
    if (!badges.length) badges.push({ type: 'current', label: '가이드 근거 확인' });

    return res.status(200).json({
      answer,
      sources,
      grounded: true,
      badges,
      syncMode,
      model: MODEL
    });
  } catch (error) {
    console.error('teacher ai error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'AI 도우미 처리 중 오류가 발생했습니다.'
    });
  }
};
