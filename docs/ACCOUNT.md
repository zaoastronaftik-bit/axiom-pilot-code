# Optional account contract and live acceptance

Source contract was read from the website repository at 48b141c5b9ca83e017228a5bdb2f98936bf1c6b8. Local inference/editing is never gated by plan/account. This work does not deploy a database or API. The website's api-config.js currently has no deployed origin.

| Request | Required behavior |
| --- | --- |
| POST /api/device?action=start `{}` | deviceCode, userCode, verificationUri, expiresIn, interval; CLI displays code |
| POST /api/device?action=poll `{deviceCode}` | HTTP 202 `{status:"pending"}` or authorized status + `axiom_cli_...` accessToken |
| POST /api/device?action=approve | Browser-only authenticated explicit approval; CLI never calls it |
| GET /api/cli, Bearer token | Validates server token, returns authenticated, plan, userId, tokenId |
| POST /api/cli?action=revoke `{}`, Bearer token | Companion additive endpoint: revoke exactly the credential used; idempotent |
| GET /api/tokens, browser account session | Companion additive endpoint: list this user's IDs/timestamps only, never plaintext/hash tokens |
| POST /api/tokens?action=revoke `{tokenId}`, browser session | Companion additive endpoint: ownership-scoped revocation, foreign/missing ID → 404 |

CLI waits at least the advertised interval, enforces a maximum ten-minute authorization window, aborts on cancellation and never creates a local token without a genuine authorized response. Opening verificationUri requires separate consent. Redirects for API requests are forbidden. Credentials use DPAPI CurrentUser encryption on Windows or Secret Service on Linux; unsupported platforms fail closed. Server hashes CLI tokens and already expires them after 90 days. New revocation routes use the existing revoked_at column; the browser account view uses textContent for metadata.

With an owner-provided live HTTPS origin and test accounts, perform and record:

1. `pilotcode login --api-url https://DEPLOYED_ORIGIN`; read code, approve browser opening or navigate manually. Before approval, polling must remain pending; local tools must work without login.
2. Sign in and explicitly approve the displayed code on the website. `pilotcode whoami --api-url ...` must show the real user/plan; check OS-protected storage with no token in project/config/logs.
3. Repeat expiry, cancellation, declined browser opening, unreachable API and persistence across CLI restart. Confirm cadence from server logs without printing device/token secrets.
4. `pilotcode logout --api-url ...`; check that the former credential now fails GET /api/cli. If server is unavailable, logout fails visibly. `logout --local-only` explicitly removes only local credentials and warns revocation did not happen.
5. Log in again, revoke from the account page, verify CLI loses authorization. From a second account attempt to revoke the first account's token ID; expect 404 and unchanged first token. These checks require real DB state; mocked SQL unit tests are insufficient.

No live account acceptance was possible in this environment. Browser/OS credential integration and database-backed multi-user behavior must pass before account integration is declared ready.
