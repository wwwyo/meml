export type ErrorCode =
  | "INVALID_ARGS"
  | "INVALID_PATH"
  | "NOT_INITIALIZED"
  | "ALREADY_EXISTS"
  | "FILE_NOT_FOUND"
  | "UNSUPPORTED_FILE"
  | "EMBED_SERVER_UNAVAILABLE"
  | "EMBED_FAILED"
  | "SQL_FORBIDDEN"
  | "SQL_ERROR"
  | "NOT_FOUND"
  | "IO_ERROR"
  | "INTERNAL";

// Structured, agent-parseable error. Serialized as {"error":{code,message,hint}}.
export class MemlError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "MemlError";
    this.code = code;
    this.hint = hint;
  }

  toEnvelope(): { error: { code: ErrorCode; message: string; hint?: string } } {
    return { error: { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) } };
  }
}
