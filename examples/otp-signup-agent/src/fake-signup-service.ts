import nodemailer from 'nodemailer';

export const SIGNUP_SERVICE_ADDRESS = 'Auth Service <noreply@auth.example.com>';
export const SIGNUP_SERVICE_SENDER = 'noreply@auth.example.com';

export interface FakeSignupService {
  /** Emails a 6-digit code to `email` over SMTP, exactly like a real external sender would. */
  signup(email: string): Promise<string>;
  verify(code: string): boolean;
}

/** In-process stand-in for a signup backend — example-only, never used by the real API/SDK. */
export function createFakeSignupService(smtpUrl = 'smtp://127.0.0.1:2525'): FakeSignupService {
  const url = new URL(smtpUrl);
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: Number(url.port),
    secure: false,
    ignoreTLS: true,
  });
  let issuedCode: string | null = null;

  return {
    async signup(email: string): Promise<string> {
      const code = String(Math.floor(100_000 + Math.random() * 900_000));
      issuedCode = code;
      await transporter.sendMail({
        from: SIGNUP_SERVICE_ADDRESS,
        to: email,
        subject: `Your verification code is ${code}`,
        text: `Your one-time verification code is ${code}. It expires in 10 minutes.\nDo not share this code with anyone.`,
      });
      return code;
    },
    verify(code: string): boolean {
      return issuedCode !== null && code === issuedCode;
    },
  };
}
