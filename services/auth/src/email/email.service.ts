import { Injectable, Optional, Inject } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AuthDatabase } from '../store/database.js';
import { loadAuthConfig, type AuthConfig, AUTH_CONFIG } from '../config.js';
import { logger } from '@streamlite/logger';

export { AUTH_CONFIG };

export interface EmailPayload {
  userId: string;
  email: string;
  token?: string;
  kind?: string;
}

@Injectable()
export class EmailService {
  private readonly transporter: Transporter;
  private readonly config: AuthConfig;

  constructor(@Optional() @Inject(AUTH_CONFIG) config?: AuthConfig) {
    this.config = config ?? loadAuthConfig();
    this.transporter = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: false,
      auth: this.config.smtpUser
        ? {
            user: this.config.smtpUser,
            pass: this.config.smtpPass ?? '',
          }
        : undefined,
    });
  }

  get transporterInstance(): Transporter {
    return this.transporter;
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const verifyUrl = `http://localhost:8080/auth/verify?token=${token}`;
    await this.transporter.sendMail({
      from: this.config.emailFrom,
      to,
      subject: 'Verify your StreamLite Account',
      text: `Welcome to StreamLite! Please verify your email by opening this link: ${verifyUrl}`,
      html: `
        <h2>Welcome to StreamLite!</h2>
        <p>Please verify your email address to activate your account:</p>
        <p><a href="${verifyUrl}">Verify My Email</a></p>
        <p><small>Link expires in 24 hours.</small></p>
      `,
    });
    logger.info({ to }, 'Dispatched verification email');
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const resetUrl = `http://localhost:8080/auth/reset-password?token=${token}`;
    await this.transporter.sendMail({
      from: this.config.emailFrom,
      to,
      subject: 'Reset your StreamLite Password',
      text: `A password reset was requested for your StreamLite account. Reset it here: ${resetUrl}. Link expires in 30 minutes.`,
      html: `
        <h2>StreamLite Password Reset</h2>
        <p>A password reset was requested for your account. Click below to choose a new password:</p>
        <p><a href="${resetUrl}">Reset Password</a></p>
        <p><small>This link expires in 30 minutes. If you did not request this, please ignore this email.</small></p>
      `,
    });
    logger.info({ to }, 'Dispatched password reset email');
  }

  async sendPasswordChangedAlert(to: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.emailFrom,
      to,
      subject: 'Security Alert: Your StreamLite password was changed',
      text: 'The password for your StreamLite account was recently changed. All active sessions have been terminated. If this was not you, please contact security immediately.',
      html: `
        <h2>Security Alert: Password Changed</h2>
        <p>The password for your StreamLite account was recently changed.</p>
        <p>All active sessions have been logged out as a security precaution.</p>
        <p>If you did not make this change, please reset your password immediately.</p>
      `,
    });
    logger.info({ to }, 'Dispatched password change security notice');
  }

  /**
   * Processes unsent email notifications from the outbox table and delivers them via SMTP.
   * Emulates background outbox relay in tests and background execution.
   */
  async processOutboxBatch(db: AuthDatabase, limit = 10): Promise<number> {
    const pendingEvents = await db
      .selectFrom('outbox')
      .selectAll()
      .where('topic', 'in', [
        'auth.user.registered',
        'auth.email.verification',
        'auth.email.reset_password',
        'auth.email.password_changed',
      ])
      .where('sent_at', 'is', null)
      .limit(limit)
      .execute();

    let processed = 0;

    for (const event of pendingEvents) {
      const payload = event.payload as unknown as EmailPayload;
      if (!payload?.email) {
        continue;
      }

      try {
        switch (event.topic) {
          case 'auth.user.registered':
          case 'auth.email.verification':
            if (payload.token) {
              await this.sendVerificationEmail(payload.email, payload.token);
            }
            break;
          case 'auth.email.reset_password':
            if (payload.token) {
              await this.sendPasswordResetEmail(payload.email, payload.token);
            }
            break;
          case 'auth.email.password_changed':
            await this.sendPasswordChangedAlert(payload.email);
            break;
        }

        // Mark event sent in outbox
        await db
          .updateTable('outbox')
          .set({ sent_at: new Date() })
          .where('id', '=', event.id)
          .execute();

        processed++;
      } catch (err) {
        logger.error({ err, eventId: event.id }, 'Failed to deliver outbox email via SMTP');
      }
    }

    return processed;
  }
}
