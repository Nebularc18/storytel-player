# Windows releases

This fork publishes Windows x64 installers through the **Tagged Windows release**
GitHub Actions workflow. A pushed tag such as `v1.4.2` triggers the workflow.
Tags with a suffix, such as `v1.4.3-beta.1`, publish a GitHub prerelease.

The tag must exactly match `package.json` and `src/version.ts`, and its commit
must already be on `develop`, the fork's default branch. Invalid or mismatched
tags fail before building. The workflow installs locked dependencies, checks all
three npm advisory trees, runs regression tests and type checks, and builds an
unsigned NSIS installer. Native tests verify Windows encryption across process
restart, renderer isolation, IPC restrictions and offline fixture playback and
seeking. The installer is installed and launched on the disposable Windows runner.

Only after validation passes does a separate job receive release-write permission.
It downloads the tested installer artifact, verifies its SHA-256 checksum and
publishes the installer and `SHA256SUMS.txt` on the tag's GitHub release. Build jobs
receive no release token or signing secrets. Publication does not replace an
existing release or its assets. If publication fails, fix the cause and rerun the
failed job; do not move a published release tag.

To create the next release:

1. Set the next version with `npm version <version> --ignore-scripts --no-git-tag-version`.
2. Set `APP_VERSION` in `src/version.ts` to the same version.
3. Commit and merge the version change and any application changes into `develop`.
4. Update the local branch and tag that exact commit:

   ```sh
   git fetch origin develop
   git tag -a v1.4.2 origin/develop -m "Storytel Player v1.4.2"
   git push origin v1.4.2
   ```

5. Check **Actions → Tagged Windows release**. A passing run publishes the
   installer under the repository's **Releases** page.

Replace `v1.4.2` in the example with the version being released. The old
branch-triggered and separate all-platform prerelease publishers have been
replaced by this single tag-based Windows workflow.

Installers remain unsigned until a trusted signing identity is provisioned.
Automatic updates remain disabled. Native fixture tests do not substitute for
real Storytel login, SSO, downloads or live playback acceptance testing.
