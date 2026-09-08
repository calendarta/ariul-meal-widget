const STATIC_KB = require('../data/teacher-kb');
const SNAPSHOT = require('../data/teacher-index.json');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const OPENAI_TIMEOUT_MS = 15000;
const MAX_DOCS = 6;
const CHUNK_SIZE = 2600;
const CHUNK_OVERLAP = 280;

const STOPWORDS = new Set([
  '그리고','그런데','그러면','어떻게','어디서','언제','무엇','뭐','관련','학교','선생님','교사','학생','우리','아리울초','군산아리울초','되나요','하나요','인가요','있나요','알려줘','알려주세요','해주세요','합니다','입니다','오면','뭐부터','어디에','해야','어떤거','어떤','받을','받나요','있을까','있을까요','이번달에','이달에'
]);

function normalize(text='') {
  return String(text).toLowerCase().replace(/[^0-9a-zA-Z가-힣\s]/g,' ').replace(/\s+/g,' ').trim();
}

function stripParticle(token='') {
  return token.replace(/(에서|에게|한테|으로|부터|까지|처럼|보다|하고|이랑|랑|와|과|은|는|이|가|을|를|에|도|만|의|로)$/,'');
}

function tokens(text='') {
  const out=[];
  for (const raw of normalize(text).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const base=stripParticle(raw);
    for (const t of [raw,base]) {
      if (t && t.length>=2 && !STOPWORDS.has(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function koreaDateParts() {
  const parts=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(new Date());
  const get=(type)=>Number(parts.find(p=>p.type===type)?.value||0);
  return {year:get('year'),month:get('month'),day:get('day')};
}

function expandQuestion(question='') {
  const q=normalize(question);
  const extra=[];
  const now=koreaDateParts();
  const relativeMonth=/(이번\s*달|이달|이번달)/.test(q);
  const salaryIntent=/(수당|급여|월급|봉급|보수|돈|지급)/.test(q);
  const transferIntent=/(전입|전출|전학생|전입생|전편입)/.test(q);
  const parkingIntent=/(주차|차량|차\s|자동차)/.test(q);

  if (relativeMonth) extra.push(`${now.year}년 ${now.month}월`,`${now.month}월`,'월별','이번달','이달');
  if (salaryIntent) extra.push('급여','수당','월급','보수','교직수당','교직수당 가산금','담임수당','보직수당','정근수당','정근수당가산금','가족수당','명절휴가비','시간외근무수당','초과근무수당','정액급식비','월별 급여','월별 수당');
  if (relativeMonth && salaryIntent) {
    if (now.month===1) extra.push('1월 정근수당','연말정산');
    if (now.month===2) extra.push('2월 설 명절휴가비','연말정산 반영');
    if (now.month===3) extra.push('3월 전입 신규 급여정보');
    if (now.month>=4 && now.month<=6) extra.push('4~6월 매월 급여','시간외근무','가족수당 변동');
    if (now.month===7) extra.push('7월 정근수당');
    if (now.month===8) extra.push('8월 복직 보직 변동');
    if (now.month===9) extra.push('9월','추석','명절휴가비');
    if (now.month===10 || now.month===11) extra.push('10~11월 누락 수당','가족 인사 변동');
    if (now.month===12) extra.push('12월 초과근무','연말정산 사전 준비');
  }
  if (transferIntent) extra.push('전입 전출 학생 발생 시','학적','교과서','기자재','계정','보건','개인정보');
  if (parkingIntent) extra.push('출퇴근 및 주차','주차장','세영리첼','B구역','차량번호');

  return `${question}\n${extra.join(' ')}`.trim();
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const texts=[];
  for (const item of data?.output || []) for (const content of item?.content || []) if (typeof content?.text === 'string') texts.push(content.text);
  return texts.join('\n').trim();
}

function chunkPage(page) {
  const raw=String(page.text || '').trim();
  if (!raw) return [];
  const paragraphs=raw.split(/\n{2,}|(?=^#{1,3}\s)/m).map(x=>x.trim()).filter(Boolean);
  const chunks=[];
  let current='';
  function push(){
    const text=current.trim();
    if (!text) return;
    chunks.push({pageId:page.id,title:page.title,url:page.url,lastEdited:page.lastEdited || null,text,sourceType:page.sourceType || 'snapshot'});
    current=text.slice(Math.max(0,text.length-CHUNK_OVERLAP));
  }
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > CHUNK_SIZE) push();
    current += `${current?'\n\n':''}${para}`;
    while (current.length > CHUNK_SIZE) push();
  }
  if (current.trim()) push();
  return chunks;
}

function snapshotChunks() {
  return (SNAPSHOT.pages || []).flatMap(page => chunkPage({...page,sourceType:'snapshot'}));
}
function staticChunks() {
  return STATIC_KB.flatMap(doc => chunkPage({
    id:doc.id,title:doc.title,url:doc.url,lastEdited:null,sourceType:'fallback',
    text:`${(doc.keywords || []).join(' ')}\n${doc.text}`
  }));
}
function allChunks() {
  const merged=[...snapshotChunks(),...staticChunks()];
  const seen=new Set();
  return merged.filter(chunk=>{
    const key=`${normalize(chunk.title)}|${normalize(chunk.text).slice(0,180)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreChunk(question,chunk) {
  const expanded=expandQuestion(question);
  const q=normalize(expanded), qTokens=tokens(expanded), title=normalize(chunk.title), haystack=normalize(`${chunk.title} ${chunk.text}`);
  let score=0;
  if (title && q.includes(title)) score+=18;
  for (const token of qTokens) {
    if (title.includes(token)) score += token.length >= 4 ? 8 : 5;
    if (haystack.includes(token)) score += token.length >= 4 ? 4 : 2;
  }
  const phrases=[
    ['전입 학생',24],['전입생',24],['전입',16],['전출',14],['주차',24],['주차장',24],['세영리첼',18],
    ['급여',16],['수당',16],['월급',14],['보수',12],['정근수당',14],['정근수당가산금',14],['교직수당',14],['담임수당',12],['보직수당',12],['가족수당',12],['명절휴가비',14],['시간외근무수당',12],['정액급식비',12],['월별',10],
    ['교외체험학습',14],['생활기록부',14],['수행평가',12],['평가계획',12],['웨일북',14],['웨일스페이스',12],
    ['연가',10],['병가',10],['출장',10],['결재',10],['결석',10],['출결',10],['스마트기기',10],['전보',12],['학적',10]
  ];
  for (const [phrase,boost] of phrases) if (q.includes(phrase) && haystack.includes(phrase)) score+=boost;
  return score;
}

function retrieve(question,chunks) {
  const ranked=chunks.map(chunk=>({...chunk,score:scoreChunk(question,chunk)})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score);
  const selected=[], perPage=new Map();
  for (const chunk of ranked) {
    const key=chunk.url || chunk.pageId;
    const count=perPage.get(key)||0;
    if (count>=2) continue;
    selected.push(chunk); perPage.set(key,count+1);
    if (selected.length>=MAX_DOCS) break;
  }
  return selected;
}

function sourceStatus(source) {
  const text=String(source.text||''), title=String(source.title||'');
  const year2026=/2026/.test(`${title}\n${text}`);
  const needs2027=/2027[^\n]{0,40}(확인|재확인|안내|기준|예정)/.test(text)||/해당 학년도|다음 학년도|최신.*확인|2027 확인 필요/.test(text);
  if (needs2027) return 'confirm-2027';
  if (year2026) return 'year-2026';
  return 'current';
}
function uniqueSources(chunks) {
  const map=new Map();
  for (const chunk of chunks) {
    const key=chunk.url||chunk.pageId, prev=map.get(key);
    if (!prev || chunk.score>prev.score) map.set(key,chunk);
  }
  return [...map.values()].sort((a,b)=>b.score-a.score).slice(0,4).map(chunk=>({
    pageId:chunk.pageId,title:chunk.title,url:chunk.url,score:chunk.score,status:sourceStatus(chunk),lastEdited:chunk.lastEdited||null
  }));
}

async function fetchJsonWithTimeout(url,options,timeoutMs) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    const raw=await response.text();
    let data={};
    try { data=raw?JSON.parse(raw):{}; } catch { throw new Error(`서버가 JSON이 아닌 응답을 반환했습니다. (${response.status})`); }
    return {response,data};
  } catch (e) {
    if (e?.name==='AbortError') throw new Error('AI 답변 생성 시간이 초과했습니다. 잠시 후 다시 시도해 주세요.');
    throw e;
  } finally { clearTimeout(timer); }
}

module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if (req.method!=='POST') return res.status(405).json({error:'POST 요청만 지원합니다.'});
  try {
    const question=String(req.body?.question||'').trim();
    if (!question) return res.status(400).json({error:'질문을 입력해 주세요.'});
    if (question.length>500) return res.status(400).json({error:'질문은 500자 이내로 입력해 주세요.'});
    const apiKey=String(process.env.OPENAI_API_KEY||'').trim();
    if (!apiKey) return res.status(500).json({error:'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.'});

    const chunks=allChunks();
    const docs=retrieve(question,chunks);
    if (!docs.length || docs[0].score<3) return res.status(200).json({
      answer:'현재 전입교원 가이드에서 이 질문에 대한 근거를 확인하지 못했습니다. 학교 담당 업무 또는 관리자에게 확인해 주세요.',
      sources:[],grounded:false,badges:[{type:'unknown',label:'가이드에서 확인되지 않음'}],
      syncMode:(SNAPSHOT.pages||[]).length?'snapshot-auto':'snapshot-fallback',indexedPages:(SNAPSHOT.pages||[]).length,
      refreshedAt:SNAPSHOT.generatedAt||null,syncError:null
    });

    const context=docs.map((doc,i)=>`[자료 ${i+1}] ${doc.title}\n${doc.text}`).join('\n\n---\n\n');
    const now=koreaDateParts();
    const instructions=`당신은 군산아리울초 전입교원 적응 가이드 전용 AI 도우미입니다.\n현재 날짜(대한민국 기준)는 ${now.year}년 ${now.month}월 ${now.day}일입니다.\n1. 제공된 [자료]에 명시된 내용만 근거로 답하세요. 추측하지 마세요.\n2. 사용자가 '이번달', '이달', '이번 학기'처럼 상대적인 시기를 물으면 위 현재 날짜를 기준으로 해석하세요.\n3. 수당 질문에서는 '매월 지급되는 항목'과 '이번 달에 추가로 확인할 항목'을 구분해서 답하세요. 개인별 요건에 따라 달라지는 항목은 조건을 함께 적으세요.\n4. 자료에 답이 없으면 현재 가이드에서 확인되지 않는다고 말하세요.\n5. 2026 기준 자료를 2027 확정 정보처럼 표현하지 마세요.\n6. 자료가 충돌하면 최신 공문·해당 학년도 지침 확인이 필요하다고 알리세요.\n7. 교직원이 바로 읽을 수 있도록 간결하게 답하세요.\n8. 중요한 핵심어는 **굵게** 표시할 수 있습니다.\n9. 사람 이름, 학생 정보, 비밀번호, 개인정보, 인증서 정보를 불필요하게 노출하지 마세요.\n10. URL과 출처 목록은 답변 본문에 쓰지 마세요.`;

    const {response,data}=await fetchJsonWithTimeout('https://api.openai.com/v1/responses',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,instructions,input:`질문: ${question}\n\n검색 확장어: ${expandQuestion(question)}\n\n검색된 전입교원 가이드 자료:\n\n${context}`,max_output_tokens:800})
    },OPENAI_TIMEOUT_MS);
    if (!response.ok) return res.status(502).json({error:data?.error?.message||`OpenAI API 오류 (${response.status})`});
    const answer=extractOutputText(data);
    if (!answer) return res.status(502).json({error:'AI 답변을 생성하지 못했습니다.'});

    const sources=uniqueSources(docs), statuses=new Set(sources.map(s=>s.status)), badges=[];
    if (statuses.has('confirm-2027')) badges.push({type:'confirm-2027',label:'2027 확인 필요'});
    if (statuses.has('year-2026')||statuses.has('confirm-2027')) badges.push({type:'year-2026',label:'2026 자료 기준 포함'});
    if (!badges.length) badges.push({type:'current',label:'가이드 근거 확인'});

    return res.status(200).json({
      answer,sources,grounded:true,badges,
      syncMode:(SNAPSHOT.pages||[]).length?'snapshot-auto':'snapshot-fallback',indexedPages:(SNAPSHOT.pages||[]).length,
      refreshedAt:SNAPSHOT.generatedAt||null,syncError:null,model:MODEL
    });
  } catch(error) {
    console.error('teacher ai error:',error);
    return res.status(500).json({error:error instanceof Error?error.message:'AI 도우미 처리 중 오류가 발생했습니다.'});
  }
};
