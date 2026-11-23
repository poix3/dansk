/*
 * 简化 SM-2，作用于一个“学习项”：{ease, interval(天), reps, due, last, new}
 * grade: 0 忘了 / 1 模糊 / 2 记得 / 3 很熟
 * 复习不受到期限制，想练多少练多少；为避免提前反复复习把间隔越撑越大：
 * 对已经毕业（interval>0）的项，如果还没到期就答对，只算练习——不改间隔、不加次数。
 */
const SRS = {
  DAY: 864e5,
  grade(c, g, now = Date.now()) {
    const early = c.interval > 0 && now < c.due;
    c.last = now;
    if (g >= 2 && early) return; // 练习，不改排期
    if (g === 0) {
      c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2);
      c.due = now + 60000; c.new = false;
      return;
    }
    if (g === 1) { c.interval = Math.max(1, Math.round((c.interval || 1) * 1.2)); c.ease = Math.max(1.3, c.ease - 0.15); }
    if (g === 2) c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.round(c.interval * c.ease);
    if (g === 3) { c.interval = c.reps === 0 ? 3 : Math.round(Math.max(c.interval, 1) * c.ease * 1.3); c.ease += 0.15; }
    c.reps++; c.new = false; c.due = now + c.interval * SRS.DAY;
  },
};
