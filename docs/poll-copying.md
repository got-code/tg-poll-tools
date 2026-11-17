# Poll copying

Agreed product scope, implemented locally. Final review and the first release approval are pending.
Product name: Telegram Poll Tools. GitHub repository: `got-code/tg-poll-tools`.
Pages address: `https://got-code.github.io/tg-poll-tools/`.

## Sources and copies

- A new draft starts with the current analysis poll links. Its source list then
  belongs to the draft: users can change addresses and the number of polls using
  the existing add, remove and message-number increment behavior.
- Each poll selected in that list produces one independently editable new poll.
  Changing the analysis selection must not replace an existing draft.
  Each card contains its source link and editable copy; adding/removing affects
  the whole card. Blank sources auto-increment from the previous message.
  Fill drafts from sources refills every card and confirms replacing existing
  questions/answers/settings. Changing a source preserves text until this action
  and blocks publication until the matching source has been loaded.
- Copying reads poll content and settings without loading voters. Both anonymous
  and non-anonymous ordinary polls are eligible when the account can read them.
- Users can edit the question and add, remove, reorder or edit answers.
- Initialize these editable settings from each source: anonymity, multiple
  answers, answer shuffling, permission to retract/change a vote, participant-added
  answers and hiding results until the poll closes.
- Copies start as new open polls with no votes. Original polls are not modified.
  Old closing times are not reused. Quizzes and scheduled publication are outside
  the first version. Unsupported source features must not be silently discarded.

## Draft storage

- Automatically save source links, edited content, settings and destination in
  this browser. Restore them after reload; restored edits take precedence over
  initial values. Do not persist voters or credentials in draft data.
- Report storage failures without presenting unsaved changes as saved.
- Reloading or restoring a draft must never send polls.

## Publication

- Use one destination for the whole batch, initially the first source poll's
  chat. Users can choose a different Telegram destination that permits polls.
- Show the edited polls and destination before explicit user publication.
- Optionally add a separate plain-text message before and/or after the whole batch.
  Blank fields are skipped. Messages share the destination and appear in the preview
  in sending order. Their text, sending keys and outcomes are saved with the draft.
  A failure stops the batch; check uncertain outcomes before continuing. Retries
  skip all confirmed publications, including accompanying messages.
- Preserve the draft's order and track the outcome of each publication. Give
  links to successfully created polls when Telegram provides a permalink. Prevent duplicate clicks and duplicate
  publication when retrying a batch or recovering after interruption.
- Distinguish an unknown sending outcome from a confirmed failure before offering
  a retry. Already published items must not be silently sent again.
- Preserve safe Telegram failure details without logging credentials, identifiers
  or response bodies. Describe known permission and rate-limit failures clearly.

## Acceptance and delivery

1. Select several sources, change their addresses/count independently of analysis,
   and obtain the same number of editable copies.
2. Change text, answers, all six settings and the single destination; reload and
   recover the same draft without any publication.
3. Publish after preview and explicit confirmation; obtain one new poll per draft
   item in the selected chat, with the expected settings and no original votes.
4. Handle partial success, uncertain outcomes, retry and reload without silently
   publishing duplicates or losing the remaining work.
5. Keep analysis, sign-in, remembered-session protection and lazy SDK loading
   working. Update privacy copy when publication and draft persistence are added.
6. Automate appropriate checks with synthetic Telegram responses. The user
   approves initial releases. Choose recovery measures in proportion to the change.

Delivery sequence: name update; content-only loading and draft model; editor and
storage; destination and publication; integration checks and user-reviewed release.

## Draft lifecycle

Delete draft requires confirmation and removes the browser draft, never published Telegram
polls or messages. Reopening creates a fresh draft from the current comparison selection.
On page load, only drafts with unsent polls or messages (including failed/unknown outcomes)
open automatically. Empty and fully published drafts start collapsed. Users
control expansion thereafter; deletion or full publication collapses the block.
