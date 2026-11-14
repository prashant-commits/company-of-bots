# Slice 1 Agent Tools

## Tools

- `read_points()`: calls `sendablePoints(repo)` to get confirmed points.
- `fill_field({ field, pointId })`: types point's current text; code logs `{ field, pointId, rev }`.
- `upload_master_resume()`: uploads the profile master resume.
- `submit()`: calls `beginSubmit` with logged refs, clicks submit, then calls `recordOutcome`.
- `park({ type, note?, fields?, site?, contact?, afterSubmit? })`: calls `recordOutcome` with park details.
- `skip_for_hard_no({ pointId })`: calls `recordOutcome` with `{ type: 'skipped', hardNoPointId }`.

## Contracts these tools must keep

Core enforces each rule below. The tools must still follow it, because a refusal from core means the tool did something wrong.

### One click per authorisation

- **Check the posting before opening it.** Before the applier opens a role's page, it calls `applicationForPosting(repo, { link })` (or `{ roleId }`). When that returns an application, in any state, the agent does not open the role. Each posting has one application. The only way to try a posting again is the user's Retry, which gives `Work` for that application.
- **Start a new posting from the posting, and a retry from the application.** For a role with no application, `submit()` calls `beginSubmit(repo, { roleId, organization, title, link }, intent)`. For `Work` of type `retry`, it calls `beginSubmit(repo, { applicationId }, intent)`. Core refuses a second application for a posting with `ApplicationStateError`, and the error names the existing application.
- **`submit` never clicks when `beginSubmit` throws.** The click comes after `beginSubmit` returns, with no exception. Any error from `beginSubmit` stops the tool before the click: `ApplicationStateError`, `UnsendablePointError` or a write error. The tool reports the error and does not click.
- **Retry on a "may have been sent" row.** The Inbox page sends `{ notSent: true, parkAt: row.parkedAt }` as the retry payload. Use this payload only when the user confirms the application was not sent. The row's type is `error_after_submit`, and `parkAt` is copied from `InboxRow.parkedAt`. A Retry without both fields fails with "confirm the application was not sent before retrying" (rulings R20 and R30). On such a row, Done means "it was sent".
- **Park fields are exact.** `park` passes only the keys of `ParkInput`: `type`, `site`, `fields`, `contact`, `note` and `afterSubmit`. Core refuses any other key, including a misspelt `afterSubmit`, and names the key. Set `afterSubmit: true` only on an `error` park after the submit click.
- **Roles are exact.** `upsertRole` takes `RoleInput` (`title`, `organization`, `location?`, `sourceId`, `link`, `applyPath`, `contact?`). It refuses any other key.

### Sync

- **On `HostRewoundError`, stop the run and ask the user.** `syncRepo` and `pullRepo` throw `HostRewoundError` when the git host's `main` went back. A restore from backup, a scrub by reset or a force-push can cause it. The error means that following the host would drop commits this checkout pushed earlier. For example, a `submitted` application could turn back into a parked one. Nothing was changed. The agent ends its run without processing the queue or opening a role. It then asks the user, through the app, whether the rollback was intended. Only after the user agrees does it call the same function again with `{ acceptRewind: true }`. That result's `rewound` gives the number of dropped commits and the local ref that keeps them.
- `GitError`: the agent reports the message as it is and stops the run. The message is written for people who do not know git.
- `SyncBusyError`: another sync of the same checkout is running. Try again shortly.
