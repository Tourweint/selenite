/**
 * 极简 Markdown / 代码块 / 表格 / 转义
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

/* ── 极简 Markdown ────────────────────────────────────── */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (text) => text.replace(/[&<>]/g, (char) => ESCAPES[char]);
/** 放进 HTML 属性值里用：esc 不处理引号，这里补上 */
const attr = (text) => esc(String(text ?? "")).replace(/"/g, "&quot;");

/**
 * 行内渲染（2026-11-10 批 33 对齐 ZCode 的 markdown 水平）。
 * 顺序有讲究：先转义，再把行内码换占位符保护起来（里面的 `*`、URL 不该再被加工），
 * 然后加粗/斜体/删除线 → 显式链接 → 图片 → 裸 URL 自动链接 → 任务单号。
 */
function inline(raw) {
  const protectedCode = [];
  return esc(raw)
    // 行内码先保护：内容原样保留，不参与后续任何替换
    .replace(/`([^`]+)`/g, (_m, code) => {
      protectedCode.push(`<code>${code}</code>`);
      return `\u0001${protectedCode.length - 1}\u0001`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // 删除线（批 33）：GFM ~~text~~
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )
    // 图片（批 33）：只认 https，模型偶尔会贴图链；失败就当普通链接看
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<img src="$2" alt="$1" loading="lazy" class="md-img">',
    )
    // 裸 URL 自动链接（批 33）：不在 href 属性里（前面不是引号/等号）才补 <a>
    .replace(
      /(^|[\s(（【])((?:https?:\/\/)[^\s<>"'）】]+[^\s<>"'（）】.,;:!?])/g,
      (_m, prefix, url) => `${prefix}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
    )
    // 任务单号自动变链接：历史里的「【任务 t-2026… · 前端】已完成」也能点进详情。
    // 只在空白/括号后命中，避免把 code、属性值里的字符改坏。
    .replace(
      /(^|[\s(（【])((?:t-\d{8}-\d{6}-[0-9a-z]+|T-\d{3,}))(?![0-9a-z-])/gi,
      (_match, prefix, id) =>
        `${prefix}<a href="#/tasks?ticket=${encodeURIComponent(id)}" class="ticket-link">${id}</a>`,
    )
    // 还原行内码（内容已转义过，直接回填）
    .replace(/\u0001(\d+)\u0001/g, (_m, index) => protectedCode[Number(index)] || "");
}

/* ── 对话里的派单提示 ─────────────────────────────────────
 * 受理后补一句「任务已派发，可在任务中心查看」，并做成真链接；
 * 后台跑完时同一个任务单的那句会更新成「已完成 / 待你处理 / 失败」。
 * 每条任务单一句话，不堆重复行。 */
const DELEGATE_HINTS = new WeakMap();

function delegateHintText(phase) {
  switch (phase) {
    case "done":
      return "任务已完成，可以到任务中心查看结果。";
    case "needs_you":
      return "任务需要你处理，去任务中心看看。";
    case "failed":
      return "任务没做成，任务中心里有失败原因。";
    case "aborted":
      return "任务已中止。";
    default:
      return "任务已派发，可在任务中心查看。";
  }
}

function syncDelegateHint(root, event) {
  if (!event.ticketId) return;
  let hint = root.querySelector(".delegate-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "delegate-hint is-new";
    hint.addEventListener("animationend", () => hint.classList.remove("is-new"), { once: true });
    DELEGATE_HINTS.set(hint, new Map());
    root.append(hint);
  }
  const items = DELEGATE_HINTS.get(hint);
  items.set(event.ticketId, delegateHintText(event.phase));
  hint.replaceChildren();
  for (const [ticketId, text] of items) {
    const link = document.createElement("a");
    link.href = `#/tasks?ticket=${encodeURIComponent(ticketId)}`;
    link.textContent = text;
    hint.append(link);
  }
}

/* ── 交互卡片（2026-11-21，方案见 docs/设计方案/2026-11-21-表格渲染与交互消息/）──
 * 助手回复里闭合的 ```html 围栏渲染成内联沙箱卡（形态 1：无工具条，直勾勾渲染）。
 * 这里只产出占位符（不产 iframe）：流式 reconciler 按「元素+属性一致」保节点，
 * 挂载阶段加的任何属性都会让下一轮增量把卡换掉，所以挂载收在 web/html-cards.js。
 * 只认闭合围栏：流式没写完先显示普通代码块，闭合后下一轮升级成卡，不闪半截。
 * 回滚 CHAT_HTML_CARDS（app.js 读插件开关后调 setHtmlCardsEnabled）。 */
let htmlCardsOn = true;
const setHtmlCardsEnabled = (value) => {
  htmlCardsOn = Boolean(value);
};

const htmlCardHtml = (code) =>
  `<div class="html-card" data-srcdoc="${attr(code)}"></div>`;

/* ── 代码块：轻量高亮 + 复制按钮 ────────────────────────────
 * 无依赖无构建：一条合并正则把 注释/字符串/数字/关键字/属性名 五类挑出来上色，
 * 规则都允许未闭合——流式中的半截字符串也能上色。不追求 IDE 准确度，
 * 扫不出来就原样转义显示。规则源全部用非捕获组，别让分组序号错位。 */
const HL_MAX_CODE = 20000;

function hlBuild(rules) {
  const re = new RegExp(
    rules.map((rule) => `(${rule.re.source})`).join("|"),
    "gm",
  );
  return (code) => {
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (let match = re.exec(code); match; match = re.exec(code)) {
      if (match.index > last) out += esc(code.slice(last, match.index));
      let cls = "";
      for (let i = 1; i < match.length; i += 1) {
        if (match[i] !== undefined) {
          cls = rules[i - 1].cls;
          break;
        }
      }
      out += `<span class="tok-${cls}">${esc(match[0])}</span>`;
      last = match.index + match[0].length;
      if (match[0].length === 0) re.lastIndex += 1; // 防空匹配死循环
    }
    out += esc(code.slice(last));
    return out;
  };
}

const HL_NUMBER = { re: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/, cls: "n" };
const HL_LANGS = {
  clike: hlBuild([
    { re: /\/\/[^\n]*/, cls: "c" },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'(?:[^'\\\n]|\\.)*'?/, cls: "s" },
    { re: /`(?:[^`\\]|\\.)*`?/, cls: "s" },
    HL_NUMBER,
    {
      re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|try|catch|finally|throw|async|await|yield|import|export|from|delete|void|static|get|set|interface|type|enum|implements|readonly|public|private|protected|namespace|declare|abstract|keyof|infer|satisfies|null|undefined|true|false|never|unknown|any)\b/,
      cls: "k",
    },
  ]),
  python: hlBuild([
    { re: /#[^\n]*/, cls: "c" },
    { re: /"""[\s\S]*?(?:"""|$)/, cls: "s" },
    { re: /'''[\s\S]*?(?:'''|$)/, cls: "s" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'(?:[^'\\\n]|\\.)*'?/, cls: "s" },
    HL_NUMBER,
    {
      re: /\b(?:def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|lambda|yield|pass|raise|and|or|not|in|is|None|True|False|self|async|await|match|case|global|nonlocal|assert|del)\b/,
      cls: "k",
    },
  ]),
  bash: hlBuild([
    { re: /#[^\n]*/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'[^']*'?/, cls: "s" },
    { re: /(?:\$\{[^}]*\}|\$\w+)/, cls: "a" },
    HL_NUMBER,
    {
      re: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|echo|cd|source|set|unset|trap|shift|break|continue|in)\b/,
      cls: "k",
    },
  ]),
  json: hlBuild([
    { re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/, cls: "a" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    HL_NUMBER,
    { re: /\b(?:true|false|null)\b/, cls: "k" },
  ]),
  css: hlBuild([
    { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /@[\w-]+/, cls: "k" },
    { re: /[\w-]+(?=\s*:)/, cls: "a" },
    { re: /#[0-9a-fA-F]{3,8}\b/, cls: "n" },
    { re: /\b\d[\d.]*(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?/, cls: "n" },
  ]),
  html: hlBuild([
    { re: /<!--[\s\S]*?(?:-->|$)/, cls: "c" },
    { re: /<\/?[\w-]+|\/?>/, cls: "k" },
    { re: /[\w-]+(?==)/, cls: "a" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
  ]),
};

const HL_ALIAS = {
  js: "clike", javascript: "clike", jsx: "clike", mjs: "clike", cjs: "clike",
  ts: "clike", typescript: "clike", tsx: "clike",
  java: "clike", c: "clike", cpp: "clike", "c++": "clike", cs: "clike", csharp: "clike",
  go: "clike", rust: "clike", rs: "clike", kotlin: "clike", kt: "clike",
  swift: "clike", php: "clike", scala: "clike", dart: "clike",
  py: "python", python: "python",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
};

function codeBlockHtml(lang, code) {
  // 围栏信息串可能是 "ts title=x" 这类，取第一个词；未知语言原样转义
  const key = (lang || "").trim().toLowerCase().split(/[\s{]/)[0];
  const highlight = HL_LANGS[HL_ALIAS[key] || ""];
  let body;
  try {
    body = highlight && code.length <= HL_MAX_CODE ? highlight(code) : esc(code);
  } catch {
    body = esc(code);
  }
  // 语言标签（批 33，对齐 ZCode）：有名字才显示，匿名围栏不摆一个空标签
  const head = key
    ? `<div class="code-head"><span class="code-lang">${esc(key)}</span><button class="code-copy" type="button" title="复制代码">复制</button></div>`
    : `<button class="code-copy" type="button" title="复制代码">复制</button>`;
  return `<div class="codeblock">${head}<pre class="code"><code>${body}</code></pre></div>`;
}

/* ── 表格（批次二）：GFM 管道表格，只做基本形态 ──────────────
   判定很保守：某行像行、且**下一行是纯分隔行**（全为 -/: 组成）才算表，
   正文里带竖线的普通句子不会被误吞。单元格内容走 inline（支持加粗/行内码）。
   分隔行认单横线（2026-11-21）：GFM 的 `:-:` 也是合法分隔行，以前 `-{2,}`
   把它拒了，整张表塌成段落——真实模型输出里见过。 */
const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableDelim = (line) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
};

const isTableRow = (line) => line.includes("|") && splitTableRow(line).length >= 2;

/* 短格不折行（2026-11-21，C 卡片版配套）：`42m` 断成 `42 m` 的根因是窄列里
   overflow-wrap:anywhere 逐字符断。≤8 字符的格直接 nowrap；更长的只有
   「无空格且不含 CJK 的 token」（单号 / 路径 / URL，≤26 字符）也不折，
   长中文说明照旧折行。 */
const NW_MAX_SHORT = 8;
const NW_MAX_TOKEN = 26;
const NW_CJK = /[\u2e80-\u9fff\uf900-\ufaff]/;
const nwOf = (cell) => {
  const text = (cell ?? "").trim();
  if (!text || text.includes("\n")) return "";
  if (text.length <= NW_MAX_SHORT) return "nw";
  if (!NW_CJK.test(text) && !/\s/.test(text) && text.length <= NW_MAX_TOKEN) return "nw";
  return "";
};

/* 全数字列自动右对齐（2026-11-21）：条数 / 耗时 / 退出码这类列，模型没写
   `---:` 对齐时也认得出来。整列都命中数字形态才算，说明列不受影响；
   显式对齐优先（左对齐也算表态），自动档只补没表态的列。 */
const NUM_CELL =
  /^[—–-]$|^\s*[-+~≤≥]\s*\d[\d.,]*\s*(?:ms|s|m|h|min|秒|分|条|次|个|单|轮|人|行|列|%|px)?\s*$|^\d[\d.,]*\s*(?:ms|s|m|h|min|秒|分|条|次|个|单|轮|人|行|列|%|px)?\s*$/i;
const numAlignsOf = (rows, width) => {
  const aligns = [];
  for (let i = 0; i < width; i += 1) {
    let numeric = false;
    for (const row of rows) {
      const text = (row[i] ?? "").trim();
      if (!text) continue;
      if (!NUM_CELL.test(text)) {
        numeric = false;
        break;
      }
      numeric = true;
    }
    if (numeric) aligns.push(i);
  }
  return aligns;
};

/** explicit[i] = 分隔格带过冒号（模型对这列表过态）；不传 = 全按没表态算。 */
function tableHtml(header, aligns, rows, explicit = []) {
  const alignOf = (i) => aligns[i] || "left";
  const autoNums = new Set(numAlignsOf(rows, header.length));
  const head = header
    .map((cell, i) => {
      const align = alignOf(i);
      const style = align === "left" ? "" : ` style="text-align:${align}"`;
      return `<th${style}>${inline(cell ?? "")}</th>`;
    })
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${header
          .map((_, i) => {
            const align = alignOf(i);
            // 自动右对齐只补「没表态」的列：分隔格带冒号（:--- / ---: / :---:）都算表态，
            // 显式 :---（左对齐）不许被自动档盖掉（2026-11-21 修）
            const num = align === "left" && !explicit[i] && autoNums.has(i);
            const cls = [nwOf(row[i]), num ? "num" : ""].filter(Boolean).join(" ");
            const style = num
              ? ' style="text-align:right"'
              : align !== "left"
                ? ` style="text-align:${align}"`
                : "";
            return `<td${cls ? ` class="${cls}"` : ""}${style}>${inline(row[i] ?? "")}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(source) {
  const blocks = [];
  let text = source.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const trimmed = code.replace(/\n+$/, "");
    const key = (lang || "").trim().toLowerCase().split(/[\s{]/)[0];
    // 闭合的 html 围栏 → 交互卡占位符；没闭合（流式在写）先走普通代码块
    if (key === "html" && match.endsWith("```") && htmlCardsOn) {
      blocks.push(htmlCardHtml(trimmed));
    } else {
      blocks.push(codeBlockHtml(lang, trimmed));
    }
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const out = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  /**
   * 列表栈（批 33，学 ZCode 的嵌套观感）：每层记类型 / 缩进 / 是否有开着没关的 <li>。
   * 缩进比当前层深 ≥2 空格 = 开子列表（子列表住在上一个 <li> 里）；浅了就逐层收。
   * 刻意只认 2 空格一档的粗口径：模型输出的缩进本来就不严格，够读就行。
   */
  const listStack = [];
  const listCloseLevel = () => {
    const top = listStack.pop();
    if (top.liOpen) out.push("</li>");
    out.push(`</${top.type}>`);
  };
  const listFlush = () => {
    while (listStack.length) listCloseLevel();
  };
  const listOpenItem = (content) => {
    const top = listStack[listStack.length - 1];
    if (top.liOpen) out.push("</li>");
    top.liOpen = true;
    out.push(`<li>${listItemHtml(content)}`);
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, "");
    const placeholder = line.trim().match(/^\u0000(\d+)\u0000$/);
    if (placeholder) {
      flushParagraph();
      listFlush();
      out.push(blocks[Number(placeholder[1])]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      listFlush();
      continue;
    }

    let match;
    if ((match = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushParagraph();
      listFlush();
      const level = match[1].length;
      out.push(`<h${level}>${inline(match[2])}</h${level}>`);
      continue;
    }
    // 表格分支（批次二）：表头行 + 分隔行 + 连续数据行
    if (isTableRow(line) && index + 1 < lines.length && isTableDelim(lines[index + 1])) {
      flushParagraph();
      listFlush();
      const header = splitTableRow(line);
      // 对齐（2026-11-21 修）：`:---` 是 GFM 的左对齐，以前落在 /-+:$/ 里成了右对齐；
      // 顺序=先中心（两头冒号）、再右（尾冒号）、剩下全算左。带冒号 = 模型表过态。
      const specs = splitTableRow(lines[index + 1]).map((cell) => ({
        align: /^:-+:$/.test(cell) ? "center" : /:$/.test(cell) ? "right" : "left",
        explicit: cell.includes(":"),
      }));
      const aligns = specs.map((spec) => spec.align);
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1; // 外层 for 还会 +1，别跳过表后那行
      out.push(tableHtml(header, aligns, rows, specs.map((spec) => spec.explicit)));
      continue;
    }
    // 列表分支（批 33 重写）：缩进感知 + 任务清单（- [ ] / - [x]）
    if ((match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushParagraph();
      const indent = match[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(match[2]);
      const type = ordered ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (top && indent >= top.indent + 2) {
        // 开子列表：住在上一个 <li> 里（它还开着，不用关）
        out.push(`<${type}>`);
        listStack.push({ type, indent, liOpen: false });
        listOpenItem(match[3]);
      } else {
        while (listStack.length && indent < listStack[listStack.length - 1].indent) {
          listCloseLevel();
        }
        const same = listStack[listStack.length - 1];
        if (!same || same.type !== type) {
          listFlush();
          out.push(`<${type}>`);
          listStack.push({ type, indent, liOpen: false });
        }
        listOpenItem(match[3]);
      }
      continue;
    }
    // 引用块（批 33 重写）：连续 > 行合成一个 <blockquote>，行间 <br>；
    // 多层 > 只剥一层、内容原样渲染（嵌套引用是罕见输入，不追求完美）。
    if (/^>\s?/.test(line)) {
      flushParagraph();
      listFlush();
      const quoted = [line.replace(/^>\s?/, "")];
      while (index + 1 < lines.length && /^>\s?/.test(lines[index + 1])) {
        index += 1;
        quoted.push(lines[index].replace(/^>\s?/, ""));
      }
      out.push(`<blockquote>${quoted.map((one) => inline(one)).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      listFlush();
      out.push("<hr />");
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  listFlush();
  return out.join("");
}

/**
 * 列表项内容（批 33）：任务清单项 `- [ ]` / `- [x]` 渲染成只读勾选框
 * （模型写给人看的清单，勾不勾由人记在心里，不是可交互控件——点了也不该假装有状态）。
 * 其余照旧走 inline。
 */
function listItemHtml(content) {
  const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
  if (task) {
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return `<span class="md-task"><input type="checkbox" disabled${checked} aria-hidden="true">${inline(task[2])}</span>`;
  }
  return inline(content);
}

export { DELEGATE_HINTS, ESCAPES, HL_ALIAS, HL_LANGS, HL_MAX_CODE, HL_NUMBER, attr, codeBlockHtml, delegateHintText, esc, hlBuild, htmlCardHtml, inline, isTableDelim, isTableRow, listItemHtml, renderMarkdown, setHtmlCardsEnabled, splitTableRow, syncDelegateHint, tableHtml };
