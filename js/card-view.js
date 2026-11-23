/* 卡片正反面的 HTML 渲染（词库和复习共用） */
const CardView = {
  front(c) {
    return `<p class="word">${esc(c.lemma)}${TTS.btn(c.lemma)}</p><div class="mute">${esc(c.ipa || '')}</div>`;
  },
  back(c) {
    const forms = c.forms.map(f => `<b>${esc(f.label)}</b><span>${esc(f.value)}${f.value ? TTS.btn(f.value) : ''}</span>`).join('');
    const ex = c.examples.map(x => `<div class="ex"><div>${esc(x.da)}${TTS.btn(x.da)}</div><div>${esc(x.zh)}</div></div>`).join('');
    const col = c.collocations.map(x => `<div class="ex"><div>${esc(x.da)}</div><div>${esc(x.zh)}</div></div>`).join('');
    const warn = c.warnings.length
      ? `<div class="warnbox">⚠ 待核对：<ul>${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
    return `<div><span class="tag">${esc(c.pos)}</span>${c.gender ? `<span class="tag">${esc(c.gender)}</span>` : ''}${c.warnings.length ? '<span class="tag warn">待核对</span>' : ''}</div>
    <p><b>${esc(c.meaning_zh)}</b><br><span class="mute">${esc(c.meaning_en)}</span></p>
    ${forms ? `<div class="forms">${forms}</div>` : ''}
    ${ex ? `<h2>例句</h2>${ex}` : ''}${col ? `<h2>搭配</h2>${col}` : ''}
    ${c.note ? `<p class="mute">${esc(c.note)}</p>` : ''}${warn}`;
  },
};
