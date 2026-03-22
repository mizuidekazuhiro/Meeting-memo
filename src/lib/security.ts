import { HttpError } from './http';

export function requireWebhookSecret(request: Request, expectedSecret: string): void {
  const provided = request.headers.get('x-webhook-secret') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!provided || provided !== expectedSecret) {
    throw new HttpError('Unauthorized webhook request.', 401);
  }
}
