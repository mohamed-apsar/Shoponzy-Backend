/* Errors safe to show to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) { return new AppError(400, "BAD_REQUEST", message, details); }
  static unauthorized(message = "Please sign in to continue.") { return new AppError(401, "UNAUTHORIZED", message); }
  static forbidden(message = "You don't have permission to do that.") { return new AppError(403, "FORBIDDEN", message); }
  static notFound(message = "Not found.") { return new AppError(404, "NOT_FOUND", message); }
  static conflict(message) { return new AppError(409, "CONFLICT", message); }
}
