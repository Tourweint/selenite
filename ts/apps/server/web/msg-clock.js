/**
 * 消息时刻（2026-11-17）
 *
 * 口径对齐 ZCode 的消息时间：今天只写 `14:03`，昨天写 `昨天 14:03`，
 * 今年更早写 `11月16日 14:03`，跨年才带年份。只到分钟——回头翻旧账时秒没用，
 * 还会把一条 11px 的脚注撑得很吵。
 *
 * 纯格式化函数留在这里（无 DOM 依赖），节点挂载在 chat-thread.js 的回答脚注里
 * （2026-11-17 晚间口径：只给 assistant，紧挨复制图标，hover 才显示）。
 * 这样这条口径能进 node 单测，不用为了一个时间格式起浏览器。
 */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function sameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `at` = epoch 毫秒；`now` 只给测试用。返回空串表示时间无效。 */
export function formatMessageClock(at, now = Date.now()) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return "";
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return "";
  const current = new Date(now);
  const hm = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
  if (sameCalendarDay(when, current)) return hm;
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  if (sameCalendarDay(when, yesterday)) return `昨天 ${hm}`;
  if (when.getFullYear() === current.getFullYear()) {
    return `${when.getMonth() + 1}月${when.getDate()}日 ${hm}`;
  }
  return `${when.getFullYear()}年${when.getMonth() + 1}月${when.getDate()}日 ${hm}`;
}

/**
 * 把时刻写进一个 `<time>` 节点。时间无效就藏起来，不占位、不写 0。
 * 返回实际写上去的文字，方便调用方判断"到底有没有值"。
 */
export function setMessageClock(node, at, now = Date.now()) {
  const text = formatMessageClock(at, now);
  if (!node) return text;
  if (!text) {
    node.hidden = true;
    node.textContent = "";
    node.removeAttribute("datetime");
    return "";
  }
  const when = new Date(Number(at));
  node.hidden = false;
  node.textContent = text;
  node.dateTime = when.toISOString();
  return text;
}
