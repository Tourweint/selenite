package com.lifediary.harness.config;

import com.lifediary.harness.common.BusinessException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import javax.crypto.SecretKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Bearer JWT 校验（D2）：与 backend **同一把 HS256 签名密钥**，不建用户表、不连库。
 * 端点不消费 principal（信号评估是 advisory、无用户态），校验通过即放行。
 *
 * <p>fail-closed：secret 未配置/过短（&lt;32 字节，HMAC-SHA256 要求）时一切请求 403——
 * 宁可不服务也不能裸奔。无效/缺失 token 统一 403（与 backend 的 Spring Security 行为一致，
 * App 侧无需区分 harness 与 backend 的鉴权失败）。
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    /** 校验通过后把 userId 放进请求属性（端点经此取，P2 的扣额调用要用）。 */
    public static final String ATTR_USER_ID = "harness.userId";

    private static final Logger log = LoggerFactory.getLogger(JwtAuthFilter.class);

    private final HarnessProperties props;

    public JwtAuthFilter(HarnessProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        var uri = request.getRequestURI();
        var header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            log.info("auth: 缺 Authorization 头 → {}", uri);
            reject(response);
            return;
        }
        try {
            var userId = parseUserId(header.substring(7));
            request.setAttribute(ATTR_USER_ID, userId);
            log.info("auth: ok user={} → {}", userId, uri);
        } catch (Exception e) {
            log.info("auth: token 无效（{}）→ {}", e.getClass().getSimpleName(), uri);
            reject(response);
            return;
        }
        chain.doFilter(request, response);
    }

    /** 与 backend JwtService.parseUserId 同一解析口径：HS256 verify（含过期校验）+ subject = userId。 */
    private Long parseUserId(String token) {
        var claims = Jwts.parser().verifyWith(key()).build().parseSignedClaims(token).getPayload();
        return Long.valueOf(claims.getSubject());
    }

    private SecretKey key() {
        var secret = props.jwt() == null ? null : props.jwt().secret();
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            // fail-closed：密钥没配好 = 一切拒绝（抛出会在下面被吞成 403）
            throw new BusinessException(403, "jwt secret 未配置", 403);
        }
        return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
    }

    private static void reject(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
    }
}
