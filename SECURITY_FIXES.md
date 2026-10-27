# Security fixes

This fork patches findings from a static review of upstream version 1.4.1,
commit `2ca1e2d71e7cf4f74755c37483229820c3627bdb`. Original authorship and license
remain unchanged. These changes do not certify the application or its dependencies
as free of vulnerabilities.

## Changes and migration

- Diagnostics retain HTTP method, status, URL origin/path, and known action names.
  They omit payloads, query strings, URL credentials, fragments, and free-form
  error messages. This deliberately reduces diagnostic detail to keep account
  credentials out of logs. Startup scrubs the current log and all four archives;
  malformed old files are removed. Clearing logs also removes archives. Copies
  already exported or shared cannot be recalled, and upstream sessions may need
  revocation if those copies exposed credentials.
- SSO must successfully refresh its bearer and read an authenticated Storytel
  bookshelf snapshot before an app session is issued. Firebase authentication
  alone is insufficient. The separate Storytel cookie and email/cid are supplied
  metadata, not the authority for local API access. Existing app tokens are
  invalidated by the new session version, so users must sign in again.
- Desktop generates a private per-install signing key under Electron userData,
  preserving signed-in offline playback across restarts after the one-time upgrade
  sign-in. This file relies on OS file permissions and is not a credential vault.
  Without `JWT_SECRET`, standalone server processes generate a random signing key.
  Standalone app sessions then require sign-in after a restart. To persist standalone
  sessions across restarts, configure a unique secret of at least 32 characters
  in `server/.env` when using the documented server development script. The old
  public placeholder is rejected. Environment lookup follows the process working
  directory; Electron does not automatically read `server/.env`.
- The standalone listener defaults to `127.0.0.1`. Setting `HOST` deliberately
  enables other bindings. A remotely accessible deployment still needs trusted
  transport and access controls; this remains a personal player with shared logs
  and downloads, not a multi-user service.
- Native browser audio uses a book-specific playback capability issued by the
  authenticated stream endpoint. It expires after 24 hours and after a server
  restart. Starting playback again obtains a fresh link. It cannot authorize
  account or diagnostic APIs. Treat this URL as private while it is valid.
  Normal full-file playback and byte-range seeking are preserved; malformed,
  suffix, multiple, reversed and out-of-bounds ranges return 416. Electron retains
  its existing offline `file:` playback path without a network listener.
- Privileged prerelease builds accept trusted prerelease tags, not fork PR heads.
  They check out the event's immutable commit and do not persist checkout tokens.
  Manual PR builds use a separate read-only workflow without signing secrets or
  publication. Review those unsigned artifacts as untrusted outputs.
- Package repository metadata points to this fork, so generated update metadata
  uses this fork's release channel. Upstream installers do not contain these fixes.

## Verification

Install the checked-in dependencies without lifecycle scripts:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix server
npm ci --ignore-scripts --prefix client
```

Run regression tests and builds:

```sh
npm test
npx --no-install tsc --noEmit -p server/tsconfig.json
npm run server:build
npm run electron:build
npm run build
```

The regression tests use isolated temporary files and a mocked Axios adapter.
They exercise rejected fake and unrelated-project SSO credentials, verified
empty-library SSO, legacy login, session migration, the old signing-key forgery,
diagnostic persistence/export and archive migration, media capability misuse,
full/partial playback, invalid ranges, and Electron file URL selection. They do
not send account credentials to a live service.

Workflow YAML, shell syntax, tag validation, checkout credential persistence,
and the separation of fork builds from release credentials were also checked
locally. CI repeats the tests, type checks and builds on Node 22.

## Remaining limitations

Live Storytel SSO and actual Windows installation/playback need manual validation
with an account and a Windows machine. No signed installer is produced by this
patch alone. Windows publisher-signature enforcement, OS credential-vault
integration and Electron renderer hardening remain separate work. The saved app
token still contains upstream account credentials, and the legacy password
representation is recoverable with the protocol's public constants. Dependency
source and current vulnerability advisories have not been independently audited.
