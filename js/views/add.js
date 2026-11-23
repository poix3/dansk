/* 添加单词页 */
const AddView = (() => {
  let stopFlag = false, running = false, jobs = [];

  const ICON = { wait: '·', run: '…', ok: '✓', dup: '=', fail: '✗' };

  function draw() {
    const done = jobs.filter(j => j.s !== 'wait' && j.s !== 'run').length;
    $('#bar').style.width = jobs.length ? (done / jobs.length * 100) + '%' : '0';
    $('#jobs').innerHTML = jobs.map(j =>
      `<li><span class="${j.s === 'ok' ? 'ok' : j.s === 'fail' ? 'err' : ''}">${ICON[j.s]}</span><span>${esc(j.label)}</span><span class="msg ${j.s === 'fail' ? 'err' : ''}">${esc(j.msg || '')}</span></li>`).join('');
    $('#retry').hidden = running || !jobs.some(j => j.s === 'fail');
  }

  async function run(list) {
    const S = Store.state;
    if (!S.settings.key) { toast('请先在「设置」里填写 Gemini API key'); return App.tab('set'); }
    $('#addbox').hidden = false;
    stopFlag = false; running = true; $('#go').disabled = true; $('#stop').disabled = false;
    jobs = list.map(w => ({ word: w, label: w, s: 'wait' })); draw();
    for (const j of jobs) {
      if (stopFlag) break;
      j.s = 'run'; draw();
      try {
        const d = await Gemini.generate(j.word);
        j.label = d.lemma === j.word ? j.word : `${j.word} → ${d.lemma}`;
        if (Store.findByLemma(d.lemma)) { j.s = 'dup'; j.msg = '已存在'; }
        else {
          Store.state.cards.push(Store.normalize(Object.assign(d, { id: Date.now() + Math.random(), added: Date.now(), new: true })));
          Store.save(); LibraryView.render();
          j.s = 'ok'; j.msg = d.warnings.length ? '⚠ 待核对' : '';
        }
      } catch (e) { j.s = 'fail'; j.msg = e.message.slice(0, 80); }
      draw();
      await sleep(800);
    }
    running = false; $('#go').disabled = false; $('#stop').disabled = true;
    const ok = jobs.filter(j => j.s === 'ok').length;
    draw(); App.refreshBadge();
    toast(`完成，新增 ${ok} 个`);
  }

  function init() {
    $('#go').onclick = () => {
      const words = [...new Set($('#words').value.split(/\n+/).map(w => w.trim()).filter(Boolean))];
      if (!words.length) return;
      $('#words').value = '';
      run(words);
    };
    $('#retry').onclick = () => run(jobs.filter(j => j.s === 'fail').map(j => j.word));
    $('#stop').onclick = () => { stopFlag = true; };
    $('#stop').disabled = true;
    $('#toggleAdd').onclick = () => { const b = $('#addbox'); b.hidden = !b.hidden; if (!b.hidden) $('#words').focus(); };
  }

  function show() {
    const S = Store.state, days = (Date.now() - S.lastBackup) / 864e5;
    const b = $('#banner');
    b.hidden = !(S.cards.length && days > 7);
    b.textContent = S.lastBackup ? `距离上次备份已 ${Math.floor(days)} 天，建议到「设置」导出一份。` : '还没有备份过，建议到「设置」导出一份 JSON。';
  }

  return { init, show };
})();
