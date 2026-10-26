package com.lifediary.harness;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Lifediary Harness（2026-10-25 拆分，P1）：AI 编排者——信号评估先行，P2 迁 LLM 透传、P3 上 Agent。
 *
 * <p>边界（拆分方案 D3/D6/D8，写死在架构里）：
 * <ul>
 *   <li>无状态：对话上下文由 App 每轮带来，即用即丢，不建库、不持久化、不写正文日志；</li>
 *   <li>不碰 backend 的库：账号/额度/配置全部经内部接口（X-Internal-Token）取；</li>
 *   <li>鉴权与 backend 同一套 HS256 JWT（D2），不建用户表。</li>
 * </ul>
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class HarnessApplication {

    public static void main(String[] args) {
        SpringApplication.run(HarnessApplication.class, args);
    }
}
