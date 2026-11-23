/*
 * 数据存储
 * - IndexedDB 为主，localStorage 镜像（任何一边被清掉都能从另一边恢复）
 * - 启动时申请持久化存储，降低被系统清理的概率
 * - 读取时取 savedAt 较新的一份；兼容旧版 dk_vocab_v1 数据
 */
const Store = (() => {
  const LS_KEY = 'dk_vocab_v1', DB_NAME = 'dk_vocab', OS = 'kv', SCHEMA = 2;
  const DEFAULT_SETTINGS = { key: '', model: 'gemini-2.5-flash', ttsModel: 'gemini-3.8-flash-tts', voice: 'Kore' };
  const state = {
    cards: [],
    settings: { ...DEFAULT_SETTINGS },
    lastBackup: 0,
    savedAt: 0,
    schema: SCHEMA,
  };
  const status = { idb: false, ls: false, persisted: null, lastError: '' };
  let db = null;

  const POS_KEYS = [['noun', /名词/], ['verb', /动词/], ['adjective', /形容词/], ['adverb', /副词/]];
  const guessPosKey = pos => (POS_KEYS.find(([, re]) => re.test(pos || '')) || ['other'])[0];

  /* 旧数据补全字段 */
  function normalize(c) {
    c.forms = Array.isArray(c.forms) ? c.forms : [];
    c.examples = Array.isArray(c.examples) ? c.examples : [];
    c.collocations = Array.isArray(c.collocations) ? c.collocations : [];
    c.warnings = Array.isArray(c.warnings) ? c.warnings : [];
    if (!c.gender || c.gender === 'null') c.gender = null;
    c.posKey = c.posKey || guessPosKey(c.pos);
    c.ease = c.ease || 2.5; c.interval = c.interval || 0; c.reps = c.reps || 0; c.due = c.due || 0;
    c.added = c.added || Date.now();
    return c;
  }

  const idbOpen = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(OS);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const idbGet = k => new Promise((res, rej) => {
    const q = db.transaction(OS).objectStore(OS).get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const idbPut = (k, v) => new Promise((res, rej) => {
    const t = db.transaction(OS, 'readwrite');
    t.objectStore(OS).put(v, k);
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });

  async function load() {
    let a = null, b = null;
    try { db = await idbOpen(); a = await idbGet('state'); status.idb = true; } catch (e) { status.lastError = 'IndexedDB: ' + e; }
    try { b = JSON.parse(localStorage.getItem(LS_KEY)); status.ls = true; } catch (e) {}
    const src = [a, b].filter(Boolean).sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0))[0];
    if (src) {
      Object.assign(state, src);
      state.settings = Object.assign({}, DEFAULT_SETTINGS, src.settings);
      // 两份里另一份有而这份没有的卡片，补回来（防止其中一份丢数据）
      const other = src === a ? b : a;
      if (other?.cards) {
        const have = new Set(state.cards.map(c => c.lemma.toLowerCase()));
        other.cards.forEach(c => { if (!have.has(c.lemma.toLowerCase())) state.cards.push(c); });
      }
    }
    state.cards.forEach(normalize);
    state.schema = SCHEMA;
    try { status.persisted = await navigator.storage?.persist?.(); } catch (e) {}
    if (src && !a) save(); // 旧数据迁移进 IndexedDB
  }

  let pending = null;
  function save() {
    state.savedAt = Date.now();
    let lsOk = false;
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); lsOk = true; } catch (e) { status.lastError = 'localStorage: ' + e; }
    // IndexedDB 写入合并，避免连续保存时堆积
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try { if (db) { await idbPut('state', JSON.parse(JSON.stringify(state))); status.idb = true; } }
      catch (e) { status.idb = false; status.lastError = 'IndexedDB: ' + e; if (!lsOk) toast('保存失败，请立即导出备份', 5000); }
    }, 150);
    if (!lsOk && !db) toast('保存失败，请立即导出备份', 5000);
  }

  const findByLemma = l => state.cards.find(c => c.lemma.toLowerCase() === String(l).toLowerCase());

  return { state, status, DEFAULT_SETTINGS, load, save, normalize, findByLemma, guessPosKey };
})();
