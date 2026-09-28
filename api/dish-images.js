// Search reusable photographs, not a preselected menu-to-image catalog.
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const cache = new Map();
const pending = new Map();
const DAY = 86400000;

function normalizeDish(value) {
  return String(value).normalize('NFKC')
    .replace(/\([\d.,\s]+\)/g, '')
    .replace(/\((?:자율|선택|소량|e)\)/gi, '')
    .replace(/친환경|무농약|유기농|국내산|수제/g, '')
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// English search terms help find Korean foods described in English on Commons.
// A partial match is always labelled "유사 메뉴" in the widget.
const terms = [
  ['검정쌀밥', 'heukmibap'], ['흑미밥', 'heukmibap'],
  ['현미밥', 'cooked brown rice'], ['잡곡밥', 'japgokbap'], ['보리밥', 'boribap'],
  ['찹쌀밥', 'Korean cooked rice'], ['쌀밥', 'cooked white rice'],
  ['김치볶음밥', 'kimchi bokkeumbap'], ['볶음밥', 'Korean fried rice'], ['비빔밥', 'bibimbap'],
  ['김치찌개', 'kimchi jjigae'], ['된장찌개', 'doenjang jjigae'], ['순두부찌개', 'sundubu jjigae'],
  ['미역국', 'miyeok guk'], ['된장국', 'doenjang guk'], ['콩나물국', 'kongnamul guk'],
  ['육개장', 'yukgaejang'], ['갈비탕', 'galbitang'], ['설렁탕', 'seolleongtang'],
  ['떡국', 'tteokguk'], ['삼계탕', 'samgyetang'], ['어묵국', 'eomuk soup'],
  ['고추잡채', 'gochujapchae'], ['잡채', 'japchae'], ['닭갈비', 'dak galbi'],
  ['닭볶음탕', 'dak bokkeum tang'], ['찜닭', 'jjimdak'], ['제육볶음', 'jeyuk bokkeum'],
  ['돼지불고기', 'pork bulgogi'], ['소불고기', 'beef bulgogi'], ['불고기', 'bulgogi'],
  ['탕수육', 'tangsuyuk'], ['돈까스', 'tonkatsu'], ['돈가스', 'tonkatsu'],
  ['떡볶이', 'tteokbokki'], ['떡갈비', 'tteok galbi'], ['갈비찜', 'galbi jjim'],
  ['배추김치', 'baechu kimchi'], ['깍두기', 'kkakdugi'], ['총각김치', 'chonggak kimchi'],
  ['열무김치', 'yeolmu kimchi'], ['백김치', 'baek kimchi'], ['오이소박이', 'oi sobagi'],
  ['숙주나물', 'sukjunamul'], ['숙주', 'sukjunamul'], ['콩나물무침', 'kongnamul muchim'], ['시금치나물', 'sigeumchi namul'],
  ['멸치볶음', 'myeolchi bokkeum'], ['계란찜', 'gyeran jjim'], ['달걀찜', 'gyeran jjim'],
  ['계란말이', 'gyeran mari'], ['달걀말이', 'gyeran mari'], ['두부조림', 'dubu jorim'],
  ['고등어구이', 'grilled mackerel'], ['고등어조림', 'godeungeo jorim'],
  ['자장면', 'jajangmyeon'], ['짜장면', 'jajangmyeon'], ['잔치국수', 'janchi guksu'],
  ['우동', 'udon noodles'], ['스파게티', 'spaghetti'], ['만두', 'mandu'],
  ['송편', 'songpyeon'], ['인절미', 'injeolmi'], ['수박', 'sliced watermelon'],
  ['바나나', 'banana fruit'], ['사과', 'apple fruit'], ['방울토마토', 'cherry tomato'],
  ['딸기', 'strawberry fruit'], ['포도', 'grape fruit'], ['귤', 'mandarin fruit'],
  ['오렌지', 'orange fruit'], ['우유', 'glass milk'], ['요구르트', 'yogurt drink']
];

function searchTerms(dish) {
  const compact = dish.replace(/\s/g, '');
  const match = terms.find(([name]) => compact.includes(name));
  return [
    { query: `"${dish}"`, related: false },
    ...(match ? [{ query: match[1], related: compact !== match[0] }] : [])
  ];
}

function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n])
    .replace(/\s+/g, ' ').trim();
}

function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}

function candidate(page, related, query) {
  const info = page.imageinfo?.[0];
  if (!info || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) return null;
  if (info.width < 160 || info.height < 160 || info.width / info.height > 2.5 || info.height / info.width > 2.5) return null;
  const meta = info.extmetadata || {};
  // Search descriptions can mention an ingredient instead of the pictured dish.
  // Require the dish term in the file title to avoid e.g. raw cabbage for kimchi.
  const compact = value => plainText(value).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  if (query && !compact(page.title + ' ' + (meta.ObjectName?.value || '')).includes(compact(query))) return null;
  const license = plainText(meta.LicenseShortName?.value);
  if (!/^(CC0|Public domain|CC BY(?:-SA)? [\d.]+)$/i.test(license)) return null;
  if (meta.Restrictions?.value) return null;
  const url = safeUrl(info.thumburl, ['upload.wikimedia.org', 'thumb.wikimedia.org']);
  const source = safeUrl(info.descriptionurl, ['commons.wikimedia.org']);
  const author = plainText(meta.Artist?.value);
  if (!url || !source || (!author && /^CC BY/i.test(license))) return null;
  return {
    id: String(page.pageid), url, source, author: author || 'Wikimedia Commons', license,
    licenseUrl: safeUrl(meta.LicenseUrl?.value, ['creativecommons.org']),
    title: plainText(meta.ObjectName?.value || page.title.replace(/^File:/, '')),
    related
  };
}

async function search({ query, related }) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '8',
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '320',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|ObjectName|Restrictions'
  });
  const response = await fetch(`${COMMONS}?${params}`, {
    headers: { 'User-Agent': 'AriulMealWidget/1.1 (https://ariul-meal-widget.vercel.app/)' },
    signal: AbortSignal.timeout(14000)
  });
  if (!response.ok) throw new Error(`Image search HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error('Image search unavailable');
  return Object.values(data.query?.pages || {}).sort((a, b) => a.index - b.index)
    .map(page => candidate(page, related, query)).filter(Boolean);
}

async function lookup(dish) {
  const results = await Promise.allSettled(searchTerms(dish).map(search));
  const seen = new Set();
  const images = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .filter(item => !seen.has(item.id) && seen.add(item.id)).slice(0, 4);
  const failed = results.some(r => r.status === 'rejected');
  const result = { dish, images, status: images.length ? 'ok' : failed ? 'unavailable' : 'empty' };
  const ttl = images.length ? 7 * DAY : failed ? 30000 : 3600000;
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(dish, { expires: Date.now() + ttl, result });
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  const raw = req.query.dish;
  if (typeof raw !== 'string' || raw.length > 120) return res.status(400).json({ error: '메뉴 이름을 확인해 주세요.' });
  const dish = normalizeDish(raw);
  if (dish.length < 2 || dish.length > 90) return res.status(400).json({ error: '메뉴 이름을 확인해 주세요.' });
  try {
    let result = cache.get(dish);
    if (!result || result.expires <= Date.now()) {
      if (!pending.has(dish)) pending.set(dish, lookup(dish).finally(() => pending.delete(dish)));
      result = { result: await pending.get(dish) };
    }
    const data = result.result;
    res.setHeader('Cache-Control', data.status === 'unavailable' ? 'no-store'
      : `public, max-age=3600, s-maxage=${data.images.length ? 604800 : 3600}, stale-while-revalidate=86400`);
    return res.status(200).json(data);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dish, images: [], status: 'unavailable' });
  }
};

module.exports.normalizeDish = normalizeDish;
module.exports.searchTerms = searchTerms;
module.exports.candidate = candidate;
