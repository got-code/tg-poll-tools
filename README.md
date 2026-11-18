# Telegram Poll Tools

Find participant intersections across Telegram group polls, or create edited copies of
ordinary polls and publish them in one selected chat, with optional messages before
and after the batch. Group analysis by any poll and
filter by a participant minimum in the grouping poll or another poll.
[Open the app](https://got-code.github.io/tg-poll-tools/).

## Requirements

Analysis needs non-anonymous group polls. Copying also supports anonymous ordinary
polls; publication requires permission to send polls in the destination group or channel.
Use your own [Telegram API keys](https://my.telegram.org/apps). Phone and QR sign-in support
2FA; QR requires another device already signed in to Telegram. Telegram may
require you to vote first and does not expose channel voter lists.

In analysis, an unanswered poll assumes all its options. Implicit matches are assumptions,
not explicit votes. Results include anyone who answered at least one poll.

Selected polls with the same question are treated as one, ignoring a trailing ` #1`,
` #2`, etc. Matching is case-sensitive; leading and trailing whitespace is ignored.
Answers are combined in first-seen order, merging identical answer text and voters.
A vote in any part counts as answering the combined question. Copying uses the first
source's editable settings and splits questions with more than 12 answers into numbered
polls. Review the actual parts before publishing; each part has its own sending result.
After the first sending attempt, the whole draft is fixed. Check uncertain results or
retry remaining items; start a new draft to make edits.

## Run locally

Use Node.js 24 and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). Vite provides its standard development
server, dependency cache, CSS hot updates and automatic page reloads.
To stop the dev server cleanly, press `q` then Enter in its terminal. Press `h`
then Enter to list Vite's terminal shortcuts.

`pnpm build` creates the static site in `dist/`. `pnpm start` previews that existing
build without rebuilding; run the build command again when you need a newer preview.
Use `pnpm dev --port 3001` or `pnpm start --port 3001` for another port.
GitHub Actions publishes successful builds from `main` to GitHub Pages.

## Privacy

The app connects directly to Telegram, with no application backend, analytics or
runtime CDN. It never votes. It sends new polls and optional accompanying messages only after you review and confirm
publication, and may read your chat list to resolve links or select a destination.
Votes and QR tokens stay in memory. CSV excludes Telegram IDs.

Links, grouping and filter settings are saved in this browser. Draft text, options,
settings, source links, account/destination references and publication results are
also saved locally without encryption. Reload restores drafts without sending them.
If a sending result is uncertain, check Telegram before allowing another attempt.
Demo view settings
are temporary and do not overwrite your own settings. Optional remembered login
encrypts the session and API keys with a separate password. Passwords, login codes
and encryption keys are never persisted. Reload clears results and locks the saved
login. Data does not sync between browsers or devices.

Sign out removes the saved login and attempts server logout. Closing a tab does
not revoke the session; manage it in Telegram → Settings → Devices. Sessions have
full account permissions. Encryption protects the stored copy, not an unlocked page.

## Develop

`pnpm format` formats the repository. `pnpm format:check`, `pnpm typecheck` and
`pnpm lint` check formatting, strict TypeScript contracts and code quality.
`pnpm test` runs Node tests; `pnpm check` runs the full suite, including the build
and Chromium tests with synthetic Telegram responses.
After building, `node test/browser.mjs --publishing-only` checks just the poll-copying flow.

Before the first browser test, install Chromium:

```sh
pnpm exec playwright install --with-deps chromium
```

For an installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
Auth RPC diagnostics and poll-read failures appear in the console under `[Telegram`.
They preserve safe error codes and timing, excluding secrets, identifiers and response bodies.

Read the [development rules](CONTRIBUTING.md) before making changes.
