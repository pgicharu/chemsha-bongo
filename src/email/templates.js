// Email templates. Each returns { template, subject, text, html } for sendEmail().
// HTML uses inline styles because email clients ignore stylesheets.

const APP_NAME = 'Chemsha Bongo';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({ paragraphs, buttonLabel, link, footer }) {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#141414;">${p}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px 12px;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:3px solid #141414;border-radius:8px;padding:24px;">
      <p style="margin:0 0 24px;font-size:24px;font-weight:bold;color:#141414;">${APP_NAME}</p>
      ${body}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;padding:14px 24px;background:#ff2e88;color:#141414;border:3px solid #141414;border-radius:8px;font-size:18px;font-weight:bold;text-decoration:none;">
          ${buttonLabel}
        </a>
      </p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#444444;">
        If the button doesn't work, copy this link into your browser:<br />
        <a href="${escapeHtml(link)}" style="color:#141414;word-break:break-all;">${escapeHtml(link)}</a>
      </p>
      <p style="margin:0;font-size:14px;line-height:1.5;color:#444444;">${footer}</p>
    </div>
  </body>
</html>`;
}

export function confirmEmail({ name, link }) {
  return {
    template: 'confirm',
    subject: `Welcome to ${APP_NAME}! Please confirm your email`,
    text: [
      `Hi ${name},`,
      '',
      `Welcome to ${APP_NAME}! Please confirm your email address so you can create quizzes and have your scores saved:`,
      '',
      link,
      '',
      'This link works for 48 hours.',
      "If you didn't sign up, you can ignore this email.",
    ].join('\n'),
    html: layout({
      paragraphs: [
        `Hi ${escapeHtml(name)},`,
        `Welcome to ${APP_NAME}! Please confirm your email address so you can create quizzes and have your scores saved.`,
      ],
      buttonLabel: 'Confirm my email',
      link,
      footer: "This link works for 48 hours. If you didn't sign up, you can ignore this email.",
    }),
  };
}

export function resetEmail({ name, link }) {
  return {
    template: 'reset',
    subject: `Reset your ${APP_NAME} password`,
    text: [
      `Hi ${name},`,
      '',
      'Someone (hopefully you) asked to reset your password. Choose a new one here:',
      '',
      link,
      '',
      'This link works for 1 hour and only once.',
      "If you didn't ask for this, ignore this email: your password stays the same.",
    ].join('\n'),
    html: layout({
      paragraphs: [
        `Hi ${escapeHtml(name)},`,
        'Someone (hopefully you) asked to reset your password. Choose a new one with the button below.',
      ],
      buttonLabel: 'Choose a new password',
      link,
      footer: "This link works for 1 hour and only once. If you didn't ask for this, ignore this email: your password stays the same.",
    }),
  };
}
