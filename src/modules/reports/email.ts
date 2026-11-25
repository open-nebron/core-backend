import { env } from '../../config/env.js';

export interface ReportEmailPayload {
  reportId: string;
  reporterId: string;
  targetType: string;
  targetId: string;
  reason: string;
  details?: string;
  createdAt: Date;
}

export async function sendAdminReportNotification(payload: ReportEmailPayload): Promise<void> {
  if (env.DECISION_REPORTS_NOTIFY !== 'email') {
    return;
  }

  const recipient = env.ADMIN_NOTIFICATION_EMAIL || 'admin@nebron.com';
  const subject = `[Nebron Moderation] New Report: ${payload.targetType} reported for ${payload.reason}`;
  const text = `
A new report has been submitted on Nebron.

Report ID: ${payload.reportId}
Target Type: ${payload.targetType}
Target ID: ${payload.targetId}
Reporter ID: ${payload.reporterId}
Reason: ${payload.reason}
Details: ${payload.details || '(none provided)'}
Submitted At: ${payload.createdAt.toISOString()}

Please review this report in the Admin Dashboard.
`;

  if (env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'moderation@nebron.com',
          to: recipient,
          subject,
          text,
        }),
      });
    } catch (err: any) {
      console.error('[Reports Email] Failed to send email via Resend:', err.message);
    }
  } else {
    // When no RESEND_API_KEY (e.g. local dev / test), log notification cleanly
    console.log(`[Reports Email] Notification for ${payload.reportId} dispatched to ${recipient}`);
  }
}
