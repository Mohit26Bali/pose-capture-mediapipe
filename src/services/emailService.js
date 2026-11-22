const nodemailer = require('nodemailer');
const config = require('../config/env');

function createTransport() {
  if (!config.email.host || !config.email.user || !config.email.password) {
    return null;
  }
  return nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.password },
  });
}

/**
 * Sends the backup notification email.
 * If the zip is small enough it is attached; otherwise only a local path/note is sent.
 * Returns { sent: boolean, reason?: string }
 */
async function sendBackupEmail({ date, zipPath, zipSizeBytes, attach }) {
  const transporter = createTransport();
  if (!transporter) {
    return { sent: false, reason: 'Email not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASSWORD)' };
  }

  const subject = `Daily DB Backup - ${date}`;
  const sizeMb = (zipSizeBytes / (1024 * 1024)).toFixed(2);

  let text;
  if (attach) {
    text = `The daily backup for ${date} completed successfully.\n\nThe backup ZIP (${sizeMb} MB) is attached to this email.`;
  } else if (!config.email.attachBackup) {
    text = `The daily backup for ${date} completed successfully (${sizeMb} MB). It is not attached because EMAIL_ATTACH_BACKUP is off. It is on the server at:\n${zipPath}`;
  } else {
    text = `The daily backup for ${date} completed successfully.\n\nThe backup ZIP (${sizeMb} MB) exceeded the email attachment size limit, so it was not attached. It is available on the server at:\n${zipPath}`;
  }

  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject,
    text,
    attachments: attach ? [{ filename: zipPath.split(/[\\/]/).pop(), path: zipPath }] : [],
  };

  await transporter.sendMail(mailOptions);
  return { sent: true };
}

/**
 * Sends a best-effort alert when the backup pipeline itself fails (dump/zip
 * step, not just the notification email). Never throws - a failure here
 * must not mask the original backup error.
 * Returns { sent: boolean, reason?: string }
 */
async function sendBackupFailureEmail({ date, errorMessage }) {
  try {
    const transporter = createTransport();
    if (!transporter) {
      return { sent: false, reason: 'Email not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASSWORD)' };
    }

    await transporter.sendMail({
      from: config.email.from,
      to: config.email.to,
      subject: `Daily DB Backup FAILED - ${date}`,
      text: `The daily backup for ${date} did not complete successfully.\n\nError:\n${errorMessage}\n\nCheck the server logs / run "npm run backup" manually to investigate.`,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendBackupEmail, sendBackupFailureEmail, createTransport };
