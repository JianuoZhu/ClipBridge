# Security model

Jianuo Clip is designed for a single owner and a small set of trusted devices.

- The public server forwards raw TCP on ports 80 and 443. It does not terminate
  TLS, receive the Clip password, or store Clip data.
- Caddy on the home computer terminates HTTPS and obtains the certificate.
- WireGuard encrypts the server-to-home hop and authenticates both machines.
- The application uses a Secure, HttpOnly, SameSite=Strict session cookie.
- State-changing requests require a custom request header and same-origin
  validation. Login attempts are rate limited.
- Uploaded files are stored outside the web root under random names and are
  always downloaded as attachments.
- Text and file bytes are stored in plaintext on the home computer. Use
  full-disk encryption if theft of that computer is in scope.

This first release uses one shared account rather than per-device identities.
Changing CLIP_PASSWORD invalidates future logins but does not delete existing
sessions immediately. To revoke all sessions, stop the app and remove the
sessions rows from data/clip.db, or replace the database while preserving the
blobs through a controlled migration.

Never commit .env, WireGuard private keys, or the preshared key.
