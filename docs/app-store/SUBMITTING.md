# Getting the app into the App Store

The app, its icon, its privacy files and the listing text are ready. Three
things need your Apple account, and only you can do them.

## 1. Join the Apple Developer Program (once)

<https://developer.apple.com/programs/enroll/>. It costs US$99 a year and Apple
usually approves it within two days. A free Apple account can't upload to the
App Store.

Then, in Xcode: **Settings → Accounts → + → Apple Account**, and sign in.

## 2. Create the app record (once)

At <https://appstoreconnect.apple.com> → **Apps → + → New App**:

- Platform: **visionOS**
- Name: **Lookplay** (if Apple says it's taken, pick another and change
  `APP_NAME` in `visionos/project.yml` to match)
- Bundle ID: `io.github.themaninhollywood.lookplay`. If it isn't in the list
  yet, add it at <https://developer.apple.com/account/resources/identifiers/add/bundleId>
  first (type "App", explicit ID).
- SKU: `lookplay-visionos`

## 3. Upload the build

```bash
npm run vision:release
```

It builds, signs and uploads. Ten to thirty minutes later the build appears in
App Store Connect under **TestFlight**.

To check that it builds without any account:

```bash
npm run vision:release -- --check
```

## 4. Fill in the listing and submit

Everything to paste is in [LISTING.md](LISTING.md), which also says which
screenshots to take. Choose the uploaded build under **Build**, then
**Add for Review → Submit**. Apple usually answers within one to three days.

## The link

- **App Store link:** exists once Apple approves, as
  `https://apps.apple.com/app/id<number>`. The number is shown under **App
  Information → Apple ID** as soon as step 2 is done.
- **A link sooner:** under **TestFlight → External Testing**, add a group and
  turn on **Public Link**. Anyone with a Vision Pro can install from it after a
  shorter beta review, usually a day.

## What can get it turned away

- **The name.** It must be your own. Apple rejects apps named after another
  company's product, so not "PS5", "PlayStation" or anything built on them.
- **Reviewers can't test with a console.** That's what the built-in demo and
  the review notes are for. A screen recording of real play helps a lot.
- **The Mac side.** The bridge is started from Terminal today. Apple may ask
  for something friendlier before approving; a small Mac app that wraps the
  bridge would answer that.
