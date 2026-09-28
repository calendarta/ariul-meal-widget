const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/dish-images');
const { normalizeDish, searchTerms, candidate } = handler;

function photo(title = 'File:배추김치.jpg') {
  return { pageid: 1, index: 1, title, imageinfo: [{
    mime: 'image/jpeg', width: 800, height: 600,
    thumburl: 'https://upload.wikimedia.org/wikipedia/commons/test.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:test.jpg',
    extmetadata: {
      Artist: { value: '<a href="https://example.com">A &amp; B</a>' },
      LicenseShortName: { value: 'CC BY-SA 4.0' },
      LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
    }
  }] };
}
async function request(query, method = 'GET') {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ query, method }, response);
  return response;
}
test('normalization retains ingredients and cooking method', () => {
  assert.equal(normalizeDish('친환경현미밥(자율)'), '현미밥');
  assert.equal(normalizeDish('민물새우호박국(e) (5.9)'), '민물새우호박국');
  assert.equal(normalizeDish('수제치즈닭갈비 (2.5.6.15)'), '치즈닭갈비');
  assert.equal(searchTerms('치즈닭갈비')[1].related, true);
  assert.equal(searchTerms('닭갈비')[1].related, false);
});
test('only supported licenses and trusted image hosts are returned', () => {
  assert.equal(candidate(photo(), false).author, 'A & B');
  const unlicensed = photo(); delete unlicensed.imageinfo[0].extmetadata.LicenseShortName;
  assert.equal(candidate(unlicensed, false), null);
  const malicious = photo(); malicious.imageinfo[0].thumburl = 'javascript:alert(1)';
  assert.equal(candidate(malicious, false), null);
  const noAuthor = photo(); delete noAuthor.imageinfo[0].extmetadata.Artist;
  assert.equal(candidate(noAuthor, false), null);
  assert.equal(candidate(photo('File:Napa cabbage.jpg'), false, '배추김치'), null);
});
test('invalid requests never invoke upstream search', async () => {
  assert.equal((await request({dish:['밥','국']})).code, 400);
  assert.equal((await request({dish:'x'.repeat(121)})).code, 400);
  assert.equal((await request({dish:'밥'}, 'POST')).code, 405);
});
test('results are cached and transient errors are not CDN cached', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ query: { pages: { 1: photo('File:테스트급식.jpg') } } }) };
  });
  const first = await request({dish:'테스트급식'});
  assert.equal(first.data.images.length, 1);
  assert.match(first.headers['Cache-Control'], /s-maxage=604800/);
  await request({dish:'테스트급식'});
  assert.equal(calls, 1);
  t.mock.method(global, 'fetch', async () => { throw new Error('timeout'); });
  const failed = await request({dish:'타임아웃급식'});
  assert.equal(failed.code, 200);
  assert.equal(failed.data.status, 'unavailable');
  assert.equal(failed.headers['Cache-Control'], 'no-store');
});
