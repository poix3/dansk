/* 入口：加载数据、标签页路由 */
const App = (() => {
  const views = { lib: LibraryView, rev: ReviewView, set: SettingsView };

  function tab(t) {
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === 't-' + t));
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    views[t].show?.();
    window.scrollTo(0, 0);
  }

  function refreshBadge() {
    const n = ReviewView.dueCount();
    $('#revbadge').textContent = n > 99 ? '99+' : n || '';
  }

  async function start() {
    await Store.load();
    Object.values(views).forEach(v => v.init());
    document.querySelectorAll('nav button').forEach(b => b.onclick = () => tab(b.dataset.t));
    refreshBadge();
    tab('lib');
  }

  return { tab, refreshBadge, start };
})();

App.start();
