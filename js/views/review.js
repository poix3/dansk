/*
 * 复习：连续出卡，没有每日上限，也不看是否到期——想学多少学多少。
 * 每张卡有两个方向（丹→中 fw / 中→丹 rv），各自独立排期；rv 在 fw 学过之后才出现。
 * 每次出卡：新项和已学项按比例混合；已学项里最早该复习的优先；
 * 最近出现过的词（含它的另一个方向）暂时回避，避免答案互相泄露。
 */
const ReviewView = (() => {
  const NEW_RATIO = 0.4;   // 两类都有时，抽到新项的概率
  const AVOID = 5;         // 回避最近几张卡
  let cur = null, flipped = false, recent = [], count = 0;

  function items() {
    const list = [];
    for (const c of Store.state.cards) {
      list.push({ c, dir: 'fw', st: c.srs.fw });
      if (!c.srs.fw.new) list.push({ c, dir: 'rv', st: c.srs.rv });
    }
    return list;
  }

  function pick() {
    const all = items();
    const fresh = all.filter(i => i.st.new).sort((a, b) => a.c.added - b.c.added);
    const seen = all.filter(i => !i.st.new).sort((a, b) => a.st.due - b.st.due);
    let pool = fresh.length && seen.length ? (Math.random() < NEW_RATIO ? fresh : seen) : (fresh.length ? fresh : seen);
    if (!pool.length) return null;
    const avoid = new Set(recent);
    const ok = pool.filter(i => !avoid.has(i.c.id));
    const cand = ok.length ? ok : pool;
    return pool === fresh ? cand[0] : cand[Math.floor(Math.random() * Math.min(3, cand.length))];
  }

  function next() {
    cur = pick(); flipped = false;
    if (cur) TTS.prefetch(cur.c.lemma); // 提前准备好这个词的发音，点 🔊 时通常已在缓存里
    $('#revh').textContent = count ? `复习（本次 ${count}）` : '复习';
    if (!cur) {
      $('#rev').innerHTML = '<div class="card"><p><b>词库还是空的</b></p><p class="mute">先去「词库」页添加一些单词吧。</p></div>';
      return;
    }
    draw();
  }

  function draw() {
    const { c, dir, st } = cur;
    const label = `${st.new ? '新词 · ' : ''}${dir === 'fw' ? '丹麦语 → 中文' : '中文 → 丹麦语'}`;
    const front = dir === 'fw' ? CardView.front(c) : CardView.frontRev(c);
    const answer = dir === 'fw' ? CardView.back(c) : CardView.answerRev(c);
    $('#rev').innerHTML =
      `<div class="dirtag">${label}</div>` +
      `<div class="card ${flipped ? '' : 'tap'}" id="rcard">${front}${flipped ? '<hr class="sep">' + answer : ''}</div>` +
      (flipped
        ? '<div class="grade"><button data-g="0">忘了</button><button data-g="1">模糊</button><button data-g="2">记得</button><button data-g="3">很熟</button></div>'
        : '<button class="pri flipbtn" id="flip">显示答案</button>');
  }

  function flip() { if (cur && !flipped) { flipped = true; draw(); } }
  function grade(g) {
    if (!cur || !flipped) return;
    SRS.grade(cur.st, g);
    recent.push(cur.c.id); if (recent.length > AVOID) recent.shift();
    count++; Store.save(); next();
  }

  function init() {
    $('#rev').addEventListener('click', e => {
      const b = e.target.closest('[data-g]');
      if (b) return grade(+b.dataset.g);
      if (e.target.closest('#flip, #rcard')) flip();
    });
    document.addEventListener('keydown', e => {
      if (!$('#t-rev').classList.contains('on') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      else if (['1', '2', '3', '4'].includes(e.key)) grade(+e.key - 1);
    });
  }

  return { init, show() { recent = []; count = 0; next(); } };
})();
