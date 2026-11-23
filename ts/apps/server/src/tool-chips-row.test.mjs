import assert from "node:assert/strict";
import { test } from "node:test";

import { planRowChips } from "../web/tool-chips.js";

/**
 * 灰块"最多一行"的排布口径（2026-11-19）。
 *
 * 用户改的口径：一行装得下就全部摊开，装不下才收进行首那枚「工作 N 步」折叠条。
 * 判定只能按真实宽度算——块宽随目标文本变，旧实现按块数（8 枚）猜，
 * 于是 8 枚短块挤成两行、5 枚长块第一行就满了，两种都错。
 *
 * 这里守住四件事：装得下不动、装不下收到刚好一行、运行中的块不被收走、
 * 宽度还没量出来（0）时先全摊着。
 */

const gap = 5;

test("一行装得下：不收起，全部显示", () => {
  const widths = [100, 100, 100, 100, 100];
  const plan = planRowChips({ widths, containerWidth: 520, gap });
  // 500 + 4×5 = 520，正好压线
  assert.deepEqual(plan, { keep: 5, folded: false });
});

test("差一点点就放不下：收起到刚好一行，并把行首折叠条的宽度算进去", () => {
  const widths = [100, 100, 100, 100, 100];
  const plan = planRowChips({ widths, containerWidth: 420, gap, moreWidth: 40 });
  assert.equal(plan.folded, true);
  assert.equal(plan.keep, 3);
  // 3 枚 + 3 个间隙 + 折叠条 = 300 + 15 + 40 = 355 ≤ 420，再多一枚就 460 > 420
  const used = 3 * 100 + gap * 3 + 40;
  assert.ok(used <= 420);
  assert.ok(used + 100 + gap > 420);
});

test("运行中的块不能被收走，宁可让前面的块先让位", () => {
  const widths = [100, 100, 100, 100, 100];
  const plan = planRowChips({ widths, containerWidth: 420, gap, moreWidth: 40, pinned: [4] });
  assert.equal(plan.folded, true);
  // 前 2 枚 + 末尾那枚运行中的 + 折叠条 = 200 + 100 + 15 + 40 = 355 ≤ 420
  assert.equal(plan.keep, 2);
});

test("容器宽度还没量出来：先全摊着，等 ResizeObserver 再来一次", () => {
  const widths = [100, 100, 100];
  assert.deepEqual(planRowChips({ widths, containerWidth: 0, gap }), { keep: 3, folded: false });
});

test("一枚块都没有：不需要按钮，也不假装折叠", () => {
  assert.deepEqual(planRowChips({ widths: [], containerWidth: 300, gap }), { keep: 0, folded: false });
});

test("极窄容器：一枚都排不下时也只留行首计数条", () => {
  const widths = [300, 300];
  const plan = planRowChips({ widths, containerWidth: 200, gap, moreWidth: 40 });
  assert.deepEqual(plan, { keep: 0, folded: true });
});
