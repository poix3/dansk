/* 添加单词：搜索框里输入内容，点「添加」生成词条（Enter 同样触发） */
const AddView = (() => {
  let stopFlag = false, running = false, jobs = [];

  const ICON = { wait: '·', ok: '✓', dup: '＝', fail: '✗' };
  const splitWords = t => [...new Set(t.split(/[\n,;，；]+/).map(w => w.trim()).filter(Boolean))];

  function draw() {
    const done = jobs.filter(j => !['wait', 'run'].includes(j.s)).length;
    $('#jobpanel').hidden = !jobs.length;
    $('#bar').style.width = jobs.length ? (done / jobs.length * 100) + '%' : '0';
    $('#jobs').innerHTML = jobs.map(j => {
      const icon = j.s === 'run' ? '<span class="spin"></span>' : `<span class="${j.s === 'ok' ? 'ok' : j.s === 'fail' ? 'err' : ''}">${ICON[j.s]}</span>`;
      const msg = j.s === 'run' ? (j.msg || '正在生成…') : j.msg || '';
      return `<li class="${j.s}">${icon}<span class="w">${esc(j.label)}</span><span class="msg ${j.s === 'fail' ? 'err' : ''}">${esc(msg)}</span></li>`;
    }).join('');
    $('#retry').hidden = running || !jobs.some(j => j.s === 'fail' && !j.final);
    $('#stop').hidden = !running;
    $('#clearjobs').hidden = running;
    $('#go').disabled = running;
    $('#go').textContent = running ? `生成中 ${Math.min(done + 1, jobs.length)}/${jobs.length}` : '添加';
  }

  let shown = ''; // 我们最后写进输入框的内容；用户改过就不再覆盖
  /* 成功/已存在的词从输入框移除；没处理完和失败的留着，方便修改重试 */
  function syncInput() {
    const q = $('#q');
    if (q.value !== shown) return;
    shown = q.value = jobs.filter(j => ['wait', 'run', 'fail'].includes(j.s)).map(j => j.word).join(', ');
    LibraryView.render();
  }
  function dupJob(j, hit, typed) {
    j.s = 'dup'; j.label = hit.card.lemma;
    j.msg = hit.via ? `「${typed}」是「${hit.card.lemma}」的${hit.via}，词库里已有` : '词库里已经有了';
  }

  async function run(list) {
    shown = $('#q').value;
    stopFlag = false; running = true;
    jobs = list.map(w => ({ word: w, label: w, s: 'wait' })); draw();
    for (const j of jobs) {
      if (stopFlag) { j.msg = '已停止'; continue; }
      j.s = 'run'; draw();
      try {
        const hit = Store.findByForm(j.word); // 原形或任意变形已在词库里：不用再调用 API
        if (hit) dupJob(j, hit, j.word);
        else {
          const d = await Gemini.generate(j.word, m => { j.msg = m; draw(); });
          j.label = d.lemma.toLowerCase() === j.word.toLowerCase() ? d.lemma : `${j.word} → ${d.lemma}`;
          const again = Store.findByForm(d.lemma);
          if (again) dupJob(j, again, j.word);
          else {
            Store.state.cards.push(Store.normalize(Object.assign(d, { id: Date.now() + Math.random(), added: Date.now(), new: true })));
            Store.save();
            j.s = 'ok'; j.msg = d.warnings.length ? '已添加，⚠ 待核对' : '已添加';
          }
        }
      } catch (e) {
        j.s = 'fail'; j.msg = e.message;
        j.final = e instanceof Gemini.RejectError; // 输入本身有问题，重试没意义
      }
      draw(); syncInput();
      if (j.s === 'ok') await sleep(600);
    }
    running = false; draw(); syncInput();
  }

  function submit(e) {
    e.preventDefault();
    if (running) return;
    const words = splitWords($('#q').value);
    if (!words.length) return showHint('先输入要添加的单词，多个词用逗号分隔');
    if (!Store.state.settings.key) { showHint('还没有设置 Gemini API key，请到「设置」里填写'); return; }
    showHint('');
    run(words);
  }

  function showHint(t) { const h = $('#hint'); h.textContent = t; h.hidden = !t; }

  function init() {
    $('#searchform').onsubmit = submit;
    $('#q').addEventListener('input', () => showHint(''));
    $('#retry').onclick = () => { const l = jobs.filter(j => j.s === 'fail' && !j.final).map(j => j.word); if (l.length) run(l); };
    $('#stop').onclick = () => { stopFlag = true; };
    $('#clearjobs').onclick = () => { jobs = []; draw(); };
  }

  function show() {
    const S = Store.state, days = (Date.now() - S.lastBackup) / 864e5;
    const b = $('#banner');
    b.hidden = !(S.cards.length && days > 7);
    b.textContent = S.lastBackup ? `距离上次备份已 ${Math.floor(days)} 天，建议到「设置」导出一份。` : '还没有备份过，建议到「设置」导出一份 JSON。';
  }

  return { init, show };
})();
