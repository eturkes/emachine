# GitHub releases

The repository uses `git@github.com:eturkes/emachine.git` for source and tag pushes.
AppImages belong in GitHub Releases, not in Git history.

## Prepare

Update the application version and its release notes. Commit the source before building.
The first release is `v0.1.0`.

```sh
pnpm install --frozen-lockfile
pnpm release:prepare
```

Preparation runs the standard acceptance gate, then builds from a separate archive of the committed source.
It tests the exact packaged AppImage with an empty machine list and a real test server.
The existing installed AppImage is unchanged. Existing release output is never overwritten.

The output directory is `desktop/publish/vVERSION/`. It contains:

- `emachine-VERSION-x86_64.AppImage`: the Linux desktop client.
- `SHA256SUMS`: checksums for the AppImage and its release metadata.
- `release.json`: the source commit, version, platform, build-tool versions, and artifact checksum.

Release builds contain no configured machine identities, addresses, or credentials.
Local `pnpm appimage` builds still support this machine's connection seed.
The AppImage does not bundle or install the machine server.

## Publish

Verify `release.json.commit` equals the commit being tagged. Use a new version instead of replacing an existing release.
For the first release:

```sh
git tag -a v0.1.0 -m 'emachine v0.1.0'
git push --atomic -u origin main refs/tags/v0.1.0
gh release create v0.1.0 \
  desktop/publish/v0.1.0/emachine-0.1.0-x86_64.AppImage \
  desktop/publish/v0.1.0/SHA256SUMS \
  desktop/publish/v0.1.0/release.json \
  --repo eturkes/emachine --verify-tag --draft \
  --title 'emachine v0.1.0' --notes-file docs/releases/v0.1.0.md
```

Compare GitHub's uploaded asset digests with the prepared files before publishing the draft.
Source pushes use SSH; release uploads use GitHub's HTTPS API through `gh`.

```sh
gh release edit v0.1.0 --repo eturkes/emachine --draft=false --latest
```

## Verify downloads

Download the three assets into a new directory, then verify them:

```sh
gh release download v0.1.0 --repo eturkes/emachine --dir ./emachine-download
cd emachine-download
sha256sum -c SHA256SUMS
chmod +x emachine-0.1.0-x86_64.AppImage
./emachine-0.1.0-x86_64.AppImage
```

Clients without a FUSE helper can set `APPIMAGE_EXTRACT_AND_RUN=1` when launching.
Release publication is explicit. Pushing a branch or tag does not start a separate automatic publishing workflow.
