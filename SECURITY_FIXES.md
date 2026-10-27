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
- Desktop encrypts the saved app session and per-install signing key with
  Electron `safeStorage`. On Windows this uses DPAPI and protects against other
  OS users, but not malware already running as the same Windows user. The old
  plaintext session and signing-key file are removed. Session version 3 rejects
  all earlier password-bearing sessions. A fresh login is required after this
  upgrade. A usable OS keyring is required for persistent sessions. If encryption
  is unavailable, including Linux's `basic_text` fallback, secrets stay in memory
  and restart requires another login. Decryption failure requires a fresh login.
- Password login uses the protocol's encrypted password only for the immediate
  upstream request. It never places it in the app session, a renewal cache or
  persistent storage. When that upstream session expires, explicit login is
  required. SSO can still refresh with its encrypted saved refresh token.
- SSO uses an in-memory browser profile, clears it before and after each attempt,
  and clears the former persistent SSO profile on startup. Provider passwords and
  cookies are not retained for subsequent SSO attempts. The standalone browser
  client also removes old localStorage tokens and keeps its session in memory.
- Electron's main renderer disables Node integration, enables sandboxing, denies
  Electron popups, webviews and permission requests, and blocks navigation and redirects
  outside the app document. The two fixed community links open in the system
  browser. Every IPC handler checks the current window and its
  main frame against the approved app URL. Renderer storage keys and API paths
  are restricted. OAuth windows permit only HTTPS Storytel and supported provider
  destinations and keep the same sandbox restrictions. Preload callbacks strip
  raw Electron events before invoking renderer callbacks.
- Standalone processes generate a random signing key unless `JWT_SECRET` supplies
  a unique secret of at least 32 characters. Configure it in `server/.env` when
  using the documented development script to retain standalone sessions after
  restart. The old public placeholder is rejected. Electron supplies its own
  protected key and cannot fall back to writing an unencrypted key file.
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
- Automatic update checks, downloads and installation are disabled, and the
  updater runtime dependency is removed. Windows publisher-signature verification
  is enabled in packaging configuration for any future updater implementation.
  Re-enabling updates requires a trusted signing identity and release process.
  Repository metadata points to this fork. Upstream installers lack these fixes.
  Local downloaded books are excluded from the installer package.
- Updated all three lockfiles against npm advisories, including Electron 43.8.3,
  Axios, Fastify and its JWT stack. Compatibility changes include React Router 7,
  i18next HTTP backend 4 and esbuild 0.28. All three npm audits reported zero known
  advisories on 2026-10-27. This is not an audit of dependency implementations.

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
empty-library SSO, legacy login, session migration, the old signing-key forgery, password omission and expiry without automatic
password login,
diagnostic persistence/export and archive migration, media capability misuse,
full/partial playback, invalid ranges, and Electron file URL selection. They do
not send account credentials to a live service.

Desktop boundary tests exercise saved-session encryption with a mocked OS vault,
restart, logout, corrupt ciphertext, unavailable keyrings, forbidden storage keys,
wrong-window/subframe callers, deceptive OAuth domains and API URL restrictions.
Mocked encryption tests do not establish native DPAPI behavior.

The `Windows installer validation` workflow builds an unsigned NSIS installer on
a disposable GitHub Windows runner without release or signing authority. Its
native Electron script checks DPAPI persistence across two process launches,
offline auth status, sandboxed preload IPC, wrong-window rejection, and local
fixture playback and seeking. It also installs and launches the packaged player,
and uploads the installer with its SHA-256 hash. These are automated fixture
checks, not real Storytel login or download acceptance tests.

Workflow YAML, shell syntax, tag validation, checkout credential persistence,
and the separation of fork builds from release credentials were also checked
locally. CI repeats the tests, type checks and builds on Node 22.

## Remaining limitations and Windows acceptance

The hardening code and local tests do not establish that a real Storytel account
works in the patched Windows installer. Before using an everyday computer:

1. Wait for the Windows installer workflow to pass and use its exact artifact.
   Record the commit, installer SHA-256 and Windows version. The artifact remains
   unsigned and is intended for disposable-VM testing. No trusted signing
   certificate or signed public release has been provisioned by this patch.
2. In a fresh disposable Windows VM, install and test real password login and the
   supported Google/Apple SSO flow. If Storytel changes its OAuth destination
   domains, inspect and update the allowlist rather than removing validation.
3. Play an online book, seek in both directions, change speed and switch books.
   Download a book and verify completion and playback from the downloaded copy.
4. Exit fully, disconnect networking and restart. Verify the saved session,
   downloaded bookshelf, playback and seeking. Expired upstream sessions must not
   prevent playback of existing downloads while the local session remains saved.
5. Reconnect, log out and restart. Verify the saved token is gone and the login
   screen appears. Check that diagnostics contain no credentials and the config
   contains only encrypted session/signing-key blobs. Offline media files remain
   ordinary files in Downloads; logout does not securely erase downloaded books.
6. Verify no updater request or automatic installer starts, including after
   restart. Future signed updates require a separate reviewed implementation.

Live service acceptance and native Windows results must be reported separately
from the local tests. Published upstream binaries have not been verified against
this fork. OS encryption cannot protect against a compromised logged-in user,
backups of old plaintext credentials, or copies of logs already shared. Consider
revoking earlier sessions if they were exposed. Dependency advisories were checked,
but the downloaded dependency implementations have not had a full source audit.
