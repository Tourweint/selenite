package com.lifediary.harness.common;

/**
 * 统一返回结构（与 backend 完全一致：{code, message, data}；成功 code = 0）。
 * harness 的响应体要与 backend 逐字段一致（接口文档 §7.3：并存期间"切回去就不一样"是事故）。
 */
public record ApiResponse<T>(int code, String message, T data) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(0, "ok", data);
    }

    public static ApiResponse<Void> ok() {
        return new ApiResponse<>(0, "ok", null);
    }

    public static <T> ApiResponse<T> error(int code, String message) {
        return new ApiResponse<>(code, message, null);
    }
}
