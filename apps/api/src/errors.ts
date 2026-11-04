export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400,
    public readonly parameters?: Record<string, string | number>,
  ) {
    super(code);
  }
}

export function validation(parameters?: Record<string, string | number>): never {
  throw new AppError('VALIDATION_ERROR', 400, parameters);
}
