/* 设置与备份页 */
const SettingsView = (() => {
  const VOICES = ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Sulafat', 'Achird', 'Vindemiatrix'];
  const FILE = 'danish-vocab.json'; // 固定文件名：iCloud 里始终只有一份，覆盖即可

  function status() {
    const s = Store.status, S = Store.state;
    $('#storage').textContent =
      `词库 ${S.cards.length} 张 · 存储：IndexedDB ${s.idb ? '✓' : '✗'} · 持久化 ${s.persisted ? '已授权' : s.persisted === false ? '未授权' : '未知'}` +
      `\n上次备份：${S.lastBackup ? new Date(S.lastBackup).toLocaleString() : '从未'}` + (s.lastError ? `\n最近错误：${s.lastError}` : '');
  }

  /* 备份内容：不含 API key；语音缓存也不导出 */
  function backupFile() {
    const S = Store.state;
    const data = { schema: S.schema, cards: S.cards, lastBackup: Date.now(), settings: { model: S.settings.model, ttsModel: S.settings.ttsModel, voice: S.settings.voice } };
    return new File([JSON.stringify(data, null, 1)], FILE, { type: 'application/json' });
  }

  async function exportBackup() {
    const f = backupFile();
    try {
      if (navigator.canShare?.({ files: [f] })) {
        await navigator.share({ files: [f], title: FILE }); // iOS 分享菜单里选「存储到文件」
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f); a.download = FILE; a.click();
      }
    } catch (e) { if (e.name === 'AbortError') return; toast('导出失败：' + e.message); return; }
    Store.state.lastBackup = Date.now(); Store.save(); status();
  }

  /* 导入 = 合并到当前唯一的库：按词条去重；同一词两边都有时保留学习进度更多的那份进度 */
  function merge(cards) {
    let added = 0, updated = 0;
    cards.forEach(raw => {
      if (!raw?.lemma) return;
      const mine = Store.findByLemma(raw.lemma), c = Store.normalize(raw);
      if (!mine) { Store.state.cards.push(c); added++; }
      else if (c.reps > mine.reps) {
        Object.assign(mine, { reps: c.reps, ease: c.ease, interval: c.interval, due: c.due, new: c.new }); updated++;
      }
    });
    return { added, updated };
  }

  function init() {
    const S = Store.state;
    $('#key').value = S.settings.key; $('#model').value = S.settings.model; $('#ttsModel').value = S.settings.ttsModel;
    $('#voice').innerHTML = VOICES.map(v => `<option>${v}</option>`).join('');
    $('#voice').value = S.settings.voice;
    $('#save').onclick = () => {
      const D = Store.DEFAULT_SETTINGS;
      Object.assign(S.settings, {
        key: $('#key').value.trim(), model: $('#model').value.trim() || D.model,
        ttsModel: $('#ttsModel').value.trim() || D.ttsModel, voice: $('#voice').value,
      });
      Store.save(); toast('已保存');
    };
    $('#testVoice').onclick = () => { $('#save').click(); TTS.speak('Hej, hvordan har du det i dag?'); };
    $('#exp').onclick = exportBackup;
    $('#imp').onclick = () => $('#file').click();
    $('#file').onchange = async e => {
      try {
        const d = JSON.parse(await e.target.files[0].text());
        if (!Array.isArray(d.cards)) throw 0;
        const { added, updated } = merge(d.cards);
        Store.save(); App.refreshBadge(); LibraryView.render();
        $('#setlog').textContent = `导入完成：新增 ${added} 张，更新学习进度 ${updated} 张。`;
      } catch (err) { $('#setlog').textContent = '导入失败：文件格式不对'; }
      e.target.value = '';
    };
  }

  return { init, show: status };
})();
