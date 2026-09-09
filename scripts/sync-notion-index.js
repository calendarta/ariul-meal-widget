const fs = require('fs');
const path = require('path');

const TOKEN = String(process.env.NOTION_TOKEN || '').trim();
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID || '3c9a0cffdadd8091b962caa4ac112d53';
const NOTION_VERSION = '2022-06-28';
const MAX_PAGES = 250;
const MAX_DEPTH = 10;
const MIN_REQUEST_INTERVAL_MS = 380;
const MAX_RETRIES = 5;
const MIN_SAFE_PAGE_COUNT = 20;
const DENY = ['비밀번호','개인정보','인증서'];
let lastRequestAt = 0;

if (!TOKEN) {
  console.error('NOTION_TOKEN is required.');
  process.exit(1);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalize(text='') {
  return String(text).toLowerCase().replace(/\s+/g,' ').trim();
}
function richTextToPlain(rich=[]) {
  return rich.map(r => r?.plain_text || r?.text?.content || '').join('');
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
function getDatabaseTitle(db) {
  return richTextToPlain(db?.title || []).trim() || '데이터베이스';
}
function denied(title='') {
  const t = normalize(title);
  return DENY.some(x => t.includes(normalize(x)));
}
function pageMentionsFromRichText(rich=[]) {
  const ids=[];
  for (const r of rich) {
    if (r?.type === 'mention' && r?.mention?.type === 'page' && r.mention.page?.id) ids.push(r.mention.page.id);
  }
  return ids;
}
function linkedPageIdsFromBlock(block) {
  const ids=[];
  if (block?.type === 'link_to_page' && block.link_to_page?.type === 'page_id' && block.link_to_page.page_id) ids.push(block.link_to_page.page_id);
  const type=block?.type;
  const data=block?.[type] || {};
  ids.push(...pageMentionsFromRichText(data.rich_text || []));
  if (type === 'table_row') for (const cell of data.cells || []) ids.push(...pageMentionsFromRichText(cell));
  return ids;
}
function blockToText(block) {
  const type = block?.type;
  const data = block?.[type] || {};
  if (type === 'child_page' || type === 'child_database') return '';
  if (type === 'divider') return '---';
  if (type === 'table_row') return (data.cells || []).map(richTextToPlain).join(' | ');
  if (type === 'bookmark' || type === 'link_preview') return data.url ? `링크: ${data.url}` : '';
  if (type === 'link_to_page') return '연결 페이지';
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

async function notion(pathname, options={}) {
  for (let attempt=0; attempt<=MAX_RETRIES; attempt++) {
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetch(`https://api.notion.com/v1${pathname}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (res.ok) return data;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 1000 * (2 ** attempt));
      console.warn(`Notion rate limit: retry ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    throw new Error(data?.message || `Notion API ${res.status}`);
  }
}

async function listChildren(blockId) {
  const out = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ page_size:'100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notion(`/blocks/${blockId}/children?${qs}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

async function collect(blockId, depth=0) {
  if (depth > MAX_DEPTH) return { text:'', childPages:[], childDatabases:[], linkedPages:[] };
  const lines=[], childPages=[], childDatabases=[], linkedPages=[];
  const blocks = await listChildren(blockId);
  for (const block of blocks) {
    linkedPages.push(...linkedPageIdsFromBlock(block));
    if (block.type === 'child_page') {
      childPages.push({ id:block.id, title:block.child_page?.title || '' });
      continue;
    }
    if (block.type === 'child_database') {
      childDatabases.push({ id:block.id, title:block.child_database?.title || '' });
      continue;
    }
    const line = blockToText(block);
    if (line) lines.push(line);
    if (block.has_children) {
      const nested = await collect(block.id, depth+1);
      if (nested.text) lines.push(nested.text);
      childPages.push(...nested.childPages);
      childDatabases.push(...nested.childDatabases);
      linkedPages.push(...nested.linkedPages);
    }
  }
  return { text:lines.join('\n'), childPages, childDatabases, linkedPages:[...new Set(linkedPages)] };
}

async function queryDatabase(id) {
  const pages=[];
  let cursor=null;
  do {
    const body={page_size:100};
    if (cursor) body.start_cursor=cursor;
    const data = await notion(`/databases/${id}/query`, {method:'POST', body});
    pages.push(...(data.results || []).filter(x => x.object === 'page' && !x.archived));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

async function crawl() {
  const pages=[];
  const seenPages=new Set();
  const seenDatabases=new Set();

  async function crawlPage(id, depth=0, known=null) {
    if (depth > MAX_DEPTH || pages.length >= MAX_PAGES || seenPages.has(id)) return;
    seenPages.add(id);
    let page = known;
    try { if (!page) page = await notion(`/pages/${id}`); }
    catch (e) { console.warn('skip page', id, e.message); return; }
    const title = getPageTitle(page);
    if (denied(title)) return;
    let content;
    try { content = await collect(page.id, depth); }
    catch (e) { console.warn('skip blocks', title, e.message); return; }
    pages.push({
      id: page.id,
      title,
      url: page.url || `https://www.notion.so/${String(page.id).replace(/-/g,'')}`,
      text: String(content.text || '').trim(),
      lastEdited: page.last_edited_time || null
    });
    for (const child of content.childPages) await crawlPage(child.id, depth+1);
    for (const linkedId of content.linkedPages) await crawlPage(linkedId, depth+1);
    for (const db of content.childDatabases) await crawlDatabase(db.id, depth+1);
  }

  async function crawlDatabase(id, depth=0) {
    if (depth > MAX_DEPTH || pages.length >= MAX_PAGES || seenDatabases.has(id)) return;
    seenDatabases.add(id);
    let db;
    try { db = await notion(`/databases/${id}`); }
    catch (e) { console.warn('skip database', id, e.message); return; }
    if (denied(getDatabaseTitle(db))) return;
    let rows=[];
    try { rows = await queryDatabase(id); }
    catch (e) { console.warn('skip database rows', id, e.message); return; }
    for (const row of rows) await crawlPage(row.id, depth+1, row);
  }

  await crawlPage(ROOT_PAGE_ID, 0);
  return pages;
}

(async () => {
  const pages = await crawl();
  const target = path.join(process.cwd(), 'data', 'teacher-index.json');
  let previousCount = 0;
  try { previousCount = JSON.parse(fs.readFileSync(target, 'utf8'))?.pageCount || 0; } catch {}
  if (!pages.length || pages.length < MIN_SAFE_PAGE_COUNT || (previousCount >= MIN_SAFE_PAGE_COUNT && pages.length < Math.floor(previousCount * 0.65))) {
    throw new Error(`Snapshot looks incomplete (${pages.length} pages; previous ${previousCount}). Existing snapshot was not overwritten.`);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    rootPageId: ROOT_PAGE_ID,
    pageCount: pages.length,
    pages
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Indexed ${pages.length} Notion pages -> ${target}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
