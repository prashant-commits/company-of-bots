# Slice 1 Agent Tools

- `read_points()`: calls `sendablePoints(repo)` to get confirmed points.
- `fill_field({ field, pointId })`: types point's current text; code logs `{ field, pointId, rev }`.
- `upload_master_resume()`: uploads the profile master resume.
- `submit()`: calls `beginSubmit` with logged refs, clicks submit, then calls `recordOutcome`.
- `park({ type, note?, fields?, site?, contact?, afterSubmit? })`: calls `recordOutcome` with park details.
- `skip_for_hard_no({ pointId })`: calls `recordOutcome` with `{ type: 'skipped', hardNoPointId }`.
