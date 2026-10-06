import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { ApiError } from './ApiError';

const transporter = env.mail.host
  ? nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.password } : undefined,
    })
  : null;

export async function sendPasswordResetOtp(to: string, otp: string) {
  if (!transporter || !env.mail.from) {
    throw ApiError.serviceUnavailable('Password reset email service is not configured. Add SMTP_HOST and MAIL_FROM to the backend environment.');
  }
  await transporter.sendMail({
    from: env.mail.from,
    to,
    subject: 'Trip Fly BD password reset code',
    text: `Your Trip Fly BD password reset code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your Trip Fly BD password reset code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>`,
  });
}

/** True when SMTP is configured. Callers use it to skip rather than fail. */
export const mailConfigured = (): boolean => Boolean(transporter && env.mail.from);

/**
 * A plain notification email — approval requests, BDR decisions.
 *
 * Separate from sendPasswordResetOtp because that one is a security path with
 * fixed wording; this one carries whatever the workflow needs to say.
 */
export async function sendNotificationMail(to: string, subject: string, body: string): Promise<void> {
  if (!transporter || !env.mail.from)
    throw ApiError.serviceUnavailable('Email is not configured.');
  await transporter.sendMail({
    from: env.mail.from, to, subject, text: body,
    html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${
      body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>`,
  });
}
