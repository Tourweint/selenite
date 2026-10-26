package com.lifediary.harness.signal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.lifediary.harness.ai.AiConfigPuller;
import com.lifediary.harness.config.HarnessProperties;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 会话信号服务（路径 B / Jev，2026-10-22；2026-10-25 随拆分迁入 harness）：
 * 把最近对话交给 TypeSafe Jev 做类型化判断（Choice 会话状态 / Choice 参与度 / Choice 情绪 /
 * Noul 结束意图，一次请求并行四问）。
 *
 * <p>与 backend 版逐行对照迁移，语义铁律不变：
 * <ul>
 *   <li>**advisory**：只给建议，不门控任何流程（方案集分册 06 铁律）；</li>
 *   <li>**不落盘**：请求/响应即取即转，不写任何含正文的日志（D3）；</li>
 *   <li>**失败即回落**：未启用 / 未配 key / 上游失败 / 解析失败，一律返回 empty（并打日志），
 *       客户端回落本地评估器 → 短语兜底（三层信号取 OR）；</li>
 *   <li>**出口代理**：Jev 对境内 IP 返回 451——typesafeProxy 配置 Xray 出口后走代理；留空直连。</li>
 * </ul>
 */
@Service
public class SessionSignalService {

    private static final Logger log = LoggerFactory.getLogger(SessionSignalService.class);

    private final HarnessProperties props;
    private final AiConfigPuller aiConfig;
    private final OkHttpClient http;
    private final ObjectMapper mapper = new ObjectMapper();

    public SessionSignalService(HarnessProperties props, AiConfigPuller aiConfig) {
        this.props = props;
        this.aiConfig = aiConfig;
        this.http = buildHttp(props.signal());
    }

    private static OkHttpClient buildHttp(HarnessProperties.Signal signal) {
        var builder = new OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(5))
            .readTimeout(Duration.ofSeconds(10));
        var proxy = buildProxy(signal == null ? null : signal.typesafeProxy());
        if (proxy != null) {
            builder.proxy(proxy);
            log.info("signal: 出口代理已启用 {}", signal.typesafeProxy());
        }
        return builder.build();
    }

    /** 代理串解析："socks5://host:port"（域名由代理解析）/ "http://host:port"；无效/留空 = null。 */
    static Proxy buildProxy(String spec) {
        if (spec == null || spec.isBlank()) {
            return null;
        }
        try {
            var uri = new java.net.URI(spec.trim());
            var host = uri.getHost();
            var port = uri.getPort();
            if (host == null || port == -1) {
                return null;
            }
            if ("socks5".equals(uri.getScheme()) || "socks".equals(uri.getScheme())) {
                return new Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved(host, port));
            }
            if ("http".equals(uri.getScheme())) {
                return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
            }
            return null;
        } catch (Exception e) {
            log.warn("signal: 代理串解析失败（直连） {}", e.getClass().getSimpleName());
            return null;
        }
    }

    /** 对话消息（role: user/assistant）。 */
    public record Message(String role, String text) {}

    /** 信号结果；available=false = 无信号（调用方回落本地评估器 → 短语兜底）。 */
    public record SessionSignal(
        boolean available,
        String sessionState,
        String engagement,
        String emotion,
        double endingIntent,
        double confidence
    ) {
        public static SessionSignal empty() {
            return new SessionSignal(false, "continue", "engaged", "none", 0d, 0d);
        }
    }

    /** 四问（全中文 instructions/criteria；选项顺序固定写死——Jev 对选项顺序敏感，Pydantic 实测）。 */
    private static final String QUESTIONS_JSON = """
        {
          "session_state": {"type":"choice","instructions":"这是一段日记 App 的对话。以最后一条用户消息为准，判断用户此刻的会话状态。","criteria":{"continue":"用户还想继续聊，或正在正常叙述、提问、开启新话题","wrap_up_suggested":"出现收尾迹象（敷衍应答、简短回应、情绪收束），但还没有明确说结束","wrap_up_confident":"明确表达了今天到此为止、结束对话的意图"}},
          "engagement": {"type":"choice","instructions":"评估最后一条用户消息体现的参与程度。","criteria":{"engaged":"投入地叙述或提问","brief":"简短但有信息增量","perfunctory":"纯敷衍应付，无信息量"}},
          "emotion": {"type":"choice","instructions":"最后一条用户消息体现的主要情绪信号。","criteria":{"none":"无明显情绪信号","positive":"正面","negative":"负面","anxious":"焦虑","tired":"疲惫","angry":"愤怒"}},
          "ending_intent": {"type":"noul","instructions":"最后一条用户消息是否明确表达了今天到此为止、结束对话的意图？","criteria":{"false":"没有结束意图，还想继续","true":"明确表达了今天到此为止"}}
        }
        """;

    public SessionSignal evaluate(List<Message> messages, String today) {
        var signal = props.signal();
        if (signal == null || !signal.jevEnabled() || signal.typesafeKey() == null || signal.typesafeKey().isBlank()) {
            return SessionSignal.empty();
        }
        long t0 = System.currentTimeMillis();
        var configVersion = aiConfig.current().version();
        try {
            // state 紧凑化（2026-10-22，token 节省）：最近 3 条分级截断 + 代码算计数
            //（Jev 官方自认「计数与算术不可靠」——字数由我们算好喂给它）
            var state = compactState(mapper, messages, today);

            ObjectNode body = mapper.createObjectNode();
            body.put("model", signal.typesafeModel());
            body.set("state", state);
            body.set("questions", mapper.readTree(QUESTIONS_JSON));

            Request request = new Request.Builder()
                .url(signal.typesafeUrl())
                .header("Authorization", "Bearer " + signal.typesafeKey())
                .header("Content-Type", "application/json")
                .post(okhttp3.RequestBody.create(
                    MediaType.parse("application/json"), mapper.writeValueAsBytes(body)))
                .build();
            try (var response = http.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    // 401=key 无效 / 451=区域封锁 / 5xx=上游——advisory 静默回落，但必须留下线索
                    log.warn("signal: 上游 HTTP {}（configVersion={}，{} ms）",
                        response.code(), configVersion, System.currentTimeMillis() - t0);
                    return SessionSignal.empty();
                }
                JsonNode root = mapper.readTree(response.body().string());
                JsonNode answers = root.path("answers");
                var out = new SessionSignal(
                    true,
                    normalize(answers.path("session_state").path("choice").asText("continue"),
                        Set.of("continue", "wrap_up_suggested", "wrap_up_confident"), "continue"),
                    normalize(answers.path("engagement").path("choice").asText("engaged"),
                        Set.of("engaged", "brief", "perfunctory"), "engaged"),
                    normalize(answers.path("emotion").path("choice").asText("none"),
                        Set.of("none", "positive", "negative", "anxious", "tired", "angry"), "none"),
                    clamp01(answers.path("ending_intent").path("noul").asDouble(0)),
                    clamp01(answers.path("session_state").path("confidence").asDouble(0)));
                log.info("signal: ok state={} engagement={} emotion={} ending={} conf={} "
                        + "(configVersion={}，{} ms, in={} tok)",
                    out.sessionState(), out.engagement(), out.emotion(), out.endingIntent(),
                    out.confidence(), configVersion, System.currentTimeMillis() - t0,
                    root.path("usage").path("input_tokens").asInt(0));
                return out;
            }
        } catch (Exception e) {
            // advisory：任何失败都静默回落，绝不抛出影响主链路；日志记异常类型（不含消息内容）
            log.info("signal: failed ({}) {} configVersion={} {} ms",
                e.getClass().getSimpleName(), e.getMessage(), configVersion, System.currentTimeMillis() - t0);
            return SessionSignal.empty();
        }
    }

    /**
     * 紧凑 state（分册 08 §1.1 的 token 节省项，与 backend 版一致）：
     * - 只带**最近 3 条**（以最后一条用户消息收尾——收尾线索都在尾巴上）；
     * - 分级截断：最后一条用户消息 ≤300 字（判断主体），其余 ≤120 字（仅上下文）；
     * - 计数字段由代码算好（turn_count / last_user_chars）——模型自己数数不可靠（官方 jaggedness）。
     */
    static ObjectNode compactState(ObjectMapper mapper, List<Message> messages, String today) {
        var safe = messages == null ? List.<Message>of() : messages;
        ObjectNode state = mapper.createObjectNode();
        state.put("today", today == null ? "" : today);
        state.put("turn_count", safe.size());
        var lastUser = safe.stream().filter(m -> "user".equals(m.role())).reduce((a, b) -> b).orElse(null);
        state.put("last_user_chars", lastUser == null || lastUser.text() == null ? 0 : lastUser.text().length());
        var recent = state.putArray("recent");
        var tail = safe.subList(Math.max(0, safe.size() - 3), safe.size());
        for (int i = 0; i < tail.size(); i++) {
            var m = tail.get(i);
            var isLastUserMessage = i == tail.size() - 1 && "user".equals(m.role());
            var cap = isLastUserMessage ? 300 : 120;
            var text = m.text() == null ? "" : m.text();
            ObjectNode n = recent.addObject();
            n.put("role", m.role());
            n.put("text", text.substring(0, Math.min(text.length(), cap)));
        }
        return state;
    }

    /** 枚举归一化：未知值回默认（服务端只可能下发合法值，客户端可直信）。 */
    static String normalize(String value, Set<String> allowed, String fallback) {
        if (value == null) {
            return fallback;
        }
        var v = value.trim();
        return allowed.contains(v) ? v : fallback;
    }

    static double clamp01(double value) {
        if (value < 0) return 0;
        return Math.min(value, 1);
    }
}
