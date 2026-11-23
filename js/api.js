/*
 * Gemini 词条生成
 * 可靠性措施：
 *  1. responseSchema 强制结构化输出
 *  2. 本地校验（词形数量、名词性别、例句是否含该词等），硬错误会带着原因重试
 *  3. 软问题（例句没找到该词、模型自评低信心）不阻断，但存入 card.warnings，界面显示“待核对”
 */
const Gemini = (() => {
  const REQUIRED_FORMS = { noun: 3, verb: 5, adjective: 4 };
  const MAX_ATTEMPTS = 3;

  const pair = { type: 'OBJECT', properties: { da: { type: 'STRING' }, zh: { type: 'STRING' } }, required: ['da', 'zh'] };
  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      lemma: { type: 'STRING' },
      posKey: { type: 'STRING', enum: ['noun', 'verb', 'adjective', 'adverb', 'other'] },
      pos: { type: 'STRING' },
      gender: { type: 'STRING', enum: ['en', 'et', 'none'] },
      ipa: { type: 'STRING' },
      meaning_zh: { type: 'STRING' },
      meaning_en: { type: 'STRING' },
      forms: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['label', 'value'] } },
      examples: { type: 'ARRAY', items: pair },
      collocations: { type: 'ARRAY', items: pair },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
      note: { type: 'STRING' },
    },
    required: ['lemma', 'posKey', 'pos', 'gender', 'meaning_zh', 'meaning_en', 'forms', 'examples', 'confidence'],
  };

  function buildPrompt(word, problems) {
    return `你是严谨的丹麦语词典编辑。词条：“${word}”。如果它是变形，请还原为原形（lemma）。
规则：
- 名词：gender 为 en 或 et；forms 必须含 单数定指、复数不定、复数定指。
- 动词：forms 必须含 不定式、现在时、过去时、完成时（带 har/er）、命令式。
- 形容词：forms 必须含 中性(-t)、复数/定指(-e)、比较级、最高级。
- 其他词性：gender 填 none，forms 可为空数组。
- 所有变形必须是真实存在的标准丹麦语形式（含不规则变化），不要按规则臆造；不确定就把 confidence 设为 low 并在 note 里说明。
- 例句 2-3 个，难度 A1-B1，句中必须出现该词或其变形，中文翻译自然；搭配 2-4 个。
- ipa 给出标准丹麦语音标，meaning_zh 简洁。${problems?.length ? `\n\n上一次输出存在以下问题，请修正：\n- ${problems.join('\n- ')}` : ''}`;
  }

  /* 本地校验：返回 {errors, warnings} */
  function validate(d) {
    const errors = [], warnings = [];
    if (!d || typeof d !== 'object') return { errors: ['返回不是对象'], warnings };
    if (!d.lemma?.trim()) errors.push('缺少 lemma');
    if (!d.meaning_zh?.trim()) errors.push('缺少中文释义');
    const forms = Array.isArray(d.forms) ? d.forms : [];
    const need = REQUIRED_FORMS[d.posKey] || 0;
    if (forms.length < need) errors.push(`${d.pos || d.posKey} 至少需要 ${need} 个变形，只给了 ${forms.length} 个`);
    if (forms.some(f => !f.label?.trim() || !f.value?.trim())) errors.push('forms 中有空的 label 或 value');
    if (d.posKey === 'noun' && !['en', 'et'].includes(d.gender)) errors.push('名词必须指明 gender 为 en 或 et');
    const ex = Array.isArray(d.examples) ? d.examples : [];
    if (ex.length < 1 || ex.some(x => !x.da?.trim() || !x.zh?.trim())) errors.push('例句缺失或有空字段');

    // 软校验：例句里应出现原形或某个变形
    const toks = new Set();
    [d.lemma, ...forms.map(f => f.value)].forEach(v => String(v || '').toLowerCase().split(/[\s/,()]+/)
      .filter(t => t.length > 1 && !['at', 'har', 'er', 'en', 'et', 'den', 'det', 'de'].includes(t)).forEach(t => toks.add(t)));
    const stem = String(d.lemma || '').toLowerCase().replace(/^at /, '');
    ex.forEach((x, i) => {
      const words = x.da.toLowerCase().match(/[a-zæøåé]+/g) || [];
      const hit = words.some(w => toks.has(w)) || (stem.length > 3 && words.some(w => w.includes(stem.slice(0, -1))));
      if (!hit) warnings.push(`例句 ${i + 1} 中没找到该词或其变形，请核对`);
    });
    if (d.confidence === 'low') warnings.push('模型对变形/用法信心较低' + (d.note ? '：' + d.note : ''));
    return { errors, warnings };
  }

  async function callOnce(prompt) {
    const { key, model } = Store.state.settings;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
          }),
        });
      } catch (e) { await sleep(2000 * (i + 1)); continue; } // 网络抖动
      if (r.status === 429 || r.status >= 500) { await sleep(r.status === 429 ? 15000 : 3000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('API ' + r.status + '：' + (await r.text()).slice(0, 120));
      const j = await r.json();
      const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      return JSON.parse(txt.replace(/```json|```/g, '').trim());
    }
    throw new Error('请求失败或太频繁，稍后再试');
  }

  /* 生成并校验，返回规范化后的词条数据（不含 SRS 字段） */
  async function generate(word) {
    let problems = [], last = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      let d;
      try { d = await callOnce(buildPrompt(word, problems)); }
      catch (e) { if (e instanceof SyntaxError) { problems = ['输出不是合法 JSON']; continue; } throw e; }
      const { errors, warnings } = validate(d);
      last = { d, errors, warnings };
      if (!errors.length) return finalize(d, warnings);
      problems = errors;
    }
    throw new Error('生成结果多次校验不通过：' + last.errors.join('；'));
  }

  function finalize(d, warnings) {
    return {
      lemma: d.lemma.trim(),
      posKey: d.posKey,
      pos: d.pos,
      gender: d.gender === 'none' ? null : d.gender,
      ipa: d.ipa || '',
      meaning_zh: d.meaning_zh.trim(),
      meaning_en: d.meaning_en || '',
      forms: d.forms,
      examples: d.examples,
      collocations: d.collocations || [],
      note: d.note || '',
      warnings,
    };
  }

  return { generate, validate };
})();
