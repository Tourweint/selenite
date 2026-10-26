package com.lifediary.harness.signal;

import com.lifediary.harness.common.ApiResponse;
import com.lifediary.harness.common.IpRateLimitGuard;
import com.lifediary.harness.signal.SessionSignalService.Message;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 会话信号端点（路径 B / Jev；**契约与 backend 逐字一致**，接口文档 §7.1 / §7.3：
 * 并存期间两端行为必须一致，否则"切回去就不一样"）。
 *
 * - JWT 由 {@link com.lifediary.harness.config.JwtAuthFilter} 校验（与 backend 同密钥，无效 403）；
 * - 自带 IP 频控（backend 的闸门只护它的 /auth/**，本端点不得裸奔）；
 * - **advisory 不门控**：结果只供客户端决定是否浮现收尾提示，错误/无信号=回落本地评估；
 * - **不落盘**：请求内容即取即转（与 LLM 透传同一隐私口径），也不计额度（非 LLM 调用）；
 * - 上限保护：30 条 × 每条 2000 字，超出截断。
 */
@RestController
@RequestMapping("/api/v1")
public class SignalController {

    private final SessionSignalService service;
    private final IpRateLimitGuard guard;

    public SignalController(SessionSignalService service, IpRateLimitGuard guard) {
        this.service = service;
        this.guard = guard;
    }

    public record Message(String role, String text) {}

    public record SessionSignalRequest(List<Message> messages, String today) {}

    public record SessionSignalResponse(
        boolean available,
        String sessionState,
        String engagement,
        String emotion,
        double endingIntent,
        double confidence
    ) {}

    @PostMapping("/signal/session")
    public ApiResponse<SessionSignalResponse> session(
        HttpServletRequest request,
        @RequestBody SessionSignalRequest body
    ) {
        return guard.guard(IpRateLimitGuard.Bucket.SIGNAL, request, () -> doEvaluate(body));
    }

    private ApiResponse<SessionSignalResponse> doEvaluate(SessionSignalRequest request) {
        var input = request.messages() == null ? List.<Message>of() : request.messages();
        var bounded = input
            .stream()
            .limit(30)
            .map(m -> new SessionSignalService.Message(
                m.role() == null ? "user" : m.role(),
                m.text() == null ? "" : m.text().substring(0, Math.min(m.text().length(), 2000))))
            .toList();
        var signal = service.evaluate(bounded, request.today() == null ? "" : request.today());
        return ApiResponse.ok(new SessionSignalResponse(
            signal.available(),
            signal.sessionState(),
            signal.engagement(),
            signal.emotion(),
            signal.endingIntent(),
            signal.confidence()));
    }
}
