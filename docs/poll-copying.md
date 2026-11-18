# Poll copying

Agreed product scope, implemented locally. Final review and the first release approval are pending.
Product name: Telegram Poll Tools. GitHub repository: `got-code/tg-poll-tools`.
Pages address: `https://got-code.github.io/tg-poll-tools/`.

## Sources and copies

- A new draft starts with the current analysis poll links. Its source list then
  belongs to the draft: users can change addresses and the number of polls using
  the existing add, remove and message-number increment behavior.
- Selected polls with the same question produce one editable logical poll. Ignore
  leading/trailing whitespace and a final space-separated `#1`, `#2`, etc.; match
  the remaining question case-sensitively. Merge identical trimmed answers in
  first-seen order. Use the first source's settings, which remain editable.
  Changing the analysis selection must not replace an existing draft.
  Keep all source links available for editing. Blank sources auto-increment from
  the previous message.
  Fill drafts from sources refills every card and confirms replacing existing
  questions/answers/settings. Changing a source preserves text until this action
  and blocks publication until the matching source has been loaded.
- Copying reads poll content and settings without loading voters. Both anonymous
  and non-anonymous ordinary polls are eligible when the account can read them.
- Users can edit the question and add, remove, reorder or edit answers.
- Questions made identical by editing are also combined before publication preview.
- Initialize these editable settings from the first source of each question: anonymity, multiple
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
- Existing drafts migrate without losing edits or sending results. A batch that
  already started keeps its original physical polls, settings and sending order.

## Publication

- Use one destination for the whole batch, initially the first source poll's
  chat. Users can choose a different Telegram destination that permits polls.
- Show the edited polls and destination before explicit user publication.
- Split a logical poll into parts of 2–12 answers when necessary, preserving answer
  order. Number every part `#1`, `#2`, etc.; one-part questions need no suffix.
  Redistribute a final single answer rather than inventing an option: 13 answers
  become parts of 11 and 2. Preview the actual parts that will be sent.
- Optionally add a separate plain-text message before and/or after the whole batch.
  Blank fields are skipped. Messages share the destination and appear in the preview
  in sending order. Their text, sending keys and outcomes are saved with the draft.
  A failure stops the batch; check uncertain outcomes before continuing. Retries
  skip all confirmed publications, including accompanying messages.
- Preserve the draft's order and track the outcome of each publication. Give
  links to successfully created polls when Telegram provides a permalink. Prevent duplicate clicks and duplicate
  publication when retrying a batch or recovering after interruption.
- Each physical part has its own saved sending key, outcome and link. Once a
  batch attempts its first send, the whole draft is fixed: polls, source links,
  settings, destination and accompanying messages. Check uncertain results or
  retry pending items; start a new draft to make edits. Reload and retry continue
  without resending confirmed publications.
- Distinguish an unknown sending outcome from a confirmed failure before offering
  a retry. Already published items must not be silently sent again.
- Preserve safe Telegram failure details without logging credentials, identifiers
  or response bodies. Describe known permission and rate-limit failures clearly.

## Acceptance and delivery

1. Select several sources and change their addresses/count independently of analysis.
   Obtain one editable copy per combined question, with all source links retained.
2. Change text, answers, all six settings and the single destination; reload and
   recover the same draft without any publication.
3. Publish after preview and explicit confirmation; obtain the previewed numbered
   parts in the selected chat, with the expected settings and no original votes.
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
