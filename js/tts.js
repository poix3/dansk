/*
 * 发音：Gemini TTS（Interactions API）+ 本地音频缓存；失败时回退到系统语音
 * - 同一段文字只调用一次 API，之后从 IndexedDB 播放（独立数据库 dk_audio，不进备份）
 * - 用 WebAudio 播放，并在点击手势里先 resume，避免 iOS 在异步请求后拒绝播放
 * - iPhone 侧边静音开关打开时，WebAudio 没有声音
 */
const TTS = (() => {
  const DB_NAME = 'dk_audio', OS = 'clips', MAX_CLIPS = 600;
  let adb = null, ctx = null, src = null, warned = false, seq = 0;

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
  async function cachePut(k, buf) {
    try {
      const d = await open(), store = d.transaction(OS, 'readwrite').objectStore(OS);
      store.put({ k, buf, t: Date.now() });
      const over = (await req(store.count())) - MAX_CLIPS;
      if (over > 0) { // 淘汰最久没听过的
        let n = 0;
        store.index('t').openKeyCursor().onsuccess = e => {
          const c = e.target.result;
          if (c && n++ < over) { store.delete(c.primaryKey); c.continue(); }
        };
      }
    } catch (e) {}
  }

  const b64ToBuf = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

  async function fetchAudio(text) {
    const { key, ttsModel, voice } = Store.state.settings;
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        model: ttsModel,
        input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!r.ok) throw new Error('TTS ' + r.status + '：' + (await r.text()).slice(0, 100));
    const j = await r.json();
    const audio = (j.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'audio').pop();
    if (!audio?.data) throw new Error('TTS 返回里没有音频');
    return b64ToBuf(audio.data); // 非流式返回带头的 WAV，decodeAudioData 可直接解码
  }

  function play(buf) {
    return ctx.decodeAudioData(buf.slice(0)).then(ab => {
      try { src?.stop(); } catch (e) {}
      src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination); src.start();
    });
  }

  function system(t) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'da-DK'; u.rate = 0.9;
      const v = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').toLowerCase().startsWith('da'));
      if (v) u.voice = v;
      else if (!warned) { warned = true; toast('没有找到丹麦语系统语音', 3500); }
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  async function speak(text) {
    const me = ++seq, S = Store.state.settings;
    try { speechSynthesis.cancel(); } catch (e) {}
    if (!S.key || !S.ttsModel) return system(text);
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume(); // 必须在点击手势内尽早调用
      const k = `${S.ttsModel}|${S.voice}|${text}`;
      let buf = await cacheGet(k);
      if (!buf) {
        buf = await fetchAudio(text);
        cachePut(k, buf);
      }
      if (me === seq) await play(buf); // 期间又点了别的就不播这条
    } catch (e) {
      toast('Gemini 发音失败，改用系统语音：' + String(e.message || e).slice(0, 60), 3500);
      system(text);
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-say]');
    if (b) { e.stopPropagation(); speak(b.dataset.say); }
  }, true);

  const btn = t => `<button class="say" data-say="${esc(t)}" aria-label="朗读">🔊</button>`;
  return { speak, btn };
})();
