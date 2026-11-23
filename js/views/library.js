/* 词库页：搜索、筛选、重新生成、标记已核对、删除 */
const LibraryView = (() => {
  let filter = 'all';

  /* 搜的是变形时，在结果上标出命中的是哪个变形，如“spiste · 过去时” */
  function viaTag(c, q) {
    if (!q) return '';
    const s = Store.strip(q);
    if (Store.strip(c.lemma) === s) return '';
    const f = c.forms.find(f => f.value && (f.value.toLowerCase().trim() === q || Store.strip(f.value) === s));
    return f ? `<span class="tag">${esc(f.value)} · ${esc(f.label)}</span>` : '';
  }

  function render() {
    const S = Store.state, q = $('#q').value.trim().toLowerCase();
    const rk = new Map(S.cards.map(c => [c, q ? Store.rank(c, q) : 0]));
    const cs = S.cards
      .filter(c => rk.get(c) >= 0)
      .filter(c => filter === 'all' || (filter === 'warn' ? c.warnings.length : c.posKey === filter))
      .sort((a, b) => rk.get(a) - rk.get(b) || b.added - a.added); // 精确命中的排前面
    const nWarn = S.cards.filter(c => c.warnings.length).length;
    $('#filters').innerHTML = [['all', `全部 ${S.cards.length}`], ['noun', '名词'], ['verb', '动词'], ['adjective', '形容词'], ['warn', `待核对${nWarn ? ' ' + nWarn : ''}`]]
      .map(([k, t]) => `<button data-f="${k}" class="${k === filter ? 'on' : ''}">${t}</button>`).join('');
    $('#list').innerHTML = cs.length ? cs.map(c => `<details data-id="${c.id}"><summary>${esc(c.lemma)} ${viaTag(c, q)}${c.warnings.length ? '<span class="tag warn">待核对</span>' : ''}<span class="mute">${esc(c.meaning_zh)}</span></summary>
      <p class="word sm">${esc(c.lemma)}${TTS.btn(c.lemma)}<span class="ipa">${esc(c.ipa || '')}</span></p>${CardView.back(c)}
      <div class="row">
        <button class="small" data-act="regen">重新生成</button>
        ${c.warnings.length ? '<button class="small" data-act="ok">标记已核对</button>' : ''}
        <button class="small danger" data-act="del">删除</button>
      </div>
      <div class="foldrow"><button class="small" data-act="close">收起 ▲</button></div></details>`).join('')
      : `<p class="mute empty">${!S.cards.length ? '词库还是空的。在上面输入单词，点「添加」生成词条。'
        : q ? `没有找到「${esc($('#q').value.trim())}」。点「添加」可以生成这个词条。` : '没有符合条件的单词。'}</p>`;
  }

  async function regen(c, btn) {
    if (!Store.state.settings.key) return toast('请先在设置里填写 API key');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const d = await Gemini.generate(c.lemma);
      // 只覆盖内容，保留学习进度
      Object.assign(c, d, { lemma: c.lemma });
      Store.save(); toast('已更新');
    } catch (e) { toast('失败：' + e.message.slice(0, 60), 4000); }
    const open = c.id;
    render(); document.querySelector(`details[data-id="${open}"]`)?.setAttribute('open', '');
   
  }

  function init() {
    AddView.init();
    $('#q').oninput = render;
    // 一次只展开一个；展开后滚到它的标题处
    $('#list').addEventListener('toggle', e => {
      const d = e.target;
      if (d.tagName !== 'DETAILS' || !d.open) return;
      $('#list').querySelectorAll('details[open]').forEach(o => { if (o !== d) o.open = false; });
      d.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, true);
    $('#filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; render(); } });
    $('#list').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const c = Store.state.cards.find(x => String(x.id) === b.closest('details').dataset.id); if (!c) return;
      if (b.dataset.act === 'close') {
        const d = b.closest('details'); d.open = false; d.scrollIntoView({ block: 'nearest' });
      } else if (b.dataset.act === 'del') {
        if (confirm(`删除「${c.lemma}」？`)) { Store.state.cards = Store.state.cards.filter(x => x !== c); Store.save(); render(); }
      } else if (b.dataset.act === 'ok') { c.warnings = []; Store.save(); render(); }
      else if (b.dataset.act === 'regen') regen(c, b);
    });
  }

  return { init, show() { render(); AddView.show(); }, render };
})();
