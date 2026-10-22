# Releasing

`dev` is where work lands. `main` is release-only and is protected, so it moves
only by promoting `dev` into it. A tag points at a commit on `main`, and nothing
else.

The point of a release is not the tag. It is that **every ref a reader will
copy** stops moving at the same moment. A half-done release is worse than a late
one: a README that says `@v1` while the workflow it shows runs `@main` will
quietly behave differently next week.

## What has to move together

| Where | Before | After |
|---|---|---|
| `README.md` install examples | `@main` | `@v1` |
| `docs/*.md` code blocks | `@main` | `@v1` |
| `.github/workflows/review.yml` → `uses:` | `@main` | `@v1` |
| The pre-release note in the README | present | deleted |

`review.yml` deserves its own line in that table. A reusable workflow runs in
the *caller's* checkout, so its `uses:` cannot be `./`; it names this repository
by ref. If that ref and the ref in the README disagree, one of them is wrong and
only one of them will be noticed.

## Steps

1. **Finish the changelog.** Move `[Unreleased]` entries under a version heading
   and a date. A release with no changelog entry is a release nobody can audit.
2. **Promote.** Open a pull request from `dev` to `main` and merge it with a
   merge commit — not squash, which would put a `dev`-shaped commit on `main`
   and break the back-merge.
3. **Tag on `main`,** twice, on the same commit: the exact version and the
   moving major. Push both.

   ```bash
   git fetch origin main
   git tag -a v1.0.0 -m "v1.0.0" origin/main
   git tag -a v1     -m "v1 (moving; points at the latest v1.x)" origin/main
   git push origin v1.0.0 v1
   ```

4. **Flip the refs** in the table above on `dev`, then promote that as a
   follow-up. Doing this *after* the tag is deliberate: the tag must point at
   the code that was tested, and the ref flip is a documentation change that
   deserves its own CI run.
5. **Back-merge** so `dev` and `main` share a base:

   ```bash
   git switch dev
   git merge --ff-only origin/main
   git push origin dev
   ```

6. **Check the image.** Pushing a `v*` tag makes `publish.yml` push
   `ghcr.io/vvamzy/prsentinel:v1` and the `1.x` tags. Confirm the tags exist
   before telling anyone the release is out.

## Moving a major tag

`v1` is a moving tag: it should point at the newest `v1.x`. Move it by deleting
and recreating it, never by force-pushing over an annotated tag you did not
write:

```bash
git tag -d v1 && git push origin :refs/tags/v1
git tag -a v1 -m "v1 (moving)" v1.1.0
git push origin v1
```

## When not to release

Do not tag while a review prompt is changing. Prompt text is the product, and a
prompt that has not been measured is not a release. "Measuring quality" in
[CONTRIBUTING.md](../CONTRIBUTING.md) explains how; until a cloud-model score
exists, a tag would claim a quality nobody has checked.
