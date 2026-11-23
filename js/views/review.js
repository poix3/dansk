/* 复习页（点卡片或空格翻面，数字键 1-4 评分） */
const ReviewView = (() => {
  let queue = [], cur = null, flipped = false;

  function build() {
    const now = Date.now(), cards = Store.state.cards;
    const due = cards.filter(c => !c.new && c.due <= now).sort((a, b) => a.due - b.due);
    const fresh = cards.filter(c => c.new).slice(0, 20);
    queue = [...due, ...fresh];
  }

  function next() {
    cur = queue.shift(); flipped = false;
    const later = Store.state.cards.filter(c => !c.new && c.due > Date.now()).length;
    $('#revh').textContent = `复习（剩 ${queue.length + (cur ? 1 : 0)}）`;
    if (!cur) {
      $('#rev').innerHTML = `<div class="card"><p><b>${Store.state.cards.length ? '今天的复习完成了 🎉' : '词库还是空的'}</b></p><p class="mute">${Store.state.cards.length ? `之后还有 ${later} 张卡片排在未来复习。` : '先去「添加」页加一些单词吧。'}</p></div>`;
      return App.refreshBadge();
    }
    draw();
  }

  function draw() {
    $('#rev').innerHTML =
      `<div class="card ${flipped ? '' : 'tap'}" id="rcard">${CardView.front(cur)}${flipped ? '<hr class="sep">' + CardView.back(cur) : ''}</div>` +
      (flipped
        ? `<div class="grade"><button data-g="0">忘了</button><button data-g="1">模糊</button><button data-g="2">记得</button><button data-g="3">很熟</button></div>`
        : `<button class="pri flipbtn" id="flip">显示答案</button>`);
  }

  function flip() { if (cur && !flipped) { flipped = true; draw(); } }
  function grade(g) {
    if (!cur || !flipped) return;
    if (SRS.grade(cur, g)) queue.push(cur);
    Store.save(); next();
  }

  function init() {
    $('#rev').addEventListener('click', e => {
      const b = e.target.closest('[data-g]');
      if (b) return grade(+b.dataset.g);
      if (e.target.closest('#flip, #rcard')) flip();
    });
    document.addEventListener('keydown', e => {
      if (!$('#t-rev').classList.contains('on') || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      else if ('1234'.includes(e.key) && e.key) grade(+e.key - 1);
    });
  }

  const dueCount = () => Store.state.cards.filter(c => c.new || c.due <= Date.now()).length;

  return { init, show() { build(); next(); }, dueCount };
})();
