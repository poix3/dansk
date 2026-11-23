/*
 * 数据存储
 * - IndexedDB 为主，localStorage 镜像（任何一边被清掉都能从另一边恢复）
 * - 启动时申请持久化存储，降低被系统清理的概率
 * - 读取时取 savedAt 较新的一份；兼容旧版 dk_vocab_v1 数据
 */
const Store = (() => {
  const LS_KEY = 'dk_vocab_v1', DB_NAME = 'dk_vocab', OS = 'kv', SCHEMA = 3;
  const DEFAULT_SETTINGS = { key: '', model: 'gemini-2.5-flash', ttsModel: 'gemini-3.8-flash-lite-tts', voice: 'Kore' };
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
  const POS_GUESS = [['noun', /名词|navneord|substantiv|noun/i], ['verb', /动词|udsagnsord|verb/i], ['adjective', /形容词|tillægsord|adjektiv|adjective/i], ['adverb', /副词|biord|adverb/i]];
  const guessPosKey = pos => (POS_GUESS.find(([, re]) => re.test(pos || '')) || ['other'])[0];

  /* ---- 语法术语统一成中文（模型有时会写成丹麦语 Førnutid / 英语 perfect 等） ---- */
  const POS_ZH = { noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词' };
  const POS_OTHER = [[/pronomen|pronoun|代词/i, '代词'], [/præposition|preposition|介词/i, '介词'], [/konjunktion|conjunction|连词/i, '连词'],
    [/interjektion|interjection|感叹/i, '感叹词'], [/talord|numeral|number|数词/i, '数词']];
  function canonPos(pos, posKey) {
    if (POS_ZH[posKey]) return POS_ZH[posKey];
    const hit = POS_OTHER.find(([re]) => re.test(pos || ''));
    return hit ? hit[1] : (/[\u4e00-\u9fa5]/.test(pos || '') ? pos : '其他');
  }
  function canonForm(label, posKey) {
    const l = String(label || '').toLowerCase();
    if (posKey === 'verb') {
      if (/infinitiv|infinitive|不定式|原形/.test(l)) return '不定式';
      if (/førnutid|perfektum|perfect|完成|过去分词|participle|particip/.test(l)) return '完成时'; // 必须先于“现在时”（førnutid 含 nutid）
      if (/bydende|imperativ|命令/.test(l)) return '命令式';
      if (/nutid|present|现在/.test(l)) return '现在时';
      if (/datid|præteritum|preterit|past|过去/.test(l)) return '过去时';
    } else if (posKey === 'adjective') {
      if (/komparativ|comparative|比较/.test(l)) return '比较级';
      if (/superlativ|superlative|最高/.test(l)) return '最高级';
      if (/中性|neut|intetkøn|-t\b/.test(l)) return '中性(-t)';
      if (/plural|flertal|definit|bestemt|复数|定指|-e\b/.test(l)) return '复数/定指(-e)';
    } else if (posKey === 'noun') {
      const plural = /复数|plural|flertal/.test(l), single = /单数|singular|ental/.test(l);
      const indef = /不定|indefinit|ubestemt/.test(l), def = !indef && /定指|definit|bestemt|确指/.test(l);
      if (plural) return def ? '复数定指' : '复数不定';
      if (single) return def ? '单数定指' : indef ? '单数不定' : label;
    }
    return label;
  }

  /* 旧数据补全字段 */
  function normalize(c) {
    c.forms = Array.isArray(c.forms) ? c.forms : [];
    c.examples = Array.isArray(c.examples) ? c.examples : [];
    c.collocations = Array.isArray(c.collocations) ? c.collocations : [];
    c.warnings = Array.isArray(c.warnings) ? c.warnings : [];
    if (!c.gender || c.gender === 'null') c.gender = null;
    c.posKey = c.posKey || guessPosKey(c.pos);
    // 复习进度：每个方向（fw 丹→中，rv 中→丹）各自独立。旧版卡片的进度归入 fw
    const blank = () => ({ ease: 2.5, interval: 0, reps: 0, due: 0, last: 0, new: true });
    if (!c.srs) {
      c.srs = {
        fw: { ease: c.ease || 2.5, interval: c.interval || 0, reps: c.reps || 0, due: c.due || 0, last: 0, new: c.new === undefined ? !(c.reps > 0) : !!c.new },
        rv: blank(),
      };
    }
    c.srs.fw = Object.assign(blank(), c.srs.fw); c.srs.rv = Object.assign(blank(), c.srs.rv);
    delete c.ease; delete c.interval; delete c.reps; delete c.due; delete c.new;
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
    if (state.settings.ttsModel === 'gemini-3.8-flash-tts') state.settings.ttsModel = DEFAULT_SETTINGS.ttsModel; // 旧默认值 → 更便宜的 Lite
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

  /* 去掉词前的 at/har/er/冠词，便于比较：“at spise”“har spist”“en bil” → spise/spist/bil */
  const strip = v => String(v || '').toLowerCase().trim().replace(/^(at|har|er|en|et|den|det|de)\s+/, '');
  const variants = c => {
    const out = new Set();
    [c.lemma, ...c.forms.map(f => f.value)].forEach(v => { const l = String(v || '').toLowerCase().trim(); if (l) { out.add(l); out.add(strip(l)); } });
    return out;
  };
  /* 输入的词若是某张卡的原形或任意变形，返回 {card, via}；via 为变形名称（原形命中时为 null） */
  function findByForm(w) {
    const raw = String(w).toLowerCase().trim(), s = strip(raw);
    const byLemma = state.cards.find(c => strip(c.lemma) === s);
    if (byLemma) return { card: byLemma, via: null };
    for (const c of state.cards) {
      const f = c.forms.find(f => f.value && (f.value.toLowerCase().trim() === raw || strip(f.value) === s));
      if (f) return { card: c, via: f.label };
    }
    return null;
  }
  /* 搜索排序：0 精确命中某个形式；1 形式里包含；2 释义里包含；-1 不匹配 */
  function rank(c, q) {
    const s = strip(q), vs = variants(c);
    if (vs.has(q) || vs.has(s)) return 0;
    for (const v of vs) if (v.includes(q) || (s && v.includes(s))) return 1;
    return (c.meaning_zh + ' ' + c.meaning_en).toLowerCase().includes(q) ? 2 : -1;
  }
  const findByLemma = l => state.cards.find(c => c.lemma.toLowerCase() === String(l).toLowerCase());

  return { state, status, DEFAULT_SETTINGS, load, save, normalize, findByLemma, findByForm, rank, strip, guessPosKey, canonPos, canonForm };
})();
