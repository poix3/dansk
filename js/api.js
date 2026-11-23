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
      is_valid: { type: 'BOOLEAN' },
      reject_reason: { type: 'STRING' },
      suggestion: { type: 'STRING' },
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
    propertyOrdering: ['is_valid', 'reject_reason', 'suggestion', 'lemma', 'posKey', 'pos', 'gender', 'ipa', 'meaning_zh', 'meaning_en', 'forms', 'examples', 'collocations', 'confidence', 'note'],
    // 全部必填：模型不能只填几个字段就交差；无效输入时用空字符串/空数组占位
    required: ['is_valid', 'reject_reason', 'suggestion', 'lemma', 'posKey', 'pos', 'gender', 'ipa', 'meaning_zh', 'meaning_en', 'forms', 'examples', 'collocations', 'confidence', 'note'],
  };

  class RejectError extends Error {}

  /* 本地预检：在调用 API 之前拦掉明显不是丹麦语单词的输入，返回错误说明或 null */
  function precheck(w) {
    if (w.length > 40) return '太长了，请一次输入一个词或短词组';
    if (w.split(/\s+/).length > 4) return '只支持单词或短词组，不支持句子';
    if (!/^[\p{Script=Latin}\s'’.-]+$/u.test(w)) return '只能输入丹麦语（拉丁字母），不能包含汉字、数字或符号';
    if (!/[aeiouyæøå]/i.test(w)) return '看起来不是单词（没有元音）';
    if (/(.)\1{3,}/i.test(w)) return '有连续重复的字符，请检查拼写';
    return null;
  }

  function buildPrompt(word, problems) {
    return `你是严谨的丹麦语词典编辑。输入：“${word}”。
第一步，判断它是不是真实存在的丹麦语单词或常用词组（变形也算）。如果是随机字符、其他语言的词、无法确定的拼写错误，或根本不是词，把 is_valid 设为 false，用中文在 reject_reason 里说明原因；如果明显是拼写错误，在 suggestion 里给出最可能的正确丹麦语词。绝不要为了完成任务而给无意义的输入编造释义。is_valid 为 false 时，其余字段用空字符串或空数组占位（gender 填 none，posKey 填 other，confidence 填 low）。\nis_valid 为 true 时，所有字段都必须完整填写：中文释义、英文释义、IPA、按词性要求的全部变形、2-3 个例句、搭配、置信度，不能留空。
第二步（is_valid 为 true 时）：如果输入是变形，请还原为原形（lemma），并填写词条。
规则：
- pos 和 forms 的 label 一律使用中文术语，禁止出现丹麦语或英文的语法术语（不要写 udsagnsord、Infinitiv、Nutid、Datid、Førnutid、perfect 等）。pos 只能是：名词、动词、形容词、副词、代词、介词、连词、感叹词、数词。label 必须原样使用下面规定的名称。
- lemma 必须是词典原形：名词用单数不定形、不带冠词（bil，不是 en bil / bilerne）；动词用不带 at 的不定式（spise，不是 spiste / at spise）；形容词用基本形。
- 名词：gender 为 en 或 et；forms 必须含 单数定指、复数不定、复数定指。
- 动词：forms 的 label 依次为 不定式、现在时、过去时、完成时（value 带 har/er）、命令式。
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

  async function callOnce(prompt, notify) {
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
      } catch (e) { notify?.(`网络出错，${2 * (i + 1)} 秒后重试…`); await sleep(2000 * (i + 1)); continue; } // 网络抖动
      if (r.status === 429 || r.status >= 500) {
        const ms = r.status === 429 ? 15000 : 3000 * (i + 1);
        notify?.(r.status === 429 ? '请求太频繁，15 秒后重试…' : `服务暂时不可用，${ms / 1000} 秒后重试…`);
        await sleep(ms); continue;
      }
      if (!r.ok) throw new Error('API ' + r.status + '：' + (await r.text()).slice(0, 120));
      const j = await r.json();
      const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      return JSON.parse(txt.replace(/```json|```/g, '').trim());
    }
    throw new Error('请求失败或太频繁，稍后再试');
  }

  /* 生成并校验，返回规范化后的词条数据（不含 SRS 字段） */
  async function generate(word, notify) {
    const bad = precheck(word);
    if (bad) throw new RejectError(bad);
    let problems = [], last = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      let d;
      if (i) notify?.(`结果未通过校验，重新生成（第 ${i + 1} 次）…`);
      try { d = await callOnce(buildPrompt(word, problems), notify); }
      catch (e) { if (e instanceof SyntaxError) { problems = ['输出不是合法 JSON']; continue; } throw e; }
      if (d?.is_valid === false) {
        throw new RejectError('不像丹麦语单词：' + (d.reject_reason || '无法识别') + (d.suggestion ? `。你是想输入「${d.suggestion}」吗？` : ''));
      }
      const bl = d?.lemma && precheck(d.lemma);
      if (bl) { problems = ['lemma 不是合法的丹麦语词：' + bl]; continue; }
      const { errors, warnings } = validate(d);
      last = { d, errors, warnings };
      if (!errors.length) return finalize(d, warnings);
      problems = errors;
    }
    throw new Error('生成结果多次校验不通过：' + last.errors.join('；'));
  }

  function finalize(d, warnings) {
    return {
      lemma: d.lemma.trim().replace(/^(at|en|et)\s+(?=\S)/i, ''), // 防止模型带上 at/冠词
      posKey: d.posKey,
      pos: Store.canonPos(d.pos, d.posKey),
      gender: d.gender === 'none' ? null : d.gender,
      ipa: d.ipa || '',
      meaning_zh: d.meaning_zh.trim(),
      meaning_en: d.meaning_en || '',
      forms: d.forms.map(f => ({ label: Store.canonForm(f.label, d.posKey), value: f.value })),
      examples: d.examples,
      collocations: d.collocations || [],
      note: d.note || '',
      warnings,
    };
  }

  return { generate, validate, precheck, RejectError };
})();
