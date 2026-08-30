export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(entity: string): AppError {
  return new AppError(`${entity} was not found`, 404, 'NOT_FOUND');
}

export function conflict(message: string): AppError {
  return new AppError(message, 409, 'CONFLICT');
}
