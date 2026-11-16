import { profileService } from '../profiles/profile.service.js';
import type { UserRegisteredPayload, ZenuxsEvent } from './types.js';

export async function handleEvent(event: ZenuxsEvent): Promise<void> {
  switch (event.type) {
    case 'auth.user.registered': {
      const data = event.data as UserRegisteredPayload;
      if (!data || !data.userId || !data.email) {
        throw new Error(
          `Invalid payload for 'auth.user.registered': missing userId or email: ${JSON.stringify(event.data)}`
        );
      }
      console.log(`[EventConsumer] Processing 'auth.user.registered' for user ${data.userId} (${data.email})`);
      const profile = await profileService.createProfileFromEvent(data.userId, data.email);
      console.log(`[EventConsumer] Profile created/verified: username=${profile.username}, userId=${profile.userId}`);
      break;
    }

    case 'auth.session.revoked': {
      // Ignored for now as per requirements, just log
      console.log(`[EventConsumer] Received 'auth.session.revoked':`, event.data);
      break;
    }

    default: {
      console.log(`[EventConsumer] Unhandled event type '${event.type}' - skipping`);
      break;
    }
  }
}
