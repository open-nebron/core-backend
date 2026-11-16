export interface UserRegisteredPayload {
  userId: string;
  email: string;
}

export interface SessionRevokedPayload {
  userId?: string;
  sessionId?: string;
}

export type ZenuxsEventType = 'auth.user.registered' | 'auth.session.revoked' | string;

export interface ZenuxsEvent<T = any> {
  id?: string;
  type: ZenuxsEventType;
  data: T;
  timestamp?: string;
}
