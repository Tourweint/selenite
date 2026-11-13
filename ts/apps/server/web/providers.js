/**
 * 供应商管理（列表 / 模板 / 表单骨架）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { fillProviderForm, providerFormMarkup } from "./provider-form.js";
import { openProviderForm, wireProviderForm } from "./provider-save.js";
import { state } from "./state.js";


/* ── 供应商管理（2026-11-04 批次五；2026-11-05 G1 双栏重排，H1 密钥直填）────────
 * 密钥以界面直填为主：表单只收 API Key，keyEnv 由前端按 LIFEDIARY_KEY_<ID大写> 生成；
 * 直填接口不在的环境退回「只填变量名、值写 .env」的老形态，两种都只出现变量名，不存明文。 */

/* 预置模板（G1）：只给 baseUrl / 常见模型 id，不含任何密钥值。
   keyEnv 不再写进模板：H1 起由前端按 LIFEDIARY_KEY_<ID大写> 自动生成，界面不出现。 */
/* 模型元数据默认值（与服务端 provider.ts 保持一致；只用于显示"没填时的生效值"） */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 4096;

/** 128K / 1M 这类短写；不精确到个位，免得表单里一长串数字 */
function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1000000) return `${Number((number / 1000000).toFixed(2))}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}K`;
  return String(number);
}

/* 套餐自带的模型清单（2026-11-13 核）：取自 magpie 的 bundled catalog
 * （`internal/catalog/bundled/api.json.gz`，magpie 自己用来认模型名 / 价格的那份）与 `provider/presets.go`。
 * 只留对话模型——图像 / 视频 / TTS / ASR 不进本仓库的模型菜单。
 * 为什么套餐写死、按量不写：套餐端点大多没有可用的 /models（火山 Agent 是 404，
 * Coding 的 /models 回的是全量目录而不是套餐清单），写死才「粘 Key 就能选模型」；
 * 按量计费的端点照旧保存后自动拉（见 saveProviderFlow ③），不写死。 */
const PLAN_MODELS = {
  bailianToken: [
    "qwen3.8-max", "qwen3.8-max-preview", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
    "qwen3.6-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
    "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "deepseek-v4-pro", "deepseek-v4-pro-0813",
    "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v3.2", "MiniMax-M2.5",
  ],
  bailianCoding: [
    "qwen3-coder-next", "qwen3-coder-plus", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
    "qwen3-max-2026-01-23", "glm-5", "glm-4.7", "kimi-k2.5", "MiniMax-M2.5",
  ],
  kimiCode: [
    "k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
  ],
  glmCoding: ["glm-5.3", "glm-5.3-highspeed", "glm-5.3-flash", "glm-4.6v"],
  arkCoding: [
    "doubao-seed-2.1-turbo", "doubao-seed-2.0-lite", "doubao-seed-evolving", "glm-5.3", "glm-5.3-flash",
    "kimi-k2.7-code", "kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3",
  ],
  arkAgent: [
    "doubao-seed-2.1-pro", "doubao-seed-2.1-lite", "doubao-seed-2.0-mini", "doubao-seed-evolving",
    "glm-5.3-flash", "kimi-k3.1-pro", "kimi-k3", "kimi-k2.8-preview", "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-economy", "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3",
  ],
  tencentPlan: [
    "tc-code-latest", "auto", "hy4-preview", "hy3", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5",
    "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "deepseek-v4.1-flash",
    "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "minimax-m3", "minimax-m2.7",
    "mimo-v2.6-pro", "mimo-v2.6-flash",
  ],
  qianfanPlan: [
    "qianfan-code-latest", "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-pro-0813",
    "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v3.2", "glm-5.3", "glm-5.3-flash",
    "glm-5.2", "glm-5.1", "glm-5",
  ],
  stepPlan: ["step-5-preview", "step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603", "step-router-v1"],
};

/* 模板图标（2026-11-13 抄 magpie）：品牌商标归各家，SVG 取自
 * `<本地项目区>
eference\magpie/internal/gui/assets/icons/*.svg`（lobe-icons 那套）。
 * 单色图标改 currentColor 跟主题走；彩色保留原色。缺图标就退回卡片上的文字标记。 */
const PROVIDER_ICONS = {
  bailian: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>BaiLian</title><path d="M6.336 8.919v6.162l5.335-3.083L6.337 8.92z" fill="#1C54E3"></path><path d="M21.394 5.288s-.006-.006-.01-.006L17.01 2.754 6.336 8.92l5.335 3.082 9.701-5.6.016-.01a.635.635 0 00.006-1.1v-.003z" fill="#AA9AFF"></path><path d="M21.71 12.465a.62.62 0 00-.316.085s-.006 0-.009.003l-4.375 2.528 5.05 2.915h.006a2.06 2.06 0 00.28-1.04v-3.855a.637.637 0 00-.636-.636z" fill="#00EAD1"></path><path d="M22.06 17.996l-5.05-2.915L6.34 21.242l4.27 2.465s.016.006.022.012a2.102 2.102 0 002.093 0c.006-.003.016-.006.022-.012l8.538-4.93c.003 0 .006-.003.01-.006.321-.183.589-.45.775-.772h-.006l-.004-.003z" fill="#00CEC9"></path><path d="M11.672 11.998l-5.336 3.083-1.444.832-3.605 2.083H1.28c.173.303.416.555.709.738l.078.044.016.01.02.012 4.232 2.442 10.671-6.161-5.335-3.082z" fill="#00EAD1"></path><path d="M12.74.29c-.1-.06-.208-.107-.315-.148-.02-.006-.038-.016-.057-.022a2.121 2.121 0 00-.7-.12c-.233 0-.457.038-.668.11l-.031.01a2.196 2.196 0 00-.372.17L2.068 5.222s-.003 0-.006.003c-.324.183-.592.451-.781.773h.006l5.049 2.918L17.01 2.758 12.74.29z" fill="#7347FF"></path><path d="M1.287 6.001H1.28A2.06 2.06 0 001 7.041v9.915c0 .378.1.735.28 1.043h.007l5.049-2.918V8.919l-5.05-2.918z" fill="#0423DA"></path></svg>`,
  deepseek: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>DeepSeek</title><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"></path></svg>`,
  kimi: `<svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Kimi</title><path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"></path><path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"></path></svg>`,
  zhipu: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Zhipu</title><path d="M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z" fill="#3859FF" fill-rule="nonzero"></path></svg>`,
  volcengine: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Volcengine</title><path d="M19.44 10.153l-2.936 11.586a.215.215 0 00.214.261h5.87a.215.215 0 00.214-.261l-2.95-11.586a.214.214 0 00-.412 0zM3.28 12.778l-2.275 8.96A.214.214 0 001.22 22h4.532a.212.212 0 00.214-.165.214.214 0 000-.097l-2.276-8.96a.214.214 0 00-.41 0z" fill="#00E5E5"></path><path d="M7.29 5.359L3.148 21.738a.215.215 0 00.203.261h8.29a.214.214 0 00.215-.261L7.7 5.358a.214.214 0 00-.41 0z" fill="#006EFF"></path><path d="M14.44.15a.214.214 0 00-.41 0L8.366 21.739a.214.214 0 00.214.261H19.9a.216.216 0 00.171-.078.214.214 0 00.044-.183L14.439.15z" fill="#006EFF"></path><path d="M10.278 7.741L6.685 21.736a.214.214 0 00.214.264h7.17a.215.215 0 00.214-.264L10.688 7.741a.214.214 0 00-.41 0z" fill="#00E5E5"></path></svg>`,
  tencent: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>TencentCloud</title><path d="M20.0483 17.1416C19.6945 17.4914 18.987 18.0161 17.7488 18.0161C17.2182 18.0161 16.5991 18.0161 16.3338 18.0161C15.98 18.0161 13.3268 18.0161 10.143 18.0161C12.4424 15.8298 14.3881 13.9932 14.565 13.8183C14.7419 13.6434 15.1841 13.2061 15.6263 12.8563C16.5107 12.0692 17.2182 11.9817 17.8373 11.9817C18.7217 11.9817 19.4292 12.3316 20.0483 12.8563C21.2864 13.9932 21.2864 16.0047 20.0483 17.1416ZM21.5518 11.457C20.6674 10.495 19.3408 9.88281 17.9257 9.88281C16.6875 9.88281 15.6263 10.3201 14.6534 11.0197C14.2997 11.3695 13.769 11.7194 13.3268 12.2441C12.9731 12.5939 5.36719 19.9401 5.36719 19.9401C5.80939 20.0276 6.34003 20.0276 6.78223 20.0276C7.22443 20.0276 16.0685 20.0276 16.4222 20.0276C17.1298 20.0276 17.6604 20.0276 18.191 19.9401C19.3408 19.8527 20.4905 19.4154 21.4633 18.5409C23.4975 16.6168 23.4975 13.381 21.5518 11.457Z" fill="#00A3FF"></path><path d="M9.1701 10.9323C8.19726 10.2326 7.22442 9.88281 6.07469 9.88281C4.65965 9.88281 3.33304 10.495 2.44864 11.457C0.502952 13.4685 0.502952 16.6168 2.53708 18.6283C3.42148 19.4154 4.30589 19.8527 5.36717 19.9401L7.4013 18.0161C7.04754 18.0161 6.60533 18.0161 6.25157 18.0161C5.10185 17.9287 4.39433 17.5789 3.95212 17.1416C2.71396 15.9172 2.71396 13.9932 3.86368 12.7688C4.48277 12.1566 5.19029 11.8943 6.07469 11.8943C6.60533 11.8943 7.4013 11.9817 8.19726 12.7688C8.55102 13.1186 9.52386 13.8183 9.87763 14.1681H9.96607L11.2927 12.8563V12.7688C10.6736 12.1566 9.70075 11.3695 9.1701 10.9323Z" fill="#00C8DC"></path><path d="M18.4564 8.74536C17.4836 6.12171 14.9188 4.28516 12.0003 4.28516C8.5511 4.28516 5.80945 6.82135 5.27881 9.96973C5.54413 9.96973 5.80945 9.88228 6.16321 9.88228C6.51697 9.88228 6.95917 9.96973 7.31294 9.96973C7.75514 7.78336 9.70082 6.20917 12.0003 6.20917C13.946 6.20917 15.6263 7.34608 16.4223 9.00773C16.4223 9.00773 16.5107 9.09518 16.5107 9.00773C17.1298 8.92027 17.8373 8.74536 18.4564 8.74536C18.4564 8.83282 18.4564 8.83282 18.4564 8.74536Z" fill="#006EFF"></path></svg>`,
  qianfan: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>BaiduCloud</title><path d="M21.715 5.61l-3.983 2.31a.903.903 0 01-.896 0L12.44 5.384a.903.903 0 00-.897 0L7.156 7.92a.903.903 0 01-.896 0L2.276 5.617 12.002 0l9.713 5.61z" fill="#5BCA87"></path><path d="M18.641 9.467a.89.89 0 00-.438.77v5.072a.896.896 0 01-.445.77l-4.428 2.51a.884.884 0 00-.445.777v4.607l4.429-2.536 5.31-3.047V7.157l-3.983 2.31z" fill="#EC5D3E"></path><path d="M10.98 18.941a.936.936 0 00-.305-.352l-4.429-2.516a.903.903 0 01-.431-.764v-5.078a.89.89 0 00-.452-.757l-.451-.26L1.38 7.158V18.39l5.311 3.047L11.126 24v-4.608a.881.881 0 00-.146-.45z" fill="#2464F5"></path></svg>`,
  stepfun: `<svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>StepFun</title><path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM8.762 19.614H4.376v-4.386h4.386v4.386zm5.423 0H9.798v-4.386h4.387v4.386zm0-5.42H9.798V9.81h4.387v4.386zm0-5.418H9.798V4.39h4.387v4.386zm5.422-.004h-4.386V4.386h4.386v4.386z"></path></svg>`,
  minimax: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Minimax</title><defs><linearGradient id="lobe-icons-minimax-_R_0_" x1="0%" x2="100.182%" y1="50.057%" y2="50.057%"><stop offset="0%" stop-color="#E2167E"></stop><stop offset="100%" stop-color="#FE603C"></stop></linearGradient></defs><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z" fill="url(#lobe-icons-minimax-_R_0_)" fill-rule="nonzero"></path></svg>`,
  openai: `<svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>OpenAI</title><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"></path></svg>`,
  gemini: `<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Gemini</title><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-0-_R_0_)"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-1-_R_0_)"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-2-_R_0_)"></path><defs><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-0-_R_0_" x1="7" x2="11" y1="15.5" y2="12"><stop stop-color="#08B962"></stop><stop offset="1" stop-color="#08B962" stop-opacity="0"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-1-_R_0_" x1="8" x2="11.5" y1="5.5" y2="11"><stop stop-color="#F94543"></stop><stop offset="1" stop-color="#F94543" stop-opacity="0"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-2-_R_0_" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stop-color="#FABC12"></stop><stop offset=".46" stop-color="#FABC12" stop-opacity="0"></stop></linearGradient></defs></svg>`,
  xai: `<svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Grok</title><path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"></path></svg>`,
  magpie: `<svg fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><path fill-rule="evenodd" d="M1.5 5.5C1.3 5.7 1.2 6.5 1.2 6.9C1.2 6.9 1.2 7 1.2 7.1C1.1 7.4 1.3 8 1.4 8.3C1.4 8.4 1.5 8.5 1.5 8.7C1.5 8.9 1.7 9 1.8 9.3C2.2 9.9 2.2 10 2.3 10.1C2.4 10.2 2.5 10.3 2.6 10.5C2.8 10.8 3 11.1 3.2 11.3C3.3 11.3 3.4 11.6 3.6 11.8C3.8 12 4.1 12.4 4.2 12.5C4.7 13 5.2 13.7 5.4 13.9C6 14.5 6.5 15.1 6.7 15.3C6.7 15.4 6.9 15.5 6.9 15.7C7.3 15.9 7.7 16.5 7.9 16.8C7.9 16.8 8 16.9 8 16.9C8.1 16.9 8.2 17.2 8.2 17.3C8.2 17.3 8.1 17.2 8.1 17.1C7.9 16.9 7.9 16.9 7.6 16.6C7.5 16.5 7.4 16.5 7.4 16.3C7.2 16.2 6.7 15.7 6.3 15.2C6.1 15.1 6 14.9 6 14.9C5.9 14.8 5.7 14.7 5.7 14.6C5.6 14.5 5.4 14.3 5.3 14.2C5.1 14.1 4.9 13.8 4.7 13.5C4.5 13.3 4.2 13.1 4.1 12.9C4.1 12.9 3.8 12.7 3.8 12.5C3.5 12.3 3 11.8 2.8 11.4C1.8 10.5 0.9 9.6 0.7 9.6C0.6 9.7 0.6 9.8 0.5 10C0.5 10.1 0.6 10.2 0.5 10.3C0.5 10.4 0.6 10.5 0.6 10.6C0.5 10.7 0.5 10.9 0.6 11C0.5 11.1 0.6 11.4 0.6 11.5C0.9 12.9 1.3 13.8 2.8 14.9C2.9 15.1 3.3 15.3 3.4 15.4C3.4 15.5 3.6 15.6 3.7 15.7C4.2 16 6.4 17.8 7 18.4C7.4 18.8 7.4 18.8 7.5 18.9C7.6 19 7.7 19 7.7 19.1C7.7 19.2 7.8 19.2 7.9 19.2C7.9 19.3 8.1 19.4 8.1 19.5C8.2 19.6 8.2 19.7 8.3 19.7C8.3 19.7 8.3 19.7 8.2 19.7C8.2 19.6 8.1 19.6 8 19.6C7.9 19.5 7.9 19.4 7.8 19.4C7.7 19.3 7.6 19.2 7.6 19.2C7.6 19.1 7.5 19 7.3 18.9C7.2 18.9 6.9 18.6 6.7 18.4C6.1 17.8 4.5 16.6 3.5 16C3.4 15.8 3 15.6 2.9 15.5C2.6 15.3 1.5 14.6 0.9 14.3C0.7 14.1 0.6 14.1 0.6 14.2C0.5 14.5 0.8 15.9 0.9 16.1C0.9 16.2 1 16.2 0.9 16.3C1.2 16.8 1.9 17.6 2.7 18.3C2.8 18.5 4 19.2 4.7 19.5C6.2 20.5 6.6 20.7 7.4 21.5C8.2 22.2 8.7 22.7 9.3 23.6C9.5 24.1 9.9 24.4 10.3 25.3C10.4 25.5 10.5 25.8 10.5 25.8C10.7 25.8 10.8 25.7 11 25.4C11.6 25 11.9 24.6 12.3 24.3C12.8 24 13 23.8 13 23.7C13.1 23.7 13.1 23.8 13 24C12 24.8 11 26 10.2 26.9C10.1 27.1 9.9 27.5 9.7 27.7C9.5 27.8 9.4 28 9.4 28C9.4 28 9.3 28.3 9.1 28.5C8.6 29.2 7.7 30.8 7.7 30.9C7.7 31 7.8 31 8.3 30.8C9 30.4 9.5 30.2 10.4 30C11.7 29.6 12.5 29.6 11.6 30C10.5 30.2 9.7 30.6 9.2 31.2C8.8 31.7 8.8 31.7 9.3 31.7C10.1 31.8 10.9 31.9 11.6 32.2C12.8 32.7 13.5 33.1 15.5 34.8C16.4 35.5 17.3 36.2 17.8 36.4C17.9 36.5 18.1 36.7 18.2 36.8C19.1 37.3 21.2 38.1 22.3 38.3C22.4 38.3 22.7 38.3 22.8 38.3C22.8 38.5 23 38.5 23 38.5C23.1 38.5 23.2 38.5 23.3 38.5C23.6 38.6 25.9 38.6 26.1 38.5C26.2 38.5 26.3 38.5 26.4 38.5C26.5 38.5 26.6 38.5 26.7 38.3C26.7 38.3 27 38.3 27.1 38.3C28.3 38.1 30.2 37.3 31.4 36.7C31.5 36.7 31.7 36.4 31.8 36.4C32.2 36.2 33.2 35.4 33.4 35.2C34.2 34.5 35.5 33 35.8 32.6C35.8 32.5 36 32.2 36.1 32C36.4 31.8 36.6 31.4 36.6 31.2C36.7 31.1 36.8 30.9 36.9 30.8C37.2 30.4 37.5 29.6 37.7 29.2C37.7 29.1 37.8 28.7 37.9 28.7C38.1 28.5 38.4 27.1 38.5 26.8C39 25.2 39.1 23.7 39 22.4C39 22.2 38.9 21.9 38.9 21.8C38.9 21.7 38.9 21.6 38.9 21.4C38.6 20.5 38.5 19.9 38.2 19C37.9 18.5 37.5 17.5 37.3 17.2C37 16.8 36.8 15.8 36.8 15.2C36.8 13.8 37.7 12.7 39.6 12.2C40.1 12.1 41.3 11.8 42.1 11.7C43.5 11.5 43.5 11.5 43.4 11.3C42.9 10.7 40.9 9.9 39.2 9.7C37.9 9.5 38.1 9.5 37.6 9C37 8.6 36.4 8 36 7.9C36 7.8 35.8 7.8 35.7 7.7C35.1 7.3 34.2 7 33.1 6.9C32.6 6.7 31.6 6.9 31 7C29.6 7.3 28.3 8 27.3 9.2C26.7 9.8 26.2 10.8 25.7 11.7C25.5 12.1 24.8 13.4 24.7 13.7C24.6 13.9 24.5 14.1 24.1 14.7C23.5 15.7 22.1 16.9 20.6 17.8C20.5 18 20.3 18.2 20.1 18.3C19.7 18.5 19.4 18.8 19.1 19C18.9 19.1 18.7 19.3 18.5 19.4C18 19.8 17.2 20.3 17 20.5C16.9 20.5 16.8 20.6 16.7 20.7C16.3 20.8 16.1 20.9 16 20.9C15.5 20.8 14.9 20.5 14.2 20.2C13.7 19.8 12.7 18.9 12.4 18.6C12.3 18.5 12.2 18.4 12.1 18.2C11.9 18 11.2 17.1 11 16.6C10.9 16.5 10.8 16.4 10.7 16.3C10.7 16.2 10.6 16.1 10.6 15.9C10.5 15.9 10.4 15.7 10.4 15.6C10.3 15.5 10.2 15.2 10.1 15C10 14.8 9.8 14.4 9.7 14.2C9.6 14 9.5 13.7 9.4 13.6C9.4 13.4 9.3 13.2 9.2 13C9.2 12.8 9 12.6 9 12.5C8.9 12.3 8.7 12.1 8.7 12C8.7 12 8.5 11.7 8.5 11.7C8.3 11.2 8.2 10.9 7.5 10C6.4 8.3 4.2 6.4 2.7 5.8C2 5.5 1.6 5.4 1.5 5.5ZM28.4 16.7C29.2 16.9 29.7 17.2 29.9 17.7C30.1 18.2 30 18.9 29.6 19.4C29.2 19.9 28.2 20.9 27.6 21.2C26.8 21.7 25.3 22.4 24.2 22.7C23.9 22.8 23.6 22.9 23.5 22.9C22.8 23.2 20.7 23.7 19.6 24C19 24.2 18.4 24.3 18.1 24.4C17.9 24.4 16.1 24.9 15.3 25.1C14.6 25.2 14.7 25.1 15.7 23.6C16.4 22.7 18.5 20.6 19.4 19.9C20.8 18.8 21.4 18.4 23.2 17.6C23.8 17.4 25.6 16.8 25.9 16.8C25.9 16.8 26.3 16.8 26.6 16.7C26.8 16.7 28.2 16.7 28.4 16.7ZM30.4 20.2C30.5 20.3 30.6 20.6 30.6 20.7C31.7 23.1 33.4 24.6 35.6 25.3C36.1 25.5 36.7 25.7 37.2 25.8C37.7 25.8 37.8 25.9 37.8 26.1C37.7 26.2 37.7 26.3 37.7 26.5C37.7 26.6 37.7 26.8 37.6 27C37.4 28.5 36.8 29.9 36.1 31C36.1 31.2 35.9 31.4 35.9 31.6C35.7 31.9 35.2 32.6 34.7 33.3C32.6 35.6 29.7 37.3 26.6 37.8C26.5 37.8 26.3 37.9 26.2 37.9C25.8 37.9 23.7 37.9 23.3 37.9C23.2 37.9 23 37.8 22.9 37.8C21.1 37.6 19.3 36.8 18 35.7C17.7 35.4 17 34.7 16.8 34.5C16.3 33.8 16.1 33 16.3 32.5C16.5 31.8 16.8 31.6 17.9 31.1C19.1 30.5 19.4 30.4 20.2 30C21.4 29.4 23.2 28.4 23.9 27.9C23.9 27.8 24.2 27.7 24.5 27.6C26.3 26.3 28 24.6 28.9 22.9C29.5 22.2 29.7 21.6 29.9 20.7C30.1 20 30.2 19.9 30.4 20.2Z"/></svg>`,
};

/* 供应商模板（2026-11-13）：常用厂商的地址与申请 Key 的入口都预先给好，用户只需要粘一个 Key。
 * 每家可以有多个 `plans`（按量 / Token Plan / Coding Plan…）——同一家不同套餐是**不同端点、
 * 不同 Key**，选错就 401，所以放进模板里让人一眼选对，而不是让人自己记地址。
 * 不收的：协议不通（Anthropic 原生 Messages、MiniMax Token Plan 是 Anthropic 端点）、
 * 要云账号签名（Bedrock / Vertex）、地址随账号变（Azure）、模型清单几百条会撑爆菜单（聚合站）。
 * 地址与套餐取自 magpie 的 `provider/presets.go` 与 bundled catalog（2026-11-13 核）。
 * 按量一律不写死模型：保存后按 `/models` 拉（见 saveProviderFlow ③）。 */
const PROVIDER_TEMPLATES = [
  {
    id: "bailian",
    name: "百炼",
    desc: "按量 / Token / Coding",
    mark: "百",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    plans: [
      {
        id: "api",
        name: "按量计费",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      {
        id: "token",
        name: "Token Plan",
        baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        models: PLAN_MODELS.bailianToken,
      },
      {
        id: "coding",
        name: "Coding Plan",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        models: PLAN_MODELS.bailianCoding,
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    desc: "官方 API · 国内直连",
    mark: "DS",
    keyUrl: "https://platform.deepseek.com/api_keys",
    plans: [{ id: "api", name: "按量计费", baseUrl: "https://api.deepseek.com/v1" }],
  },
  {
    id: "kimi",
    name: "Kimi",
    desc: "按量 / Kimi Code 会员",
    mark: "K",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://api.moonshot.cn/v1" },
      {
        id: "code",
        name: "Kimi Code",
        baseUrl: "https://api.kimi.com/coding/v1",
        models: PLAN_MODELS.kimiCode,
        keyUrl: "https://www.kimi.com/code/console",
      },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    desc: "按量 / Coding Plan",
    mark: "智",
    keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      {
        id: "coding",
        name: "Coding Plan",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        models: PLAN_MODELS.glmCoding,
      },
    ],
  },
  {
    id: "volcengine",
    name: "火山方舟",
    desc: "按量 / Coding / Agent",
    mark: "火",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
      {
        id: "coding",
        name: "Coding Plan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        models: PLAN_MODELS.arkCoding,
      },
      {
        id: "agent",
        name: "Agent Plan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
        models: PLAN_MODELS.arkAgent,
      },
    ],
  },
  {
    id: "tencent",
    name: "腾讯 TokenHub",
    desc: "按量 / Token Plan",
    mark: "腾",
    keyUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://tokenhub.tencentmaas.com/v1" },
      {
        id: "plan",
        name: "Token Plan",
        baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
        models: PLAN_MODELS.tencentPlan,
        keyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan",
      },
    ],
  },
  {
    id: "qianfan",
    name: "百度千帆",
    desc: "按量 / Token Plan",
    mark: "千",
    keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://qianfan.baidubce.com/v2" },
      {
        id: "plan",
        name: "Token Plan",
        baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal",
        models: PLAN_MODELS.qianfanPlan,
        keyUrl: "https://console.bce.baidu.com/qianfan/resource/token-plan",
      },
    ],
  },
  {
    id: "stepfun",
    name: "阶跃 StepFun",
    desc: "按量 / Step Plan",
    mark: "阶",
    keyUrl: "https://platform.stepfun.com/interface-key",
    plans: [
      { id: "api", name: "按量计费", baseUrl: "https://api.stepfun.com/v1" },
      {
        id: "plan",
        name: "Step Plan",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        models: PLAN_MODELS.stepPlan,
      },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    desc: "国内站 · api.minimaxi.com",
    mark: "MM",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    plans: [{ id: "api", name: "按量计费", baseUrl: "https://api.minimaxi.com/v1" }],
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "官方 API",
    mark: "OA",
    keyUrl: "https://platform.openai.com/api-keys",
    plans: [{ id: "api", name: "按量计费", baseUrl: "https://api.openai.com/v1" }],
  },
  {
    id: "gemini",
    name: "Gemini",
    desc: "Google 的 OpenAI 兼容端点",
    mark: "G",
    keyUrl: "https://aistudio.google.com/apikey",
    plans: [
      {
        id: "api",
        name: "按量计费",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
    ],
  },
  {
    id: "xai",
    name: "xAI Grok",
    desc: "官方 API",
    mark: "X",
    keyUrl: "https://console.x.ai",
    plans: [{ id: "api", name: "按量计费", baseUrl: "https://api.x.ai/v1" }],
  },
  {
    id: "magpie",
    name: "magpie 本地网关",
    desc: "本机 127.0.0.1:3425",
    mark: "M",
    plans: [{ id: "local", name: "", baseUrl: "http://127.0.0.1:3425/v1", models: ["glm-5.3-flash"] }],
  },
  {
    id: "custom",
    name: "自定义供应商",
    desc: "自己填地址与模型清单",
    mark: "+",
    plans: [{ id: "custom", name: "", baseUrl: "", models: [] }],
  },
];

/** 模板的套餐列表：老写法（顶层 baseUrl / models）也认，避免半改状态炸掉表单 */
function templatePlans(template) {
  if (!template) return [];
  if (Array.isArray(template.plans) && template.plans.length) return template.plans;
  return [{ id: "default", name: "", baseUrl: template.baseUrl || "", models: template.models || [] }];
}

/** 按 id 取套餐；id 不认识 / 没选就取第一档（按量） */
function templatePlan(template, planId) {
  const plans = templatePlans(template);
  return plans.find((plan) => plan.id === planId) || plans[0] || { baseUrl: "", models: [] };
}

/** 模板 + 套餐的展示名：「智谱 GLM · Coding Plan」；没有套餐名就只写模板名 */
function templateLabel(template, plan) {
  return plan && plan.name ? `${template.name} · ${plan.name}` : template.name;
}

/** 反查：既有供应商的地址属于哪个模板的哪一档（编辑时的「获取 Key」入口用） */
function templatePlanByBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  for (const template of PROVIDER_TEMPLATES) {
    for (const plan of templatePlans(template)) {
      if (plan.baseUrl && plan.baseUrl === baseUrl) return { template, plan };
    }
  }
  return null;
}

const PROVIDER_ERROR_TEXT = {
  providers_disabled: "供应商配置被环境变量关掉了（PROVIDERS_CONFIG=false）。",
  provider_id_locked: "供应商 id 不能改；要换 id 请新建一个。",
  selected_model_missing: "这家供应商上还选着模型：先把「默认模型」切到别处，再改模型清单。",
  provider_is_default: "这是默认供应商，不能删；先把默认模型切到别家。",
  provider_in_use: "当前正用着这家供应商，先切到别家再删。",
  bad_key_env: "环境变量名只能是大写字母、数字、下划线，且不以数字开头（如 DASHSCOPE_API_KEY）。",
  bad_base_url: "Base URL 要写完整地址（http:// 或 https://），不带 /chat/completions。",
  bad_provider_name: "名称需要 1–80 个字符。",
  bad_models: "模型清单不能为空：点「添加模型」填一个模型 id 再保存。",
  bad_model_meta: "模型的上下文 / 最大输出只能是正整数。",
  bad_thinking_levels: "思考档格式不对，刷新页面再试。",
  bad_provider_id: "id 只能是小写字母、数字、连字符。",
  secret_field_forbidden: "界面不收密钥值：只填环境变量名，值放 .env。",
  models_fetch_failed: "拉不到清单：检查 Key 和地址，或手填。",
  missing_key: "这个环境变量还没有值：界面填 Key 后保存，或把值写进 .env。",
  unknown_provider: "找不到这家供应商，刷新后再试。",
};

const PROVIDER_SECRET_ERROR_TEXT = {
  secrets_disabled: "密钥直填功能已关闭（PROVIDER_SECRETS=false）。",
  providers_disabled: "供应商配置被环境变量关掉了（PROVIDERS_CONFIG=false）。",
  bad_request: "Key 不能为空，且最长 512 个字符。",
};

function providerErrorText(data, status) {
  return PROVIDER_ERROR_TEXT[data?.error] || data?.message || `没成功：HTTP ${status}`;
}

/** 密钥接口的错：404 一律说「先保存基本信息」（契约里 404 = unknown_provider） */
function providerSecretErrorText(data, status) {
  if (data?.error === "secrets_disabled") return PROVIDER_SECRET_ERROR_TEXT.secrets_disabled;
  if (status === 404 || data?.error === "unknown_provider") return "先保存基本信息，再存密钥。";
  return (
    PROVIDER_SECRET_ERROR_TEXT[data?.error] ||
    data?.message ||
    (status ? `密钥没存上：HTTP ${status}` : "密钥没存上：网络错误")
  );
}

function providerById(id) {
  return (state.providers || []).find((provider) => provider.id === id) || null;
}

async function loadProviders() {
  const nav = document.getElementById("provider-list");
  const detail = document.getElementById("provider-detail");
  if (!nav || !detail) return;
  // 右栏已经有表单时只压一点不透明度，等数据回来原位填值——不整块重建，页面不闪
  if (detail.querySelector(".svc-form")) detail.classList.add("is-loading");
  try {
    const response = await request("/api/v1/agent/providers", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.providers = data.providers || [];
    ensureProviderView();
    renderProviderNav();
    renderProviderDetail({ animate: false });
  } catch {
    nav.innerHTML = `<div class="svc-nav-empty">读不到</div>`;
    detail.dataset.view = "empty";
    detail.innerHTML = `<div class="svc-detail-empty"><div class="set-hint is-error">读不到供应商列表</div></div>`;
  } finally {
    detail.classList.remove("is-loading");
  }
}

/** 默认落点：当前默认供应商 > 第一家；模板/新建态保持不动 */
function ensureProviderView() {
  const list = state.providers || [];
  const view = state.providerView || { mode: "empty" };
  if (view.mode === "templates" || view.mode === "new") return;
  if (view.mode === "form" && list.some((provider) => provider.id === view.providerId)) return;
  if (!list.length) {
    state.providerView = { mode: "empty", providerId: "", templateId: "" };
    return;
  }
  const preferred = list.find((provider) => provider.isDefault) || list[0];
  state.providerView = { mode: "form", providerId: preferred.id, templateId: "" };
}

/** 左栏头像：先按 id 认模板；同一模板建的第二家（id 变成 magpie-2）再按地址 / 名字回认，
 *  否则它只剩一个首字母，和列表里那家同名同源的认不出是一家的。 */
function providerBrandIcon(provider) {
  const direct = PROVIDER_ICONS[provider.id];
  if (direct) return direct;
  const matched = templatePlanByBaseUrl(provider.baseUrl);
  if (matched && PROVIDER_ICONS[matched.template.id]) return PROVIDER_ICONS[matched.template.id];
  const baseName = String(provider.name || "").replace(/\s+\d+$/, "").trim();
  const byName = PROVIDER_TEMPLATES.find((template) => template.name === baseName);
  return (byName && PROVIDER_ICONS[byName.id]) || "";
}

function renderProviderNav() {
  const nav = document.getElementById("provider-list");
  if (!nav) return;
  const list = state.providers || [];
  const view = state.providerView || {};
  const rows = list
    .map((provider) => {
      const selected = view.mode === "form" && view.providerId === provider.id;
      const initial = (provider.name || provider.id || "?").trim().slice(0, 1);
      // 模板出来的供应商用品牌图标（id 就是模板 id）；自己建的仍用首字
      const icon = providerBrandIcon(provider);
      const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
      return `<button class="svc-row" type="button" data-provider="${esc(provider.id)}"
        aria-selected="${selected}" title="${attr(
          (provider.name || provider.id) + (provider.hasKey ? "" : " · 缺环境变量"),
        )}">
        <span class="svc-row-initial" aria-hidden="true">${icon || esc(initial)}</span>
        <span class="svc-row-label">${esc(provider.name || provider.id)}</span>
        <span class="svc-row-count" aria-hidden="true">${modelCount || ""}</span>
        <i class="status-dot ${provider.hasKey ? "ok" : "warn"}" aria-hidden="true"></i>
      </button>`;
    })
    .join("");
  // 分节标题已经写着「供应商」，列头不再重复一遍（2026-11-13）
  nav.innerHTML = rows || `<div class="svc-nav-empty">还没有供应商</div>`;
  for (const button of nav.querySelectorAll("[data-provider]")) {
    button.addEventListener("click", () => openProviderForm(button.dataset.provider));
  }
}

/** 右栏：模板选择 / 新建表单 / 编辑表单 / 空态。
 *  2026-11-05 H1：表单区常驻 DOM，切供应商只更新字段值（value/checked/文本），
 *  不再整块 innerHTML（那会让右栏闪一下重新弹）；首次进表单仍走 200ms 下拉展开。 */
function renderProviderDetail({ animate = true } = {}) {
  const host = document.getElementById("provider-detail");
  if (!host) return;
  const view = state.providerView || { mode: "empty" };

  if (view.mode === "templates") {
    host.dataset.view = "templates";
    host.innerHTML = providerTemplatesMarkup();
    wireProviderTemplates(host);
    return;
  }

  const template =
    view.mode === "new" ? PROVIDER_TEMPLATES.find((item) => item.id === view.templateId) || null : null;
  const provider = view.mode === "form" ? providerById(view.providerId) : null;

  if (view.mode === "empty" || (view.mode === "form" && !provider)) {
    // 没有供应商，或列表刷新后这家不见了（别处删掉）：空态，别留一张指向空气的表单
    renderProviderEmpty(host);
    return;
  }

  const existingForm = host.querySelector(".svc-form");
  if (existingForm && host.dataset.view === "form") {
    // 同一种结构：只填值。换了一家才重放 160ms 的 .55→1 微淡入（不位移、不弹跳）
    const sameTarget =
      host.dataset.formFor === (provider ? `form:${provider.id}` : `new:${template ? template.id : "custom"}`);
    if (!sameTarget) {
      existingForm.classList.remove("is-swapping");
      void existingForm.offsetWidth;
      existingForm.classList.add("is-swapping");
      clearTimeout(host.swapTimer);
      host.swapTimer = setTimeout(() => existingForm.classList.remove("is-swapping"), 200);
    }
    fillProviderForm(host, provider, template);
    return;
  }

  host.dataset.view = "form";
  if (!animate) {
    host.innerHTML = `<div class="svc-expand is-open"><div>${providerFormMarkup()}</div></div>`;
    wireProviderForm(host);
    fillProviderForm(host, provider, template);
    return;
  }
  // 先落结构，再填数据：网络慢的时候看到的是空表单骨架，不是白块或旧供应商闪回
  host.innerHTML = `<div class="svc-expand"><div>${providerFormMarkup()}</div></div>`;
  wireProviderForm(host);
  fillProviderForm(host, provider, template);
  const wrap = host.firstElementChild;
  // 双 rAF：先让 0fr 落一帧，再加 is-open，200ms 过渡才会真的跑
  requestAnimationFrame(() => requestAnimationFrame(() => wrap?.classList.add("is-open")));
}

function renderProviderEmpty(host) {
  host.dataset.view = "empty";
  host.innerHTML = `<div class="svc-detail-empty">
    <div class="set-card-title">还没有供应商</div>
    <div class="set-hint">配好 LLM_API_KEY 首次启动会按 env 播种一个；也可以点右上「新建供应商」。</div>
    <button class="btn-primary" type="button" id="provider-empty-add">新建供应商</button>
  </div>`;
  host.querySelector("#provider-empty-add")?.addEventListener("click", () => showProviderTemplates());
}

/** 当前表单指向谁：编辑既有供应商，或基于模板新建 */
function currentProviderFormTarget() {
  const view = state.providerView || {};
  if (view.mode === "form") return { provider: providerById(view.providerId), template: null };
  if (view.mode === "new") {
    return {
      provider: null,
      template: PROVIDER_TEMPLATES.find((item) => item.id === view.templateId) || null,
    };
  }
  return { provider: null, template: null };
}

function showProviderTemplates() {
  const previous = (state.providerView && state.providerView.providerId) || "";
  state.providerView = { mode: "templates", providerId: previous, templateId: "" };
  renderProviderNav();
  renderProviderDetail();
}

function providerTemplatesMarkup() {
  return `<div class="svc-expand is-open"><div>
    <div class="svc-tpl-head">
      <button class="svc-back" type="button" id="provider-tpl-back" aria-label="返回" title="返回">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m12 19-7-7 7-7"/>
          <path d="M19 12H5"/>
        </svg>
      </button>
      <h2 class="svc-tpl-title">选择供应商模板</h2>
    </div>
    <div class="svc-tpl-grid">
      ${PROVIDER_TEMPLATES.map(
        (template) => `<button class="svc-tpl" type="button" data-template="${esc(template.id)}">
          <span class="svc-tpl-icon" aria-hidden="true">${PROVIDER_ICONS[template.id] || esc(template.mark)}</span>
          <span class="svc-tpl-main">
            <span class="svc-tpl-name">${esc(template.name)}</span>
            <span class="svc-tpl-desc">${esc(template.desc)}</span>
          </span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6"/>
          </svg>
        </button>`,
      ).join("")}
    </div>
  </div></div>`;
}

function wireProviderTemplates(host) {
  host.querySelector("#provider-tpl-back")?.addEventListener("click", () => {
    const previous = state.providerView.providerId;
    if (previous && providerById(previous)) {
      state.providerView = { mode: "form", providerId: previous, templateId: "" };
    } else {
      state.providerView = { mode: "empty", providerId: "", templateId: "" };
      ensureProviderView();
    }
    renderProviderNav();
    renderProviderDetail();
  });
  for (const button of host.querySelectorAll("[data-template]")) {
    button.addEventListener("click", () => {
      state.providerView = { mode: "new", providerId: "", templateId: button.dataset.template };
      renderProviderNav();
      renderProviderDetail();
    });
  }
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PLAN_MODELS, PROVIDER_ERROR_TEXT, PROVIDER_ICONS, PROVIDER_SECRET_ERROR_TEXT, PROVIDER_TEMPLATES, currentProviderFormTarget, ensureProviderView, formatTokenCount, loadProviders, providerBrandIcon, providerById, providerErrorText, providerSecretErrorText, providerTemplatesMarkup, renderProviderDetail, renderProviderEmpty, renderProviderNav, showProviderTemplates, templateLabel, templatePlan, templatePlanByBaseUrl, templatePlans, wireProviderTemplates };
