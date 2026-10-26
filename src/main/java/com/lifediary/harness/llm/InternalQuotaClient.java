package com.lifediary.harness.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifediary.harness.common.BusinessException;
import com.lifediary.harness.config.HarnessProperties;
import java.time.Duration;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * backend 内部扣额客户端（D1/D7，接口文档 §9.1）：**先扣再转发**铁律的 harness 侧执行者。
 *
 * - 连接 200ms / 读 1s（D7 口径）——扣额绝不能拖慢主链路；
 * - 幂等键 requestId 由本服务生成（每请求一个 UUID），重试不双扣是 backend 的事；
 * - 失败映射（fail-closed，任何拿不到成功结果的情形都必须拒绝本次调用）：
 *   429 → 原样透传 code+message（4029 文案只此一份，由 backend 生成）；401 → 4010
 *   （"登录已过期"语义，D2 的注销兜底）；其余一律 503 + 5001。
 */
@Component
public class InternalQuotaClient {

    /** 扣减结果（与 backend /internal/quota/consume 出参一致）。 */
    public record ConsumeResult(int quotaUsed, int quotaLimit, String tier) {}

    private static final Logger log = LoggerFactory.getLogger(InternalQuotaClient.class);

    private final HarnessProperties props;
    private final OkHttpClient http;
    private final ObjectMapper mapper = new ObjectMapper();

    public InternalQuotaClient(HarnessProperties props) {
        this.props = props;
        this.http = new OkHttpClient.Builder()
            .connectTimeout(Duration.ofMillis(200))
            .readTimeout(Duration.ofSeconds(1))
            .build();
    }

    public ConsumeResult consume(Long userId, String requestId, String kind) {
        var backend = props.backend();
        long t0 = System.currentTimeMillis();
        try {
            var body = mapper.createObjectNode()
                .put("userId", userId)
                .put("requestId", requestId)
                .put("kind", kind);
            var request = new Request.Builder()
                .url(backend.internalBaseUrl().replaceAll("/$", "") + "/api/v1/internal/quota/consume")
                .header("X-Internal-Token", backend.internalToken() == null ? "" : backend.internalToken())
                .header("Content-Type", "application/json")
                .post(okhttp3.RequestBody.create(
                    MediaType.parse("application/json"), mapper.writeValueAsBytes(body)))
                .build();
            try (var response = http.newCall(request).execute()) {
                var raw = response.body() == null ? "" : response.body().string();
                if (response.isSuccessful()) {
                    var data = mapper.readTree(raw).path("data");
                    var out = new ConsumeResult(
                        data.path("quotaUsed").asInt(0),
                        data.path("quotaLimit").asInt(0),
                        data.path("tier").asText("free"));
                    log.info("quota: ok used={}/{} tier={}（{} ms）",
                        out.quotaUsed(), out.quotaLimit(), out.tier(), System.currentTimeMillis() - t0);
                    return out;
                }
                // 429/401：把 backend 的 code+message 原样透传（额度文案只此一份）
                var root = mapper.readTree(raw);
                int code = root.path("code").asInt(0);
                String message = root.path("message").asText("");
                if (response.code() == 429 && code == 4029) {
                    log.warn("quota: 额度耗尽 user={}（{} ms）", userId, System.currentTimeMillis() - t0);
                    throw new BusinessException(code, message, 429);
                }
                if (response.code() == 401 && code == 4010) {
                    log.warn("quota: 账号不存在/已注销 user={}（{} ms）", userId, System.currentTimeMillis() - t0);
                    throw new BusinessException(4010, "账号不存在或已注销", 401);
                }
                log.warn("quota: 拒绝 HTTP {} code={}（{} ms）", response.code(), code, System.currentTimeMillis() - t0);
                throw new BusinessException(5001, "依赖服务不可用", 503);
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            // 超时/连接失败/解析失败：fail-closed，绝不放行未扣额的调用
            log.warn("quota: 扣额失败（{}，{} ms）", e.getClass().getSimpleName(), System.currentTimeMillis() - t0);
            throw new BusinessException(5001, "依赖服务不可用", 503);
        }
    }
}
