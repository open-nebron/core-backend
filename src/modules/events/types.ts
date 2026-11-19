export interface UserRegisteredPayload {
  userId: string;
  email: string;
}

export interface SessionRevokedPayload {
  userId?: string;
  sessionId?: string;
}

export type NebronEventType = 'auth.user.registered' | 'auth.session.revoked' | string;

export interface NebronEvent<T = any> {
  id?: string;
  type: NebronEventType;
  data: T;
  timestamp?: string;
}
