/* Independent image loading: a failed photograph must never hide the meal. */
(() => {
  const CACHE_KEY = 'ariul-dish-images-v1';
  const PREF_KEY = 'ariul-dish-image-choice-v1';
  let generation = 0;
  let controller;
  function read(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  const cache = read(CACHE_KEY);
  const preferences = read(PREF_KEY);
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* restricted embeds */ }
  }
  function cancel() {
    generation++;
    controller?.abort();
  }
  function allowed(value, hosts) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && hosts.includes(url.hostname) ? url.href : '';
    } catch { return ''; }
  }
  function valid(item) {
    return item && allowed(item.url, ['upload.wikimedia.org', 'thumb.wikimedia.org'])
      && allowed(item.source, ['commons.wikimedia.org']);
  }
  function link(text, href) {
    const a = document.createElement('a');
    a.textContent = text;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  function icon(dish) {
    if (/밥/.test(dish)) return '🍚';
    if (/국|탕|찌개/.test(dish)) return '🥣';
    if (/사과|배\b|귤|과일|바나나|딸기|포도|수박/.test(dish)) return '🍎';
    if (/우유|요구르트/.test(dish)) return '🥛';
    return '🍽️';
  }
  async function search(dish, signal) {
    if (cache[dish]?.expires > Date.now() && Array.isArray(cache[dish]?.data?.images)) return cache[dish].data;
    const response = await fetch(`/api/dish-images?dish=${encodeURIComponent(dish)}`, { signal });
    if (!response.ok) throw new Error('Search failed');
    const data = await response.json();
    if (!Array.isArray(data.images)) throw new Error('Invalid images');
    data.images = data.images.filter(valid);
    if (data.status !== 'unavailable') {
      cache[dish] = { expires: Date.now() + (data.images.length ? 7 * 86400000 : 3600000), data };
      const keys = Object.keys(cache);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete cache[key];
      save(CACHE_KEY, cache);
    }
    return data;
  }
  function show(root, dish, index, data, token) {
    if (token !== generation) return;
    const photo = root.querySelector(`[data-dish-photo="${index}"]`);
    const credit = root.querySelector(`[data-dish-credit="${index}"]`);
    const actions = root.querySelector(`[data-dish-actions="${index}"]`);
    if (!photo) return;
    const images = data.images.filter(valid);
    const failed = new Set();
    let choice = images.findIndex(item => item.id === preferences[dish]?.id);
    if (choice < 0) choice = 0;
    let hidden = preferences[dish]?.hidden === true;
    let renderVersion = 0;

    function persist() {
      preferences[dish] = { id: images[choice]?.id, hidden };
      save(PREF_KEY, preferences);
    }
    function button(label, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.setAttribute('aria-label', `${dish} ${label}`);
      b.onclick = onClick; actions.append(b);
    }
    function render() {
      if (token !== generation) return;
      const version = ++renderVersion;
      photo.replaceChildren(); credit.replaceChildren(); actions.replaceChildren();
      const placeholder = document.createElement('span');
      placeholder.textContent = icon(dish); placeholder.setAttribute('aria-hidden', 'true');
      photo.append(placeholder);
      const item = images[choice];
      if (hidden) credit.textContent = '사진 숨김';
      else if (!item || failed.has(item.id)) credit.textContent = data.status === 'unavailable'
        ? '사진 검색에 연결하지 못했어요' : '표시할 참고 사진이 없어요';
      else {
        credit.textContent = '사진 불러오는 중…';
        const img = document.createElement('img');
        img.alt = `${dish} ${item.related ? '유사 메뉴' : '참고'} 사진`;
        img.width = 84; img.height = 84; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
        img.onload = () => {
          if (token !== generation || version !== renderVersion || !photo.isConnected) return;
          photo.replaceChildren(img);
          credit.replaceChildren(document.createTextNode(item.related ? '유사 메뉴 · ' : '참고 사진 · '));
          credit.append(link(item.title, item.source), document.createTextNode(` · ${item.author} · `));
          const licenseUrl = allowed(item.licenseUrl, ['creativecommons.org']);
          credit.append(licenseUrl ? link(item.license, licenseUrl) : document.createTextNode(item.license));
        };
        img.onerror = () => {
          if (token !== generation || version !== renderVersion) return;
          failed.add(item.id);
          const next = images.findIndex(image => !failed.has(image.id));
          if (next >= 0) choice = next;
          render();
        };
        img.src = item.url;
      }
      if (images.length > 1 && !hidden) button('다른 사진', () => {
        choice = (choice + 1) % images.length;
        failed.clear(); persist(); render();
      });
      if (images.length) button(hidden ? '사진 표시' : '사진 숨기기', () => { hidden = !hidden; persist(); render(); });
      actions.hidden = !root.querySelector('#imageControls')?.checked;
    }
    render();
  }
  async function attach(root, dishes) {
    cancel();
    controller = new AbortController();
    const signal = controller.signal;
    const token = generation;
    const toggle = root.querySelector('#imageControls');
    toggle.onchange = () => {
      root.querySelectorAll('.dish-actions').forEach(node => { node.hidden = !toggle.checked; });
      root.querySelector('#imageSettingsNote').hidden = !toggle.checked;
    };
    let cursor = 0;
    // Limit simultaneous upstream searches, including when embedded on mobile.
    await Promise.all(Array.from({ length: Math.min(3, dishes.length) }, async () => {
      while (cursor < dishes.length && token === generation) {
        const index = cursor++;
        const dish = dishes[index];
        let data;
        try { data = await search(dish, signal); }
        catch { data = { images: [], status: 'unavailable' }; }
        show(root, dish, index, data, token);
      }
    }));
  }
  window.DishImages = { attach, cancel };
})();
