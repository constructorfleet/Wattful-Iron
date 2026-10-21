# User accounts, roles, and sessions

User accounts are **opt-in**. Set `AUTH_MODE=users` to enable them. Without it the
workbench behaves exactly as before: open when no token is configured, or gated by the
shared `WORKBENCH_AUTH_TOKEN`. Enabling accounts is what turns [review
states](review.md) from an audit trail into an authorization boundary.

## Roles

| Capability | viewer | engineer | owner |
| --- | --- | --- | --- |
| Read projects, previews, checks, history | yes | yes | yes |
| Edit source, build, restore, record validated/reviewed | — | yes | yes |
| Approve a revision for manufacturing | — | — | yes |
| Manage user accounts | — | — | yes |
| Delete a project | — | — | yes |

Approving, account management, and project deletion are owner-only because each is
consequential and hard to undo. Every refusal returns HTTP 403 naming the role and the
operation, so an agent or a user can see why it stopped.

MCP keeps its own bearer token and its existing limits: agents may record `validated` and
`reviewed`, never approve a revision or reopen an approved one.

## First owner

With accounts enabled and no users yet, set `INITIAL_OWNER_EMAIL` and
`INITIAL_OWNER_PASSWORD` (optionally `INITIAL_OWNER_NAME`); the owner is created at
startup. Remove those variables afterwards. Passwords must be at least 12 characters.

Owners manage everyone else over REST:

```sh
curl -X POST http://127.0.0.1:3000/api/auth/users \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -b cookies.txt \
  -d '{"email":"engineer@example.com","password":"a long passphrase","role":"engineer"}'
```

- `GET /api/auth/users` lists accounts, `POST` creates one, `PATCH /api/auth/users/:id`
  changes role, display name, password, or disabled state, and `DELETE` removes one.
- The last enabled owner cannot be demoted, disabled, or deleted, so an instance can never
  lock everyone out, and an owner cannot delete their own account.
- A password change or a disable bumps the account's token version, which invalidates every
  session that account already holds.

There is no account-management screen yet: the browser offers sign-in, the current account,
and sign-out, and owners use the endpoints above. That screen is the obvious follow-up.

## Sessions

Sign-in sets two cookies: an `HttpOnly`, `SameSite=Lax` session cookie holding an
HMAC-signed payload, and a readable CSRF cookie. Any cookie-authenticated request that is
not a `GET`, `HEAD`, or `OPTIONS` must echo that CSRF value in an `X-CSRF-Token` header, so
another site cannot act as a signed-in user. Sessions last 12 hours.

Passwords are stored as scrypt hashes with a per-account salt in
`${AUTH_DIR}/users.json`, written `0600`. `AUTH_DIR` defaults to an `auth` directory beside
project storage. The session signing secret comes from `AUTH_SESSION_SECRET`, or is
generated once and persisted in that directory so restarts do not sign everyone out.

Set `TRUST_PROXY=true` when a TLS-terminating proxy fronts the workbench, so cookies are
marked `Secure`. In production (`NODE_ENV=production`) they are `Secure` regardless.

Sign-in attempts are throttled to 10 per email per 15 minutes in memory, and a wrong
password and an unknown email cost the same work and return the same message, so the
endpoint does not reveal which accounts exist.

## What this is not

- No external identity provider, SSO, or MFA. Accounts are local to the instance.
- No per-project permissions: a role applies to the whole workbench.
- No password reset flow. An owner sets a new password with `PATCH /api/auth/users/:id`.
- The shared `WORKBENCH_AUTH_TOKEN` keeps **full** access when it is configured alongside
  accounts, including approval. Remove it once accounts are in use, or treat it as an owner
  credential.
- Session cookies are bearer credentials: anyone who can read them can act as that user
  until the session expires or the account's password changes. Terminate TLS in front of
  the workbench.

See [security](security.md) for the runtime boundary this sits inside.
