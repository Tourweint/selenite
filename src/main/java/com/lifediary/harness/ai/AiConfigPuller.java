package com.lifediary.harness.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifediary.harness.config.HarnessProperties;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * AI 配置拉取（拆分方案 D5/D7 + 接口文档 §9.2）：backend 是唯一参数源，本服务 60s 轮询增量拉取。
 *
 * <p>兜底链（D5）：拉到新值 → 更新快照；拉失败 → **沿用上次成功值**（并在日志标 configVersion）；
 * 从未成功过 → 内置默认（P1 为空表——尚无 ai.* 行为键，P2 起按需登记默认值）。
 * 每次上游调用的日志必须带 configVersion（D7 审计闭环），否则后台无法回答
 * "这个用户当时生效的是什么值"。
 *
 * <p>注意：`ai.*` 键**永远不含密钥**——上游 key 与出口代理只走环境变量（HarnessProperties 口径）。
 */
@Component
public class AiConfigPuller {

    /** 快照：version = ai.* 行的最大 updated_at；items 为全量键值（增量拉取、全量替换）。 */
    public record Snapshot(long version, Map<String, String> items) {
        public static Snapshot empty() {
            return new Snapshot(0L, Map.of());
        }
    }

    private static final long CACHE_MILLIS = 60_000L;
    private static final Logger log = LoggerFactory.getLogger(AiConfigPuller.class);

    private final HarnessProperties props;
    private final OkHttpClient http;
    private final ObjectMapper mapper = new ObjectMapper();

    private volatile Snapshot current = Snapshot.empty();
    private volatile long nextPullAt = 0L;

    public AiConfigPuller(HarnessProperties props) {
        this.props = props;
        this.http = new OkHttpClient.Builder()
            // D7 口径：连接 200ms / 读 1s——配置拉取绝不能拖慢主链路
            .connectTimeout(Duration.ofMillis(200))
            .readTimeout(Duration.ofSeconds(1))
            .build();
    }

    /** 当前快照（缓存 60s；调用方拿 version 写日志）。 */
    public synchronized Snapshot current() {
        var now = System.currentTimeMillis();
        if (now >= nextPullAt) {
            nextPullAt = now + CACHE_MILLIS;
            pull();
        }
        return current;
    }

    private void pull() {
        var backend = props.backend();
        if (backend == null || backend.internalBaseUrl() == null || backend.internalBaseUrl().isBlank()) {
            return;
        }
        long t0 = System.currentTimeMillis();
        try {
            var url = backend.internalBaseUrl().replaceAll("/$", "")
                + "/api/v1/internal/ai-config?since=" + current.version();
            var request = new Request.Builder()
                .url(url)
                .header("X-Internal-Token", backend.internalToken() == null ? "" : backend.internalToken())
                .get()
                .build();
            try (var response = http.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    log.warn("config: 拉取失败 HTTP {}（沿用 version={}，{} ms）",
                        response.code(), current.version(), System.currentTimeMillis() - t0);
                    return;
                }
                var root = mapper.readTree(response.body().string());
                long version = root.path("data").path("version").asLong(0L);
                JsonNode itemsNode = root.path("data").path("items");
                if (itemsNode.isObject()) {
                    var items = new LinkedHashMap<String, String>();
                    itemsNode.fields().forEachRemaining(e -> items.put(e.getKey(), e.getValue().asText()));
                    current = new Snapshot(version, Map.copyOf(items));
                } else {
                    // items=null（since 与版本相同）：items 沿用，仅确认版本
                    current = new Snapshot(version, current.items());
                }
                log.info("config: ok version={} keys={}（{} ms）",
                    current.version(), current.items().size(), System.currentTimeMillis() - t0);
            }
        } catch (Exception e) {
            // 拉不到用上次成功值；从未成功过用内置默认——绝不阻塞业务
            log.warn("config: 拉取异常（{}，沿用 version={}，{} ms）",
                e.getClass().getSimpleName(), current.version(), System.currentTimeMillis() - t0);
        }
    }

    /** 测试用：立即过期缓存（生产代码不调用）。 */
    synchronized void expireCache() {
        nextPullAt = 0L;
    }
}
