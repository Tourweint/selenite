package com.lifediary.harness.common;

import static com.google.common.truth.Truth.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.lifediary.harness.config.HarnessProperties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * 频控闸门单测（等价移植 backend IpRateLimitGuardTest 的核心行为）：
 * 频次上限、并发上限、开关关闭全放行。
 */
class IpRateLimitGuardTest {

    private static HarnessProperties props(boolean enabled, int perMinute, int maxConcurrent) {
        return new HarnessProperties(
            new HarnessProperties.Jwt("unit-test-secret-0123456789abcdef"),
            new HarnessProperties.Signal(true, "k", "http://127.0.0.1:1", "jev-latest", null),
            new HarnessProperties.Backend("http://127.0.0.1:1", ""),
            new HarnessProperties.RateLimit(enabled, perMinute, maxConcurrent),
            new HarnessProperties.Llm("http://127.0.0.1:1/v1", "llm-key", ""));
    }

    private static MockHttpServletRequest request(String ip) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(ip);
        return request;
    }

    @Test
    void frequency_limit_per_ip() {
        var guard = new IpRateLimitGuard(props(true, 2, 10));
        assertThat(guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("1.1.1.1"), () -> "ok")).isEqualTo("ok");
        assertThat(guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("1.1.1.1"), () -> "ok")).isEqualTo("ok");

        var e = assertThrows(BusinessException.class, () ->
            guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("1.1.1.1"), () -> "ok"));
        assertThat(e.getCode()).isEqualTo(4290);
        assertThat(e.getHttpStatus()).isEqualTo(429);

        // 别的 IP 不受牵连（按 IP 隔离）
        assertThat(guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("2.2.2.2"), () -> "ok")).isEqualTo("ok");
    }

    @Test
    void concurrency_limit_blocks_second_inflight() throws Exception {
        var guard = new IpRateLimitGuard(props(true, 100, 1));
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var pool = Executors.newSingleThreadExecutor();
        var firstError = new AtomicReference<Exception>();

        pool.submit(() -> {
            try {
                guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("3.3.3.3"), () -> {
                    entered.countDown();
                    try {
                        release.await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(e);
                    }
                    return "ok";
                });
            } catch (Exception e) {
                firstError.set(e);
            }
            return null;
        });
        assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();

        var second = assertThrows(BusinessException.class, () ->
            guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("3.3.3.3"), () -> "ok"));
        assertThat(second.getCode()).isEqualTo(4290);

        release.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        assertThat(firstError.get()).isNull();
    }

    @Test
    void disabled_gate_lets_everything_through() {
        var guard = new IpRateLimitGuard(props(false, 1, 1));
        for (int i = 0; i < 10; i++) {
            assertThat(guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request("4.4.4.4"), () -> "ok")).isEqualTo("ok");
        }
    }
}
