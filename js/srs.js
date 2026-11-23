/* 简化 SM-2。grade: 0 忘了 / 1 模糊 / 2 记得 / 3 很熟。返回 true 表示需要在本轮再出现 */
const SRS = {
  DAY: 864e5,
  grade(c, g, now = Date.now()) {
    if (g === 0) {
      c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2);
      c.due = now + 60000; c.new = false;
      return true;
    }
    if (g === 1) { c.interval = Math.max(1, Math.round((c.interval || 1) * 1.2)); c.ease = Math.max(1.3, c.ease - 0.15); }
    if (g === 2) c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.round(c.interval * c.ease);
    if (g === 3) { c.interval = c.reps === 0 ? 3 : Math.round(Math.max(c.interval, 1) * c.ease * 1.3); c.ease += 0.15; }
    c.reps++; c.new = false; c.due = now + c.interval * SRS.DAY;
    return false;
  },
};
