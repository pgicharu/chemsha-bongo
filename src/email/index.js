// Outgoing email; all sends go through sendEmail(). EMAIL_TRANSPORT is `log`
// (links written to logs, nothing sent) or `smtp` (nodemailer).

import nodemailer from 'nodemailer';
import { SpanKind } from '@opentelemetry/api';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { emailsSentTotal } from '../metrics.js';
import { inSpan } from '../spans.js';
import { smtpBlackholeAddress } from '../chaos/smtp-blackhole.js';

const TRANSPORTS = ['log', 'smtp'];
if (!TRANSPORTS.includes(config.email.transport)) {
  throw new Error(`EMAIL_TRANSPORT must be one of: ${TRANSPORTS.join(', ')}`);
}

function createSmtpTransport({ host, port }) {
  return nodemailer.createTransport({
    host,
    port,
    secure: config.email.smtp.secure,
    auth: config.email.smtp.user ? { user: config.email.smtp.user, pass: config.email.smtp.pass } : undefined,
    // Turn a hung provider into an error instead of a request stuck for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

const smtpTransport = config.email.transport === 'smtp' ? createSmtpTransport(config.email.smtp) : null;

// Resolves once handed to the provider, throws otherwise. `template` labels
// logs and metrics; recipient addresses are never logged.
export async function sendEmail({ to, template, subject, text, html }) {
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);

  // Fault injection: the email-down switch routes sends to a silent SMTP server.
  const blackhole = smtpBlackholeAddress();
  const transport = blackhole ? createSmtpTransport(blackhole) : smtpTransport;

  if (!transport) {
    // Development only: logged links grant account access. The only place a link may be logged.
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    logger.info({ event: 'email.logged', template, links }, `Email not sent (EMAIL_TRANSPORT=log): ${template}`);
    emailsSentTotal.labels(template, 'logged').inc();
    return;
  }

  try {
    // Names the configured SMTP_HOST, even while the email-down switch is on.
    const { host, port } = config.email.smtp;
    await inSpan(
      'smtp.send',
      { 'server.address': host, 'server.port': port, 'email.template': template },
      async () => {
        try {
          return await transport.sendMail({ from: config.email.from, to, subject, text, html });
        } catch (err) {
          // The span records the error, so pass it a redacted copy.
          throw redactedError(err);
        }
      },
      { kind: SpanKind.CLIENT },
    );
    logger.info({ event: 'email.sent', template, duration_ms: elapsedMs() }, `Email sent: ${template}`);
    emailsSentTotal.labels(template, 'sent').inc();
  } catch (err) {
    emailsSentTotal.labels(template, 'failed').inc();
    logger.error(
      { event: 'email.failed', template, duration_ms: elapsedMs(), smtp_error: describeError(err) },
      `Email failed: ${template}`,
    );
    throw err;
  }
}

// SMTP replies and nodemailer errors can contain recipient addresses, so only
// selected fields are logged, with addresses blanked.
const redact = (value) => (typeof value === 'string' ? value.replace(/\S+@\S+/g, '[email]') : value);

function describeError(err) {
  return {
    message: redact(err.message),
    code: err.code,
    command: err.command,
    response_code: err.responseCode,
  };
}

function redactedError(err) {
  const safe = new Error(redact(err.message));
  Object.assign(safe, { code: err.code, command: err.command, responseCode: err.responseCode });
  return safe;
}
