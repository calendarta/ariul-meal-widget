const KB = require('../data/teacher-kb');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const MAX_DOCS = 4;

const STOPWORDS = new Set([
  '그리고','그런데','그러면','어떻게','어디서','언제','무엇','뭐','관련','학교','선생님','교사','학생','우리','아리울초','군산아리울초','되나요','하나요','인가요','있나요','알려줘','알려주세요'
]);

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

function retrieve(question) {
  return KB
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

    const docs = retrieve(question);
    if (!docs.length || docs[0].score < 3) {
      return res.status(200).json({
        answer: '현재 전입교원 가이드에서 이 질문에 대한 근거를 확인하지 못했습니다. 학교 담당 업무 또는 관리자에게 확인해 주세요.',
        sources: [],
        grounded: false,
        warning: '가이드에서 근거를 찾지 못함'
      });
    }

    const context = docs
      .map((doc, i) => `[자료 ${i + 1}] ${doc.title}\n${doc.text}`)
      .join('\n\n');

    const instructions = `당신은 군산아리울초 전입교원 적응 가이드 전용 AI 도우미입니다.\n\n반드시 아래 규칙을 지키세요.\n1. 제공된 [자료]에 명시된 내용만 근거로 답하세요. 일반 지식이나 추측으로 빈틈을 채우지 마세요.\n2. 자료에 답이 없거나 확실하지 않으면 "현재 전입교원 가이드에서 확인되지 않습니다"라고 명확히 말하세요.\n3. 2026 기준 자료를 2027 확정 정보처럼 표현하지 마세요. 연도 확인이 필요한 내용에는 "2026 기준" 또는 "2027학년도 안내에서 재확인"이라고 적으세요.\n4. 답변은 교직원이 바로 업무에 활용할 수 있도록 2~5문장 정도로 간결하게 작성하세요. 절차가 있으면 화살표(→)나 짧은 항목으로 정리해도 됩니다.\n5. 사람 이름, 비밀번호, 개인정보를 만들어내거나 추정하지 마세요.\n6. 답변 안에 URL이나 '출처' 목록을 만들지 마세요. 출처는 시스템이 별도로 표시합니다.\n7. 질문에 필요한 경우에만 주의사항을 한 문장 덧붙이세요.`;

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
      score: doc.score
    }));

    const has2026 = docs.some((doc) => /2026/.test(doc.text));

    return res.status(200).json({
      answer,
      sources,
      grounded: true,
      warning: has2026 ? '일부 내용은 2026학년도 자료 기준입니다.' : null,
      model: MODEL
    });
  } catch (error) {
    console.error('teacher ai error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'AI 도우미 처리 중 오류가 발생했습니다.'
    });
  }
};
