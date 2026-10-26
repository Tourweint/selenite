package com.lifediary.harness.ai;

import static com.google.common.truth.Truth.assertThat;

import com.lifediary.harness.config.HarnessProperties;
import java.io.IOException;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * AiConfigPuller 兜底链（D5/D7）：首拉成功解析 items / since 增量参数与 items=null 语义 /
 * 失败沿用上次成功值 / 从未成功用内置默认；请求必须带 X-Internal-Token。
 * （每个用例独立 MockWebServer，避免请求队列跨用例串扰。）
 */
class AiConfigPullerTest {

    private MockWebServer backend;

    @BeforeEach
    void start() throws IOException {
        backend = new MockWebServer();
        backend.start();
    }

    @AfterEach
    void stop() throws IOException {
        backend.shutdown();
    }

    private HarnessProperties props() {
        return new HarnessProperties(
            new HarnessProperties.Jwt("unit-test-secret-0123456789abcdef"),
            new HarnessProperties.Signal(true, "k", "http://127.0.0.1:1", "jev-latest", null),
            new HarnessProperties.Backend(backend.url("/").toString(), "internal-secret"),
            new HarnessProperties.RateLimit(false, 30, 4),
            new HarnessProperties.Llm("http://127.0.0.1:1/v1", "llm-key", ""));
    }

    @Test
    void pulls_items_and_sends_token_and_since() throws Exception {
        backend.enqueue(new MockResponse().setHeader("Content-Type", "application/json")
            .setBody("{\"code\":0,\"data\":{\"version\":5,\"updatedAt\":1000,"
                + "\"items\":{\"ai.prompt.version\":\"v3\"}}}"));
        var puller = new AiConfigPuller(props());

        var snapshot = puller.current();

        assertThat(snapshot.version()).isEqualTo(5L);
        assertThat(snapshot.items()).containsExactly("ai.prompt.version", "v3");
        var recorded = backend.takeRequest();
        assertThat(recorded.getHeader("X-Internal-Token")).isEqualTo("internal-secret");
        assertThat(recorded.getPath()).contains("/api/v1/internal/ai-config");
        assertThat(recorded.getPath()).contains("since=0");
    }

    @Test
    void items_null_keeps_items_and_updates_version() throws Exception {
        backend.enqueue(new MockResponse().setHeader("Content-Type", "application/json")
            .setBody("{\"code\":0,\"data\":{\"version\":5,\"items\":{\"ai.a\":\"1\"}}}"));
        backend.enqueue(new MockResponse().setHeader("Content-Type", "application/json")
            .setBody("{\"code\":0,\"data\":{\"version\":6,\"items\":null}}"));
        var puller = new AiConfigPuller(props());

        assertThat(puller.current().items()).containsExactly("ai.a", "1");
        puller.expireCache();
        var second = puller.current();

        // 增量语义：items=null = 没变化，沿用上次成功值，仅确认新版本
        assertThat(second.version()).isEqualTo(6L);
        assertThat(second.items()).containsExactly("ai.a", "1");
        assertThat(backend.takeRequest().getPath()).contains("since=0");
        assertThat(backend.takeRequest().getPath()).contains("since=5");
    }

    @Test
    void failure_keeps_last_good_value() throws Exception {
        backend.enqueue(new MockResponse().setHeader("Content-Type", "application/json")
            .setBody("{\"code\":0,\"data\":{\"version\":5,\"items\":{\"ai.a\":\"1\"}}}"));
        backend.enqueue(new MockResponse().setResponseCode(503));
        var puller = new AiConfigPuller(props());

        assertThat(puller.current().version()).isEqualTo(5L);
        puller.expireCache();
        var afterFailure = puller.current();

        assertThat(afterFailure.version()).isEqualTo(5L);
        assertThat(afterFailure.items()).containsExactly("ai.a", "1");
    }

    /** 从未成功过 → 内置默认（P1 = 空表 + version 0），业务不被阻塞。 */
    @Test
    void never_succeeded_uses_builtin_defaults() {
        var puller = new AiConfigPuller(props()); // 不 enqueue → 上游 404/连接拒绝均走兜底
        var snapshot = puller.current();
        assertThat(snapshot.version()).isEqualTo(0L);
        assertThat(snapshot.items()).isEmpty();
    }
}
