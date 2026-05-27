# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory.

This keeps the report confidential until a fix is released. Please don't open a public issue for security vulnerabilities.

## Supported Versions

This project is actively maintained. Security fixes are applied to the latest version on `main` only.

## Security Updates

### 2026-05-26

- v1.0.0: Initial release. Security controls: Google OAuth domain + audience check,
  per-user OAuth passthrough (no service account), structured audit log, bulk-operation
  Slack alerting, 60 req/min per-user rate limit, `/register` origin check,
  `npm audit` build gate, non-root Docker container.
