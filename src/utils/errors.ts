import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Invalid or missing authentication token') {
    super(401, 'invalid_token', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', code: string = 'forbidden') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: string = 'not_found') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Conflict with existing resource', code: string = 'conflict') {
    super(409, code, message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request', code: string = 'bad_request') {
    super(400, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests. Please try again later.') {
    super(429, 'rate_limit_exceeded', message);
  }
}

export class SelfActionNotAllowedError extends AppError {
  constructor(message: string = 'Self action is not allowed') {
    super(400, 'self_action_not_allowed', message);
  }
}

export class EmptyMuteError extends AppError {
  constructor(message: string = 'Mute request body is empty or invalid') {
    super(400, 'empty_mute', message);
  }
}

export class InvalidUntilError extends AppError {
  constructor(message: string = 'Mute until date must be in the future') {
    super(400, 'invalid_until', message);
  }
}

export class InvalidUuidError extends AppError {
  constructor(message: string = 'Invalid user ID format') {
    super(400, 'invalid_uuid', message);
  }
}

export class InvalidInternalTokenError extends AppError {
  constructor(message: string = 'Invalid or missing internal token') {
    super(401, 'invalid_internal_token', message);
  }
}

export class InternalNotConfiguredError extends AppError {
  constructor(message: string = 'Internal service token not configured') {
    super(503, 'internal_not_configured', message);
  }
}

export function fastifyErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // App-specific operational errors
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  // Zod validation errors
  if (error instanceof ZodError) {
    const message = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join(', ');
    return reply.status(400).send({
      error: {
        code: 'validation_error',
        message,
      },
    });
  }

  // Fastify schema validation errors
  if ('validation' in error && error.validation) {
    return reply.status(400).send({
      error: {
        code: 'validation_error',
        message: error.message,
      },
    });
  }

  // Fastify standard 404 or 400
  const statusCode = (error as FastifyError).statusCode || 500;
  if (statusCode === 404) {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    });
  }

  if (statusCode === 400) {
    return reply.status(400).send({
      error: {
        code: 'bad_request',
        message: error.message || 'Bad request',
      },
    });
  }

  if (statusCode === 429) {
    return reply.status(429).send({
      error: {
        code: 'rate_limit_exceeded',
        message: error.message || 'Too many requests',
      },
    });
  }

  // Unhandled / server errors - never expose stack trace or internal message to client
  request.log.error(error, 'Unhandled error processing request');
  return reply.status(500).send({
    error: {
      code: 'internal_server_error',
      message: 'An unexpected error occurred',
    },
  });
}
