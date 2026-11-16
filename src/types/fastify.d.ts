import 'fastify';

export interface AuthUser {
  userId: string;
  email: string;
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}
