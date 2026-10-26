package com.lifediary.harness.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用配置（全部经环境变量注入，密钥不入仓、不入库——与 backend 同纪律）。
 *
 * <p>与 backend 的分工：上游 key 与出口代理**只走环境变量**（密钥绝不入库、绝不进 ai-config 下发，
 * 沿用 backend 后台规划 §2.3 口径）；backend 的 `/internal/ai-config`（§9.2）只承载**非秘密**
 * 的 `ai.*` 策略参数，由 {@link com.lifediary.harness.ai.AiConfigPuller} 拉取。
 */
@ConfigurationProperties(prefix = "app")
public record HarnessProperties(
    Jwt jwt,
    Signal signal,
    Backend backend,
    RateLimit rateLimit,
    Llm llm
) {

    /** 与 backend 共用的 HS256 签名密钥（D2）：同源注入，换密钥必须两端同时换。 */
    public record Jwt(String secret) {}

    /** 上游 OpenAI 兼容端点与**本服务持有的 key**（环境变量注入，不入仓不入库）；model 非空时覆盖请求体（调优归服务端）。 */
    public record Llm(String baseUrl, String apiKey, String model) {}

    /**
     * TypeSafe Jev 上游（路径 B，2026-10-22）：advisory 信号评估，不落盘、不计额度。
     * key/url/model/proxy 全部环境变量；typesafeProxy 为 451 区域封锁的出口代理解法
     * （socks5://host:port 或 http://host:port，留空直连）。
     */
    public record Signal(
        boolean jevEnabled,
        String typesafeKey,
        String typesafeUrl,
        String typesafeModel,
        String typesafeProxy
    ) {}

    /** backend 内部接口（接口文档 §9）：ai-config 拉取用；internalToken = backend 的 INTERNAL_TOKEN。 */
    public record Backend(String internalBaseUrl, String internalToken) {}

    /**
     * 自带防滥用闸门（拆分方案 §9）：按来源 IP 的频次（信号评估/分钟）+ 并发上限。
     * 不因为"打的是 AI 通道"就免闸（接口文档 §8 拆分后的闸门分工）。
     */
    public record RateLimit(boolean enabled, int signalPerMinute, int maxConcurrent) {}
}
