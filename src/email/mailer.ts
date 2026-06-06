import nodemailer from "nodemailer";
import { config } from "@/config";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.port === 465,
      auth: {
        user: config.email.smtp.user,
        pass: config.email.smtp.pass,
      },
    });
  }
  return transporter;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  await getTransporter().sendMail({
    from: config.email.from || config.email.smtp.user,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}
