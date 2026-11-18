# ADR 0020: Accounts without email, created on the server

- Status: Accepted
- Date: 2026-11-18

## Context

An account is confirmed by a code sent to its address. An installation therefore needs an SMTP account, with implicit TLS, before anyone can sign in for the first time. That is the longest step of an installation, and many people who rent one server have no such account.

The control plane already starts without SMTP, but then nothing can be done with it: a sign-up was answered `503`, as if the mail server were down for a moment, and no other way to create an account existed.

Two things had to be decided: how the first account, and the next ones, come to exist without a message, and how a lost password is recovered.

## Decision

- **Email is optional.** With `SMTP_HOST` set, nothing changes: sign-up, confirmation and password reset work by email. Without it, the installation sends nothing.
- **Accounts are created on the server.** The control plane has a command line, run on the machine that hosts it:

  ```
  node main.js account create --email <address>
  node main.js account reset-password --email <address>
  ```

  The account is active at once. The installer will run the first command for the first account; until that change lands, it still asks for an SMTP account, and the command is run by hand.

- **The authority is the server.** No route reaches these commands. Whoever can run them already holds the database administrator password and the key-encryption key, which is more than any account has.
- **The password never travels in an argument or a variable**, where other processes could read it. It is typed without echo on a terminal, or is the first line of a pipe.
- **A reset closes what was open.** It advances the account's security version: its sessions, its API tokens and the links it was sent stop working. An account that never confirmed its address becomes active. A second factor stays as it is; its recovery codes are the way back.
- **The public requests say why they are refused.** Without SMTP, sign-up, a new confirmation code and a reset link answer `409 email_not_configured`, the same for every address, before anything is read.
- **The address stays the sign-in name.** Nothing checks that its mailbox exists. `email_verified_at` is set when the account is created: the address is confirmed by the operator of the installation instead of by its mailbox, and the rule that an active account has a confirmed address is unchanged.
- **Both commands are audited** as `identity.created_by_operator` and `identity.password_reset_by_operator`, with the system as the actor. A reset that activates an account records `identity.activated_by_operator` as well.
- **A command never does the work of the server.** It starts the application without its HTTP server, takes no mail job, and exits.

## Alternatives considered

- **A one-time setup link printed by the installer**, opened in a browser to create the owner. A secret in a URL, a window during which whoever gets the link owns the installation, and a new public screen.
- **Open sign-up until the first account exists.** Whoever reaches the domain first owns the installation.
- **A bundled mail server.** Mail sent from a fresh server is mostly rejected, and it is one more service to operate and secure.
- **An environment variable or a file holding the first password.** It stays on disk and in the process list after the account exists.

## Consequences

- Without SMTP there is no self-service: the operator creates each account and resets each password on the server. An organization then adds those accounts as members, as it does today.
- The web screens still offer sign-up and "forgot password"; they must say that the administrator does it when the installation sends no email. That is a change of its own.
- SMTP can be added later: the same accounts keep working, and the email flows come back.
- An installation that loses both its password and its server access has no recovery, which is also true of its database.
