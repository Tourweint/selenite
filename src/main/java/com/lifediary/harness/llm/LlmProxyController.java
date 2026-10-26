package com.lifediary.harness.llm;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifediary.harness.ai.AiConfigPuller;
import com.lifediary.harness.common.BusinessException;
import com.lifediary.harness.config.HarnessProperties;
import com.lifediary.harness.config.JwtAuthFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.UUID;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * LLM OpenAI 兼容透传代理（P2，对照 backend LlmProxyController 逐行迁移；契约不变）。
 *
 * - 客户端不带任何模型 key，带的是登录 JWT（{@link JwtAuthFilter} 已校验并放入 userId）；
 * - **先扣再转发（D1）**：转发前调 backend 内部扣额（幂等），扣失败即拒——额度耗尽 4029 与
 *   "登录已过期" 4010 都由 backend 生成、本服务原样透传，依赖失败 503+5001（fail-closed）；
 * - 上游响应（含 SSE 流式）逐块回写并 flush——客户端 core:ai 的 OpenAI 兼容客户端零改动接入；
 * - **隐私边界：不落盘请求/响应内容**，日志只记用量/耗时/configVersion（D3/D7）；
 * - **模型覆盖（2026-10-21 口径随迁）**：LLM_MODEL 非空时转发前覆盖请求体 model 字段；
 * - **额度即闸门**：鉴权挡匿名滥用、每用户每日额度挡刷量，故本端点不再叠 IP 频控
 *   （signal 端点无额度概念才需要 IP 闸；口径见 harness 接口文档 §0.1）。
 */
@RestController
public class LlmProxyController {

    private static final Logger log = LoggerFactory.getLogger(LlmProxyController.class);

    private final HarnessProperties props;
    private final InternalQuotaClient quotaClient;
    private final AiConfigPuller aiConfig;
    private final ObjectMapper mapper;
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(Duration.ofSeconds(15))
        .readTimeout(Duration.ofSeconds(180))
        .writeTimeout(Duration.ofSeconds(60))
        .build();

    public LlmProxyController(HarnessProperties props, InternalQuotaClient quotaClient,
        AiConfigPuller aiConfig, ObjectMapper mapper) {
        this.props = props;
        this.quotaClient = quotaClient;
        this.aiConfig = aiConfig;
        this.mapper = mapper;
    }

    @PostMapping({"/api/v1/llm/chat/completions", "/chat/completions"})
    public void chatCompletions(
        @RequestBody String body,
        HttpServletRequest request,
        HttpServletResponse response
    ) throws IOException {
        var userId = (Long) request.getAttribute(JwtAuthFilter.ATTR_USER_ID);
        if (userId == null) {
            throw new BusinessException(403, "未认证", 403);
        }
        // 先扣再转发（D1 铁律）：requestId 每请求一个 UUID，backend 侧幂等（24h 窗口）
        var configVersion = aiConfig.current().version();
        var quota = quotaClient.consume(userId, UUID.randomUUID().toString(), "LLM");
        log.info("llm: 转发 user={} quota={}/{} tier={} configVersion={}",
            userId, quota.quotaUsed(), quota.quotaLimit(), quota.tier(), configVersion);

        // 调优归服务端：model 非空时覆盖（内存内改写、不落盘——隐私边界不变）
        String outgoing = ModelOverride.apply(mapper, body, props.llm().model());

        var upstream = new Request.Builder()
            .url(props.llm().baseUrl() + "/chat/completions")
            .header("Authorization", "Bearer " + props.llm().apiKey())
            .header("Content-Type", "application/json")
            .post(okhttp3.RequestBody.create(MediaType.parse("application/json"), outgoing))
            .build();

        var call = http.newCall(upstream);
        try (var upstreamResponse = call.execute()) {
            response.setStatus(upstreamResponse.code());
            response.setContentType(upstreamResponse.header("Content-Type", "application/json"));
            response.setHeader("Cache-Control", "no-store");
            try (var in = upstreamResponse.body().byteStream(); var out = response.getOutputStream()) {
                // 逐块回写并 flush：SSE 流式透传的关键
                byte[] buffer = new byte[1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    out.write(buffer, 0, n);
                    out.flush();
                }
            }
        }
    }
}
