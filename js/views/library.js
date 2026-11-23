/* 词库页：搜索、筛选、重新生成、标记已核对、删除 */
const LibraryView = (() => {
  let filter = 'all';

  function render() {
    const S = Store.state, q = $('#q').value.trim().toLowerCase();
    const cs = S.cards
      .filter(c => !q || (c.lemma + c.meaning_zh + c.meaning_en).toLowerCase().includes(q))
      .filter(c => filter === 'all' || (filter === 'warn' ? c.warnings.length : c.posKey === filter))
      .sort((a, b) => b.added - a.added);
    const nWarn = S.cards.filter(c => c.warnings.length).length;
        $('#filters').innerHTML = [['all', `全部 ${S.cards.length}`], ['noun', '名词'], ['verb', '动词'], ['adjective', '形容词'], ['warn', `待核对${nWarn ? ' ' + nWarn : ''}`]]
      .map(([k, t]) => `<button data-f="${k}" class="${k === filter ? 'on' : ''}">${t}</button>`).join('');
    $('#list').innerHTML = cs.length ? cs.map(c => `<details data-id="${c.id}"><summary>${esc(c.lemma)} ${c.warnings.length ? '<span class="tag warn">待核对</span>' : ''}<span class="mute">${esc(c.meaning_zh)}</span></summary>
      <p class="word sm">${esc(c.lemma)}${TTS.btn(c.lemma)}<span class="ipa">${esc(c.ipa || '')}</span></p>${CardView.back(c)}
      <div class="row">
        <button class="small" data-act="regen">重新生成</button>
        ${c.warnings.length ? '<button class="small" data-act="ok">标记已核对</button>' : ''}
        <button class="small danger" data-act="del">删除</button>
      </div></details>`).join('')
      : `<p class="mute">${S.cards.length ? '没有符合条件的单词。' : '还没有单词。去「添加」页粘贴一些词吧。'}</p>`;
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
    App.refreshBadge();
  }

  function init() {
    $('#q').oninput = render;
    $('#filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; render(); } });
    $('#list').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const c = Store.state.cards.find(x => String(x.id) === b.closest('details').dataset.id); if (!c) return;
      if (b.dataset.act === 'del') {
        if (confirm(`删除「${c.lemma}」？`)) { Store.state.cards = Store.state.cards.filter(x => x !== c); Store.save(); render(); App.refreshBadge(); }
      } else if (b.dataset.act === 'ok') { c.warnings = []; Store.save(); render(); App.refreshBadge(); }
      else if (b.dataset.act === 'regen') regen(c, b);
    });
  }

  return { init, show() { render(); AddView.show(); }, render };
})();
