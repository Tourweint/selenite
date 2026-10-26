package com.lifediary.harness.llm;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * 服务端模型覆盖（对照 backend 同名类逐行迁移，2026-10-21 口径随迁）：
 *
 * - 客户端把模型名写死在 APK 里，换模型要发版；服务端在转发前覆盖 model 字段后，
 *   换模型/灰度只改 LLM_MODEL（P2 起 ai-config 可接管，环境变量是兜底默认）；
 * - 配置为空 = 原样透传；请求体不是 JSON 对象 = 原样透传（上游自会报它自己的错）；
 * - **隐私边界**：改写只发生在内存里的转发路径上，不落盘。
 */
public final class ModelOverride {

    private ModelOverride() {}

    public static String apply(ObjectMapper mapper, String body, String configuredModel) {
        if (configuredModel == null || configuredModel.isBlank()) {
            return body;
        }
        try {
            if (mapper.readTree(body) instanceof ObjectNode obj) {
                obj.put("model", configuredModel.trim());
                return mapper.writeValueAsString(obj);
            }
            return body;
        } catch (JsonProcessingException e) {
            return body;
        }
    }
}
