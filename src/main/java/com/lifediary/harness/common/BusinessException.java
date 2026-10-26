package com.lifediary.harness.common;

/** 业务异常：code 进 ApiResponse.code；httpStatus 允许特殊场景用真实状态码（如频控 429）。 */
public class BusinessException extends RuntimeException {

    private final int code;
    private final int httpStatus;

    public BusinessException(int code, String message) {
        this(code, message, 200);
    }

    public BusinessException(int code, String message, int httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public int getCode() {
        return code;
    }

    public int getHttpStatus() {
        return httpStatus;
    }
}
