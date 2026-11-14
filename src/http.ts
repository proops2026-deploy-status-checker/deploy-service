import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

// Shared HTTP plumbing: request IDs, one JSON error envelope, 404 handler.
// Envelope: { "error": { "code": "UPPER_SNAKE", "message": "...", "details"?: [...] } }

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Keeps the gateway's x-request-id (or makes one) so log lines can be correlated across services. */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header("x-request-id");
  const id = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader("x-request-id", id);
  next();
};

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` } });
};

interface BodyParserError {
  type?: string;
  status?: number;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    return;
  }

  const parserError = err as BodyParserError;
  if (parserError.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    return;
  }
  if (parserError.type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } });
    return;
  }
  if (typeof parserError.status === "number" && parserError.status >= 400 && parserError.status < 500) {
    res.status(parserError.status).json({ error: { code: "BAD_REQUEST", message: "Bad request" } });
    return;
  }

  // Unexpected: log the detail server-side, never return a stack trace to the client.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled error",
      request_id: res.locals.requestId,
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    })
  );
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
};
