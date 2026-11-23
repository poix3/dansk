/*
 * 发音：Gemini TTS（Interactions API）+ 本地音频缓存；失败时回退到系统语音
 * - 同一段文字只调用一次 API，之后从 IndexedDB 播放（独立数据库 dk_audio，不进备份）
 * - 用 <audio> 元素播放（按“媒体播放”处理，不受 iPhone 静音开关影响）；
 *   iOS 只允许在用户手势里启动播放，所以点击瞬间先用一段静音“解锁”这个元素，
 *   等 API 返回后再复用同一个元素播放真正的声音
 */
const TTS = (() => {
  const STYLE = 'Read this text aloud in Danish (da-DK), with native Danish pronunciation, not English.';
  const LANG = 'da-DK'; // 在 speech_config 里直接指定语言，不让模型从单个单词猜
  const DB_NAME = 'dk_audio', OS = 'clips', MAX_BYTES = 100 * 1024 * 1024, TARGET_BYTES = 70 * 1024 * 1024, BYTES_KEY = 'dk_audio_bytes';
  let adb = null, el = null, url = null, warned = false, seq = 0;
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  const open = () => adb ? Promise.resolve(adb) : new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(OS, { keyPath: 'k' }); s.createIndex('t', 't'); };
    r.onsuccess = () => res(adb = r.result);
    r.onerror = () => rej(r.error);
  });
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function cacheGet(k) {
    try {
      const store = (await open()).transaction(OS, 'readwrite').objectStore(OS);
      const row = await req(store.get(k));
      if (row) { row.t = Date.now(); store.put(row); }
      return row?.buf || null;
    } catch (e) { return null; }
  }
  /* 写入缓存；总体积超过上限时，清掉最久没听过的，直到降到目标体积以下 */
  async function cachePut(k, buf) {
    try {
      const d = await open();
      d.transaction(OS, 'readwrite').objectStore(OS).put({ k, buf, t: Date.now(), size: buf.byteLength });
      const total = (+localStorage.getItem(BYTES_KEY) || 0) + buf.byteLength;
      localStorage.setItem(BYTES_KEY, total);
      if (total > MAX_BYTES) await evict();
    } catch (e) {}
  }

  function evict() {
    return new Promise(res => {
      const tx = adb.transaction(OS, 'readwrite'), st = tx.objectStore(OS), rows = [];
      st.index('t').openCursor().onsuccess = e => { // 按最近使用时间从旧到新
        const c = e.target.result;
        if (c) { rows.push({ k: c.primaryKey, s: c.value.size || c.value.buf.byteLength }); return c.continue(); }
        let total = rows.reduce((a, r) => a + r.s, 0);
        for (const r of rows) { if (total <= TARGET_BYTES) break; st.delete(r.k); total -= r.s; }
        localStorage.setItem(BYTES_KEY, total); // 顺便校准体积计数
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => res();
    });
  }

  /* 手动清空发音缓存（整库删除，释放空间） */
  function clearCache() {
    return new Promise(res => {
      try { adb?.close(); } catch (e) {}
      adb = null;
      localStorage.setItem(BYTES_KEY, 0);
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
  }

  const b64ToBuf = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

  /* generateContent 返回不带头的 16-bit 单声道 PCM，包成 WAV 才能交给 <audio> */
  function pcmToWav(pcm, rate) {
    const h = new DataView(new ArrayBuffer(44)), w = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); h.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVEfmt ');
    h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    w(36, 'data'); h.setUint32(40, pcm.byteLength, true);
    const out = new Uint8Array(44 + pcm.byteLength);
    out.set(new Uint8Array(h.buffer)); out.set(new Uint8Array(pcm), 44);
    return out.buffer;
  }

  /* 首选：generateContent，语言用 speechConfig.languageCode 指定 */
  async function viaGenerateContent(text) {
    const { key, ttsModel, voice } = Store.state.settings;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ttsModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: LANG },
        },
      }),
    });
    if (!r.ok) throw new Error('TTS ' + r.status + '：' + (await r.text()).slice(0, 100));
    const j = await r.json();
    const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error('TTS 返回里没有音频');
    const buf = b64ToBuf(part.inlineData.data);
    if (new TextDecoder().decode(buf.slice(0, 4)) === 'RIFF') return buf; // 已经是 WAV
    const rate = +(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
    return pcmToWav(buf, rate);
  }

  /* 备用：Interactions API（新接口，语言字段名按 SDK 习惯猜的 language） */
  async function viaInteractions(text) {
    const { key, ttsModel, voice } = Store.state.settings;
    const textPart = { type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] };
    const call = withLang => fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        model: ttsModel,
        input: [{ type: 'user_input', content: [textPart] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [withLang ? { voice, language: LANG } : { voice }] },
      }),
    });
    let r = await call(true);
    if (r.status === 400) r = await call(false);
    if (!r.ok) throw new Error('TTS ' + r.status + '：' + (await r.text()).slice(0, 100));
    const j = await r.json();
    const audio = (j.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'audio').pop();
    if (!audio?.data) throw new Error('TTS 返回里没有音频');
    return b64ToBuf(audio.data); // 非流式返回带头的 WAV
  }

  async function fetchAudio(text) {
    try { return await viaGenerateContent(text); }
    catch (e) {
      try { return await viaInteractions(text); }
      catch (e2) { throw new Error(`${e.message}（备用接口也失败：${e2.message}）`); }
    }
  }

  /* 必须在点击手势的同步阶段调用 */
  function unlock() {
    if (!el) { el = new Audio(); el.setAttribute('playsinline', ''); el.preload = 'auto'; el.addEventListener('ended', () => { if (active?.mode === 'playing') finish(); }); }
    el.src = SILENT;
    el.play().catch(() => {});
  }

  async function play(buf) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    el.src = url;
    await el.play();
  }

  /* 取音频：本地缓存 → API；同一段文字正在请求时复用同一个请求 */
  const inflight = new Map();
  function getBuf(text) {
    const S = Store.state.settings, k = `${S.ttsModel}|${S.voice}|${text}`;
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      let buf = await cacheGet(k);
      if (!buf) { buf = await fetchAudio(text); cachePut(k, buf); }
      return buf;
    })();
    inflight.set(k, p);
    p.finally(() => inflight.delete(k)).catch(() => {});
    return p;
  }

  /* 后台预取（静默，失败不提示）。最多排 2 个，避免翻卡太快时积压 */
  let chain = Promise.resolve(), queued = 0;
  function prefetch(text) {
    const S = Store.state.settings;
    if (!S.key || !S.ttsModel || !text || queued >= 2) return;
    queued++;
    chain = chain.then(() => getBuf(text)).catch(() => {}).finally(() => queued--);
  }

  function system(t, onend) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'da-DK'; u.rate = 0.9;
      u.onend = u.onerror = onend;
      const v = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').toLowerCase().startsWith('da'));
      if (v) u.voice = v;
      else if (!warned) { warned = true; toast('没有找到丹麦语系统语音', 3500); }
      speechSynthesis.speak(u);
    } catch (e) { onend?.(); }
  }

  /* 按钮状态：🔊 空闲 → … 加载中 → ⏹ 播放中；再点同一个按钮 = 停止 */
  let active = null; // { btn, mode }
  function paint(mode) {
    const b = active?.btn;
    if (!b?.isConnected) return;
    b.classList.toggle('on', !!mode);
    b.textContent = mode === 'playing' ? '⏹' : mode === 'loading' ? '…' : '🔊';
  }
  function mark(mode) { if (active) { active.mode = mode; paint(mode); } }
  function finish() { paint(null); active = null; } // 自然播完或出错：只复位按钮
  function stop() { // 主动停止：作废还在进行中的请求，并复位按钮
    seq++;
    try { el?.pause(); } catch (e) {}
    try { speechSynthesis.cancel(); } catch (e) {}
    finish();
  }

  async function speak(text, btn) {
    if (btn && active?.btn === btn) return stop(); // 第二次点同一个按钮：停止
    stop();
    const me = ++seq, S = Store.state.settings;
    active = btn ? { btn, mode: null } : null; mark('loading');
    const viaSystem = () => { mark('playing'); system(text, () => { if (me === seq) finish(); }); };
    if (!S.key || !S.ttsModel) return viaSystem();
    try {
      unlock(); // 同步执行，仍在点击手势内
      const buf = await getBuf(text);
      if (me !== seq) return; // 等待期间已被停止或换成别的
      await play(buf);
      if (me === seq) mark('playing');
    } catch (e) {
      if (me !== seq) return;
      toast('Gemini 发音失败，改用系统语音：' + String(e.message || e).slice(0, 60), 3500);
      viaSystem();
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-say]');
    if (b) { e.stopPropagation(); speak(b.dataset.say, b); }
  }, true);

  const btn = t => `<button class="say" data-say="${esc(t)}" aria-label="朗读">🔊</button>`;
  return { speak, prefetch, clearCache, btn };
})();
