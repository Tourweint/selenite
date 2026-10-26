package com.lifediary.harness.signal;

import static com.google.common.truth.Truth.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifediary.harness.ai.AiConfigPuller;
import com.lifediary.harness.config.HarnessProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 信号服务纯逻辑单测：available=false 的两种零成本触发（未启用 / 无 key）、
 * 紧凑 state 的截断与计数、枚举归一化与代理串解析（对照 backend SessionSignalService 同名逻辑）。
 */
class SessionSignalServiceUnitTest {

    private static HarnessProperties props(boolean enabled, String key) {
        return new HarnessProperties(
            new HarnessProperties.Jwt("unit-test-secret-0123456789abcdef"),
            new HarnessProperties.Signal(enabled, key, "http://127.0.0.1:1/v1/systemone", "jev-latest", null),
            new HarnessProperties.Backend("http://127.0.0.1:1", ""),
            new HarnessProperties.RateLimit(false, 30, 4),
            new HarnessProperties.Llm("http://127.0.0.1:1/v1", "llm-key", ""));
    }

    private static SessionSignalService service(HarnessProperties props) {
        return new SessionSignalService(props, new AiConfigPuller(props));
    }

    private static HarnessProperties.Signal signalOf(HarnessProperties props) {
        return props.signal();
    }

    /** available=false 路径①：未启用（jevEnabled=false）——根本不出网。 */
    @Test
    void disabled_returns_empty() {
        var out = service(props(false, "key")).evaluate(
            List.of(new SessionSignalService.Message("user", "没了")), "2026-10-22");
        assertThat(out.available()).isFalse();
        assertThat(out).isEqualTo(SessionSignalService.SessionSignal.empty());
    }

    /** available=false 路径②：未配 key。 */
    @Test
    void blank_key_returns_empty() {
        var out = service(props(true, " ")).evaluate(
            List.of(new SessionSignalService.Message("user", "没了")), "2026-10-22");
        assertThat(out.available()).isFalse();
    }

    /** 紧凑 state：最近 3 条、分级截断（末条用户 300 / 其余 120）、计数由代码算好。 */
    @Test
    void compact_state_keeps_tail_three_with_tiered_caps() throws Exception {
        var mapper = new ObjectMapper();
        var messages = new java.util.ArrayList<SessionSignalService.Message>();
        for (int i = 0; i < 9; i++) {
            messages.add(new SessionSignalService.Message("assistant", "a".repeat(i == 8 ? 500 : 200)));
            messages.add(new SessionSignalService.Message("user", "u".repeat(400)));
        }
        var state = SessionSignalService.compactState(mapper, messages, "2026-10-22");

        assertThat(state.path("today").asText()).isEqualTo("2026-10-22");
        assertThat(state.path("turn_count").asInt()).isEqualTo(18);
        assertThat(state.path("last_user_chars").asInt()).isEqualTo(400);
        var recent = state.path("recent");
        assertThat(recent.size()).isEqualTo(3);
        // 尾巴三条 = [user#7, assistant#8, user#8]：前两条截到 120，末条用户消息截到 300
        assertThat(recent.get(0).path("role").asText()).isEqualTo("user");
        assertThat(recent.get(0).path("text").asText().length()).isEqualTo(120);
        assertThat(recent.get(1).path("role").asText()).isEqualTo("assistant");
        assertThat(recent.get(1).path("text").asText().length()).isEqualTo(120);
        assertThat(recent.get(2).path("role").asText()).isEqualTo("user");
        assertThat(recent.get(2).path("text").asText().length()).isEqualTo(300);
    }

    @Test
    void normalize_falls_back_on_unknown_values() {
        assertThat(SessionSignalService.normalize(" wrap_up_confident ",
            java.util.Set.of("continue", "wrap_up_suggested", "wrap_up_confident"), "continue"))
            .isEqualTo("wrap_up_confident");
        assertThat(SessionSignalService.normalize("bogus",
            java.util.Set.of("engaged", "brief", "perfunctory"), "engaged")).isEqualTo("engaged");
        assertThat(SessionSignalService.normalize(null,
            java.util.Set.of("none", "positive"), "none")).isEqualTo("none");
        assertThat(SessionSignalService.clamp01(1.5)).isEqualTo(1.0);
        assertThat(SessionSignalService.clamp01(-0.1)).isEqualTo(0.0);
    }

    @Test
    void proxy_parsing() {
        assertThat(SessionSignalService.buildProxy(null)).isNull();
        assertThat(SessionSignalService.buildProxy("  ")).isNull();
        var socks = SessionSignalService.buildProxy("socks5://127.0.0.1:10808");
        assertThat(socks).isNotNull();
        assertThat(socks.type()).isEqualTo(java.net.Proxy.Type.SOCKS);
        var http = SessionSignalService.buildProxy("http://127.0.0.1:7890");
        assertThat(http).isNotNull();
        assertThat(http.type()).isEqualTo(java.net.Proxy.Type.HTTP);
        assertThat(SessionSignalService.buildProxy("ftp://x:1")).isNull();
        assertThat(SessionSignalService.buildProxy("socks5://127.0.0.1")).isNull();
    }
}
