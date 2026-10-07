/** 业务错误：携带稳定错误码与 HTTP 状态，供 API 与 CLI 共用。 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ERROR_CODES = {
  VALIDATION: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL: "INTERNAL_ERROR",
} as const;

export function notFound(what: string): never {
  throw new AppError(ERROR_CODES.NOT_FOUND, `${what}不存在`, 404);
}
