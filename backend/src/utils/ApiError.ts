export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
    Object.setPrototypeOf(this, ApiError.prototype);
  }
  static badRequest(msg: string, details?: unknown) { return new ApiError(400, msg, details); }
  static unauthorized(msg = 'Unauthorized') { return new ApiError(401, msg); }
  static forbidden(msg = 'Forbidden: insufficient role') { return new ApiError(403, msg); }
  static notFound(msg = 'Resource not found') { return new ApiError(404, msg); }
  static conflict(msg: string) { return new ApiError(409, msg); }
  static serviceUnavailable(msg: string) { return new ApiError(503, msg); }
}
