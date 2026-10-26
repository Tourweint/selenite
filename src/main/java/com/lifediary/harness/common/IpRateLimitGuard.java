package com.lifediary.harness.common;

import com.lifediary.harness.config.HarnessProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * 按来源 IP 的**频次 + 并发**闸门（与 backend 的 IpRateLimitGuard 等价移植，拆分方案 §9：
 * "harness 侧必须自带等价频控，否则拆分后等于裸奔"）。
 *
 * <p>P1 只有一个桶：SIGNAL（信号评估/分钟 + 并发上限）。口径从宽，目标是挡脚本。
 * 已知限制与 backend 相同：内存实现、单实例有效；按 IP 聚合在 NAT 下误伤同网多人；
 * 反向代理后面要开 server.forward-headers-strategy 并评估 XFF 伪造风险。
 */
@Component
public class IpRateLimitGuard {

    /** 受闸的端点桶。 */
    public enum Bucket {
        SIGNAL
    }

    private static final long MINUTE_MILLIS = 60_000L;

    /** 计数表兜底容量：超过就整体清空，避免伪造海量源 IP 把内存撑爆。 */
    private static final int MAX_TRACKED_KEYS = 50_000;

    private final HarnessProperties props;
    /** key = 桶|IP → 窗口内的命中时刻。 */
    private final Map<String, Deque<Long>> hits = new ConcurrentHashMap<>();
    /** key = 桶|IP → 并发许可。 */
    private final Map<String, Semaphore> gates = new ConcurrentHashMap<>();

    public IpRateLimitGuard(HarnessProperties props) {
        this.props = props;
    }

    /** 过闸执行：超频次或超并发抛 4290。 */
    public <T> T guard(Bucket bucket, HttpServletRequest request, Supplier<T> action) {
        if (props.rateLimit() == null || !props.rateLimit().enabled()) {
            return action.get();
        }
        var ip = request.getRemoteAddr();
        var gate = gates.computeIfAbsent(bucket + "|" + ip,
            key -> new Semaphore(props.rateLimit().maxConcurrent()));
        if (!gate.tryAcquire()) {
            throw tooFrequent();
        }
        try {
            checkFrequency(bucket, ip);
            return action.get();
        } finally {
            gate.release();
        }
    }

    private void checkFrequency(Bucket bucket, String ip) {
        var now = System.currentTimeMillis();
        if (hits.size() > MAX_TRACKED_KEYS) {
            hits.clear();
        }
        var window = hits.computeIfAbsent(bucket + "|" + ip, key -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && now - window.peekFirst() > windowMillisOf(bucket)) {
                window.pollFirst();
            }
            if (window.size() >= limitOf(bucket)) {
                throw tooFrequent();
            }
            window.addLast(now);
        }
    }

    private long windowMillisOf(Bucket bucket) {
        return MINUTE_MILLIS;
    }

    private int limitOf(Bucket bucket) {
        return props.rateLimit().signalPerMinute();
    }

    /** 统一一句，不加解释性文案（与 backend 同口径）。 */
    private BusinessException tooFrequent() {
        return new BusinessException(4290, "操作太频繁了，稍等一会儿再试", 429);
    }
}
