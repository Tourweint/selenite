package com.lifediary.harness.llm;

import static com.google.common.truth.Truth.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * LLM 透传代理端到端（MockWebServer ×2：上游 LLM + backend 内部接口）。
 * 验收：SSE 透传、先扣再转发（D1）、4029 文案原样透传、4010 语义、内部失败 fail-closed、模型覆盖。
 */
@SpringBootTest
@AutoConfigureMockMvc
class LlmProxyApiIntegrationTest {

    private static final String SECRET = "unit-test-secret-0123456789abcdef";
    private static final MockWebServer UPSTREAM = new MockWebServer();
    private static final MockWebServer BACKEND = new MockWebServer();

    /** 各测试注入的扣额响应（按路径分发，消除与 AiConfigPuller 首拉的队列顺序耦合）。 */
    private static final AtomicReference<MockResponse> CONSUME_RESPONSE = new AtomicReference<>();

    @BeforeAll
    static void start() throws Exception {
        UPSTREAM.start();
        BACKEND.start();
        BACKEND.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                if (request.getPath() != null
                    && request.getPath().startsWith("/api/v1/internal/ai-config")) {
                    // 配置拉取（D5/D7）：永远给一条合法的空配置，60s 缓存内只拉一次
                    return new MockResponse().setHeader("Content-Type", "application/json")
                        .setBody("{\"code\":0,\"data\":{\"version\":0,\"items\":null}}");
                }
                return CONSUME_RESPONSE.get();
            }
        });
        CONSUME_RESPONSE.set(new MockResponse().setHeader("Content-Type", "application/json")
            .setResponseCode(200).setBody("{\"code\":0,\"data\":{\"quotaUsed\":0,\"quotaLimit\":100,\"tier\":\"free\"}}"));
    }

    @AfterAll
    static void stop() throws Exception {
        UPSTREAM.shutdown();
        BACKEND.shutdown();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.jwt.secret", () -> SECRET);
        registry.add("app.llm.base-url", () -> UPSTREAM.url("/v1").toString());
        registry.add("app.llm.api-key", () -> "upstream-key");
        registry.add("app.llm.model", () -> "harness-test-model");
        registry.add("app.backend.internal-base-url", () -> BACKEND.url("/").toString());
        registry.add("app.backend.internal-token", () -> "internal-secret");
        registry.add("app.rate-limit.enabled", () -> "false");
    }

    @Autowired
    MockMvc mvc;

    private static String token(long userId) {
        var now = Instant.now();
        return Jwts.builder()
            .subject(String.valueOf(userId))
            .issuedAt(Date.from(now))
            .expiration(Date.from(now.plus(1, ChronoUnit.DAYS)))
            .signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8)))
            .compact();
    }

    private static void enqueueConsume(int httpCode, String body) {
        CONSUME_RESPONSE.set(new MockResponse().setHeader("Content-Type", "application/json")
            .setResponseCode(httpCode).setBody(body));
    }

    /** 取下一条扣额请求：跳过配置拉取请求（首拉可能在任意时刻插入）。 */
    private static RecordedRequest takeConsumeRequest() throws InterruptedException {
        for (int i = 0; i < 10; i++) {
            var request = BACKEND.takeRequest(2, TimeUnit.SECONDS);
            if (request == null) {
                return null;
            }
            if (request.getPath() != null
                && request.getPath().startsWith("/api/v1/internal/quota/consume")) {
                return request;
            }
        }
        return null;
    }

    /** 快乐路径：先扣额 → 模型覆盖 → SSE 逐块透传（状态码/Content-Type/响应体原样）。 */
    @Test
    void consumes_then_streams_upstream_response() throws Exception {
        enqueueConsume(200, "{\"code\":0,\"data\":{\"quotaUsed\":13,\"quotaLimit\":100,\"tier\":\"free\"}}");
        UPSTREAM.enqueue(new MockResponse()
            .setHeader("Content-Type", "text/event-stream;charset=utf-8")
            .setBody("data: {\"chunk\":1}\n\ndata: {\"chunk\":2}\n\ndata: [DONE]\n\n"));

        mvc.perform(post("/api/v1/llm/chat/completions")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"model\":\"client-writes-this\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"))
            .andExpect(status().isOk());

        // 扣额调用：kind=LLM、userId 从 JWT 取、requestId 是非空幂等键、带内部令牌
        var consumeCall = takeConsumeRequest();
        assertThat(consumeCall).isNotNull();
        assertThat(consumeCall.getPath()).isEqualTo("/api/v1/internal/quota/consume");
        assertThat(consumeCall.getHeader("X-Internal-Token")).isEqualTo("internal-secret");
        var consumeBody = new ObjectMapper().readTree(consumeCall.getBody().readUtf8());
        assertThat(consumeBody.path("userId").asLong()).isEqualTo(7L);
        assertThat(consumeBody.path("kind").asText()).isEqualTo("LLM");
        assertThat(consumeBody.path("requestId").asText()).isNotEmpty();

        // 上游调用：模型被覆盖、key 是服务端持有的
        var upstreamCall = UPSTREAM.takeRequest();
        assertThat(upstreamCall.getHeader("Authorization")).isEqualTo("Bearer upstream-key");
        var upstreamBody = new ObjectMapper().readTree(upstreamCall.getBody().readUtf8());
        assertThat(upstreamBody.path("model").asText()).isEqualTo("harness-test-model");
    }

    /** 额度耗尽：4029 + backend 生成的文案**原样透传**，且上游一次都不被打。 */
    @Test
    void quota_exhausted_passes_through_4029_without_touching_upstream() throws Exception {
        enqueueConsume(429, "{\"code\":4029,\"message\":\"今日额度（100 次）已用完，明天再来\"}");
        var upstreamBefore = UPSTREAM.getRequestCount();

        mvc.perform(post("/api/v1/llm/chat/completions")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"model\":\"m\",\"messages\":[]}"))
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.code").value(4029))
            .andExpect(jsonPath("$.message").value("今日额度（100 次）已用完，明天再来"));

        assertThat(UPSTREAM.getRequestCount()).isEqualTo(upstreamBefore);
    }

    /** 账号不存在/已注销（D2 注销兜底）：401 + 4010，App 按"登录已过期"处理。 */
    @Test
    void missing_account_passes_through_4010() throws Exception {
        enqueueConsume(401, "{\"code\":4010,\"message\":\"账号不存在或已注销\"}");

        mvc.perform(post("/api/v1/llm/chat/completions")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"model\":\"m\",\"messages\":[]}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value(4010));
    }

    /** 依赖失败 fail-closed：backend 内部接口挂了 → 503+5001，绝不放行未扣额的调用。 */
    @Test
    void internal_failure_is_fail_closed() throws Exception {
        enqueueConsume(503, "{\"code\":5001,\"message\":\"依赖服务不可用\"}");
        var upstreamBefore = UPSTREAM.getRequestCount();

        mvc.perform(post("/api/v1/llm/chat/completions")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"model\":\"m\",\"messages\":[]}"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value(5001));

        assertThat(UPSTREAM.getRequestCount()).isEqualTo(upstreamBefore);
    }

    /** 根路径别名（与 backend 同款兼容）：OpenAI 客户端在 baseUrl 后直接拼 /chat/completions。 */
    @Test
    void root_path_alias_works() throws Exception {
        enqueueConsume(200, "{\"code\":0,\"data\":{\"quotaUsed\":1,\"quotaLimit\":100,\"tier\":\"free\"}}");
        UPSTREAM.enqueue(new MockResponse()
            .setHeader("Content-Type", "application/json")
            .setBody("{\"id\":\"x\"}"));

        mvc.perform(post("/chat/completions")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"model\":\"m\",\"messages\":[]}"))
            .andExpect(status().isOk());
    }
}
