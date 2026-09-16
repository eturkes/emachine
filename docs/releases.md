# GitHub releases

The repository uses `git@github.com:eturkes/emachine.git` for source and tag pushes.
AppImages belong in GitHub Releases, not in Git history.

## Prepare

Update the application version and its release notes. Commit the source before building.
Use a higher version for each release. Existing tags and release assets stay unchanged.

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
- `latest-linux.yml`: the version, filename, size, and SHA-512 checksum for external update tools and older clients.

Preparation validates the update metadata against the exact AppImage. `SHA256SUMS` also covers `latest-linux.yml`.

Release builds contain no configured machine identities, addresses, or credentials.
Local `pnpm appimage` builds still support this machine's connection seed.
The AppImage does not bundle or install the machine server.

## Publish

Verify `release.json.commit` equals the commit being tagged. Use a new version instead of replacing an existing release.
Set the version from the committed application:

```sh
version=$(node -p 'require("./package.json").version')
tag="v$version"
directory="desktop/publish/$tag"
git tag -a "$tag" -m "emachine $tag"
git push --atomic -u origin main "refs/tags/$tag"
gh release create "$tag" \
  "$directory/emachine-$version-x86_64.AppImage" \
  "$directory/SHA256SUMS" \
  "$directory/release.json" \
  "$directory/latest-linux.yml" \
  --repo eturkes/emachine --verify-tag --draft \
  --title "emachine $tag" --notes-file "docs/releases/$tag.md"
```

Compare GitHub's uploaded asset digests with the prepared files before publishing the draft.
Source pushes use SSH; release uploads use GitHub's HTTPS API through `gh`.

```sh
gh release edit "$tag" --repo eturkes/emachine --draft=false --latest
```

## Verify downloads

Download the four assets into a new directory, then verify them:

```sh
gh release download "$tag" --repo eturkes/emachine --dir ./emachine-download
cd emachine-download
sha256sum -c SHA256SUMS
mv "emachine-$version-x86_64.AppImage" emachine.AppImage
chmod +x emachine.AppImage
./emachine.AppImage
```

Clients without a FUSE helper can set `APPIMAGE_EXTRACT_AND_RUN=1` when launching.
Release publication is explicit. Pushing a branch or tag does not start a separate automatic publishing workflow.

## Desktop runtime updates

Replace the AppImage from GitHub Releases with your external update method. The application has no built-in AppImage updater.
[Interface updates](interface-updates.md) use **Refresh** instead and do not need a GitHub release.
Save work in open views before closing the client and replacing its AppImage.

Verify the downloaded files with `SHA256SUMS`. Checksums detect corruption; they are not an independent publisher signature.
Release access depends on the repository's security. No GitHub credential is embedded in the client.

A versionless filename preserves launchers across updates.
The local installer uses `desktop/installed/emachine.AppImage`; builds and release preparation leave that copy unchanged.
Your connection settings stay in the Electron profile. The update replaces only the desktop client.
Machine servers and project views have separate update paths. Server terminals and jobs survive a client restart.

A source edit is not a runtime release. Each runtime update needs a higher version and all four published assets.
