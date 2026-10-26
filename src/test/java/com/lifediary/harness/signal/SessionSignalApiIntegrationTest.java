package com.lifediary.harness.signal;

import static com.google.common.truth.Truth.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Date;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 信号端点端到端（MockWebServer 顶替 TypeSafe Jev）。
 *
 * <p>**契约金样测试**（验收第一条的仓库内等价物）：给定与 backend 完全相同的 Jev 应答，
 * 响应体必须逐字段等于 backend 版实现产出的 JSON——backend 的归一化/钳制是确定性纯函数，
 * 故用固定金样锚定；跨服务真机对比（同一入参打两端）按拆分方案 §6 P1 上线清单另行执行。
 */
@SpringBootTest
@AutoConfigureMockMvc
class SessionSignalApiIntegrationTest {

    private static final String SECRET = "unit-test-secret-0123456789abcdef";
    private static final MockWebServer JEV = new MockWebServer();

    static {
        try {
            JEV.start();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @AfterAll
    static void stop() throws Exception {
        JEV.shutdown();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.jwt.secret", () -> SECRET);
        registry.add("app.signal.jev-enabled", () -> "true");
        registry.add("app.signal.typesafe-key", () -> "test-key");
        registry.add("app.signal.typesafe-url", () -> JEV.url("/v1/systemone").toString());
        registry.add("app.signal.typesafe-proxy", () -> "");
        // backend 内部接口不可达 → AiConfigPuller 走"从未成功 → 内置默认"分支，恰好覆盖兜底链
        registry.add("app.backend.internal-base-url", () -> "http://127.0.0.1:1");
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

    private static void enqueueJev(String body) {
        JEV.enqueue(new MockResponse()
            .setHeader("Content-Type", "application/json")
            .setBody(body));
    }

    /** 契约金样：与 backend 同一 Jev 应答 → 响应体逐字段一致（含字段顺序与数值序列化）。 */
    @Test
    void response_matches_backend_contract_golden() throws Exception {
        enqueueJev("""
            {"answers":{"session_state":{"choice":"wrap_up_confident","confidence":1.0},
            "engagement":{"choice":"perfunctory"},"emotion":{"choice":"none"},
            "ending_intent":{"noul":0.97}},"usage":{"input_tokens":42}}""");

        MvcResult result = mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[{\"role\":\"user\",\"text\":\"没了\"}],\"today\":\"2026-10-22\"}"))
            .andExpect(status().isOk())
            .andReturn();

        assertThat(result.getResponse().getContentAsString()).isEqualTo(
            "{\"code\":0,\"message\":\"ok\",\"data\":{\"available\":true,"
                + "\"sessionState\":\"wrap_up_confident\",\"engagement\":\"perfunctory\","
                + "\"emotion\":\"none\",\"endingIntent\":0.97,\"confidence\":1.0}}");
    }

    /** 归一化对照：未知枚举回默认、越界数值钳到 [0,1]——与 backend normalize/clamp01 同语义。 */
    @Test
    void normalizes_and_clamps_like_backend() throws Exception {
        enqueueJev("""
            {"answers":{"session_state":{"choice":"???","confidence":5.5},
            "engagement":{"choice":"whatever"},"emotion":{"choice":"negative"},
            "ending_intent":{"noul":9.0}}}""");

        MvcResult result = mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[{\"role\":\"user\",\"text\":\"睡了吧\"}],\"today\":\"2026-10-22\"}"))
            .andExpect(status().isOk())
            .andReturn();

        assertThat(result.getResponse().getContentAsString()).isEqualTo(
            "{\"code\":0,\"message\":\"ok\",\"data\":{\"available\":true,"
                + "\"sessionState\":\"continue\",\"engagement\":\"engaged\","
                + "\"emotion\":\"negative\",\"endingIntent\":1.0,\"confidence\":1.0}}");
    }

    /** available=false 路径③：上游失败（HTTP 500；401/451/超时同路径）→ 不报错，静默回落。 */
    @Test
    void upstream_failure_returns_available_false() throws Exception {
        JEV.enqueue(new MockResponse().setResponseCode(500));
        MvcResult result = mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[],\"today\":\"2026-10-22\"}"))
            .andExpect(status().isOk())
            .andReturn();
        assertThat(result.getResponse().getContentAsString()).isEqualTo(
            "{\"code\":0,\"message\":\"ok\",\"data\":{\"available\":false,"
                + "\"sessionState\":\"continue\",\"engagement\":\"engaged\","
                + "\"emotion\":\"none\",\"endingIntent\":0.0,\"confidence\":0.0}}");
    }

    /** available=false 路径③附：上游 200 但解析失败 → 同样静默回落。 */
    @Test
    void malformed_upstream_body_returns_available_false() throws Exception {
        enqueueJev("这不是 JSON");
        MvcResult result = mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[],\"today\":\"2026-10-22\"}"))
            .andExpect(status().isOk())
            .andReturn();
        assertThat(result.getResponse().getContentAsString()).contains("\"available\":false");
    }

    /** 鉴权：缺头/无效 token → 403（与 backend 一致，App 无需区分两端）。 */
    @Test
    void missing_or_invalid_token_is_403() throws Exception {
        mvc.perform(post("/api/v1/signal/session")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[],\"today\":\"\"}"))
            .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer not-a-jwt")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[],\"today\":\"\"}"))
            .andExpect(status().isForbidden());
    }

    /** 上限保护：35 条入参 → 发给 Jev 的 state 只带 turn_count=35 + 最近 3 条（其余截断在服务端完成）。 */
    @Test
    void over_limit_input_is_truncated_before_jev() throws Exception {
        enqueueJev("{\"answers\":{\"session_state\":{\"choice\":\"continue\"}}}");
        var messages = new ArrayList<String>();
        for (int i = 0; i < 35; i++) {
            messages.add("{\"role\":\"user\",\"text\":\"第" + i + "条\"}");
        }
        var prior = JEV.getRequestCount(); // 之前用例落在队列里的请求
        mvc.perform(post("/api/v1/signal/session")
                .header("Authorization", "Bearer " + token(7L))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[" + String.join(",", messages) + "],\"today\":\"2026-10-22\"}"))
            .andExpect(status().isOk())
            // 静默回落也返回 200——必须断言真的打到了 Jev，否则下面的取请求会白等
            .andExpect(jsonPath("$.data.available").value(true));

        for (int i = 0; i < prior; i++) {
            JEV.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS);
        }
        var recorded = JEV.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(recorded).isNotNull();
        var mapper = new ObjectMapper();
        var state = mapper.readTree(recorded.getBody().readUtf8()).path("state");
        // 控制器先把入参截到 30 条（与 backend 一致），服务层再取最近 3 条
        assertThat(state.path("turn_count").asInt()).isEqualTo(30);
        assertThat(state.path("recent").size()).isEqualTo(3);
        assertThat(state.path("recent").get(2).path("text").asText()).isEqualTo("第29条");
    }
}
