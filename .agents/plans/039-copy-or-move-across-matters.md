# Plan: Copy or Move Files/Folders Across Matters

Date: 2026-05-09

## Goal

Let users relocate or duplicate a file or folder (with its full subtree)
from one matter to another within the same organization. Today the
existing `move` handler is workspace-scoped and `duplicate` only clones
in place; both block legitimate workflows like splitting a matter,
consolidating engagements, or seeding a template matter from another.

## Design Decisions

- **Two new endpoints, not extending `move`/`duplicate`.** Cross-matter
  ops need different permissions (target `entity:create` + source
  source-side perms), bilateral audit, S3 copy, and property
  reconciliation. Bolting onto the existing handlers would muddy their
  preconditions. New handlers:
  `POST /entities/:workspaceId/move-to-matter` and
  `POST /entities/:workspaceId/copy-to-matter` (where `:workspaceId` is
  the **source**; target workspace ID lives in the body).

- **Move = copy-then-delete-source.** `fields` has a composite FK
  `(propertyId, workspaceId) → properties` and `justifications` /
  `cellMetadata` have composite FKs back to fields/properties
  (`schema.ts:1116–1190`). An in-place workspaceId rewrite would mean
  cascading updates across five tables plus simultaneous property-id
  rewrites to satisfy the composite FKs. Doing move as a copy followed
  by source deletion reuses 100% of the copy code path and avoids that
  complexity. Trade-off: target entity gets a new ID (external
  references to the source ID — shared links, chat mentions — won't
  follow), and stamps are re-allocated. Same trade-off `duplicate`
  already accepts.

- **Same-organization only.** Cross-org transfers would breach
  ethical-wall isolation (SOC 2 / ISO 27001) and route through a
  different trust domain. Validate that source and target workspaces
  share `organizationId` server-side; do not surface other-org matters
  in the picker.

- **Bilateral permission check via existing primitives.** No new auth
  helper. Source workspace is gated by the existing handler-config
  permission (the URL `:workspaceId` runs through
  `workspaceAccessMacro` + `permissionMacro`). Inside the handler,
  check the target workspace by looking it up in `accessibleWorkspaces`
  (active + same `organizationId`) and calling
  `getAuth().api.hasPermission` for `entity:["create"]` against it.

- **Property reconciliation: match by `(name, type)`; drop the rest.**
  Fields reference `propertyId`, which is workspace-scoped, and
  `fields.workspaceId` is composite-FK'd to `properties`. Strategy: at
  copy/move time, look up target properties matching each source
  field's property by `name` + `type`; map matched fields, drop
  unmatched, surface a `droppedFields` count in the response so the
  frontend can warn the user. Auto-creating properties on the target
  would silently pollute the schema; silent drop would be invisible —
  reporting splits the difference. The "file" property is special-cased:
  if the target has no file property, refuse the operation with a clear
  error (the user must add one first; same constraint as upload today).

- **S3: bytes copied to a new key under the target workspace.** S3
  keys are `{orgId}/{workspaceId}/{fileId}.{ext}`. Both copy and move
  always write fresh target keys; move additionally deletes source
  keys after the DB transaction commits. S3 writes happen **before**
  the DB transaction (mirrors `upload.ts`); on tx failure, target keys
  are cleaned up with `deleteS3Keys`.

- **Versions: current version only (matches `duplicate`).**
  `duplicate.ts` copies only `currentVersion` and resets
  `versionNumber: 1`. Adopt the same rule cross-matter to keep
  behaviour consistent and avoid implicit cross-workspace
  relationships we don't model.

- **Stamps re-allocated in the target.** `docSequence` and stamp /
  verification codes are workspace-scoped via `allocateEntityStamp`.
  Re-allocate on the target side; do not carry the source stamp
  across.

- **Folder subtree handled as a unit.** Reuse `getFolderSubtree` from
  `duplicate.ts` (export it in place; no extraction). All-or-nothing:
  any failure in any descendant rolls back the whole tree.

- **UX: extend the existing `RowActions` right-click menu, no new
  dialog or component.** `RowActions`
  (`apps/web/src/routes/_protected.workspaces/$workspaceId/-components/row-actions.tsx`)
  is the shared right-click menu for tree-view, kanban, overview, and
  workspace-table — one edit lights up all four surfaces. Add two new
  entries (alongside Duplicate / Rename / Delete):
  **Copy to matter…** and **Move to matter…**, each rendered as a
  Base UI `MenuSub` listing the user's other accessible matters in the
  active org. Clicking a target dispatches the mutation and toasts the
  result. No folder picker in v1 — destination is the target matter's
  root. Folder picking is a follow-up if requested.

## Scope

**In scope:**

- Backend handlers: `copy-to-matter`, `move-to-matter` (move =
  copy-then-delete-source)
- Inline target-workspace + permission checks using existing
  primitives (no new auth helper)
- S3 object copy utility (`copyS3Object`) in
  `apps/api/src/handlers/files/utils.ts`
- Property reconciliation by `(name, type)` with `droppedFields`
  reporting
- Two new entries in the existing `RowActions` right-click menu
  (`Copy to matter…` and `Move to matter…`), each backed by a
  `MenuSub` listing accessible matters in the active org
- i18n keys for the new menu items, toasts, and the "no file property
  in target" error
- Bilateral audit log entries: `CREATE` in target for both;
  additionally `DELETE` in source for move
- Frontend post-success: invalidate both source + target query caches

**Out of scope:**

- Cross-organization transfer (ethical-wall blocker)
- In-place move that preserves source entity ID (composite-FK churn;
  see Design Decisions)
- Multi-select bulk relocate (follow-up; same handler shape with
  `entityIds[]`)
- Auto-creating missing properties in the target matter
- Carrying full version history across matters
- Copying entity-attached metadata not covered by `currentVersion.fields`
  (justifications, cellMetadata, chat references)
- Preserving source `docSequence`/stamps in the target
- Target-folder picker (lands in target matter root)

## Implementation

### Backend

- `apps/api/src/handlers/entities/copy-to-matter.ts` — new. Reuses
  `getFolderSubtree` and `resolveEntityName` from `duplicate.ts`
  (exported in place). Validates target workspace access + permission
  inline, runs `reconcileProperties` against target, S3-copies file
  bytes via the new helper, writes target-side audit log entries.
- `apps/api/src/handlers/entities/move-to-matter.ts` — new. Performs
  the same copy as above, then deletes the source entity subtree
  (entities, entityVersions, fields, and dependent rows cascade via
  existing `onDelete: "cascade"`) and the source S3 keys; writes a
  `DELETE` audit entry in the source workspace. Reuses
  `deleteS3Objects` from `apps/api/src/handlers/files/utils.ts`.
- `apps/api/src/handlers/entities/relocation-utils.ts` — new file
  containing `reconcileProperties` only (matches target properties to
  source fields by `(name, type)`, returns mapping + `droppedFields`
  count, and refuses if the source has any "file" field but the target
  has no file property).
- `apps/api/src/handlers/entities/duplicate.ts` — `export` of
  `getFolderSubtree` and `resolveEntityName` (one-line change each).
- `apps/api/src/handlers/files/utils.ts` — add
  `copyS3Object({ sourceKey, targetKey })`: thin wrapper around
  `getS3().write(targetKey, getS3().file(sourceKey))` returning a
  `Result`.
- `apps/api/src/handlers/entities/routes.ts` — register both endpoints
  with `invalidateQuery: true`. Handler-config permissions gate the
  source workspace: `entity: ["create"]` for copy (matches
  `duplicate`'s gate; the user must be allowed to create — even though
  the create lands in target, the source-side gate is consistent),
  `entity: ["update"]` for move. Target permission re-checked inline
  via `hasPermission`.

### Frontend

- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/row-actions.tsx`
  — extend the existing right-click menu. Add two new items:
  **Copy to matter…** and **Move to matter…**, each implemented as a
  `MenuSub` whose popup lists same-org matters (excluding the current
  one). Clicking a target matter dispatches the corresponding
  mutation. Editing this single file covers tree-view, kanban,
  overview, and workspace-table simultaneously
  (`tree-view.tsx:72`, `kanban-card.tsx:27`, `overview-view.tsx:70`,
  `workspace-table.tsx:51`).
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-mutations/entities.ts`
  — add `useCopyEntityToMatter`, `useMoveEntityToMatter`. On success,
  invalidate `entitiesKeys.all(sourceWorkspaceId)` AND
  `entitiesKeys.all(targetWorkspaceId)`, plus the workspace overview
  key for both. Toast the result and surface `droppedFields` count if
  non-zero.
- Matter list query: reuse
  `workspacesOptions(activeOrganizationId)` from
  `apps/web/src/routes/_protected.workspaces/-queries.ts:34`. Filter
  out the source workspace before rendering the submenu.

### DB Schema

No schema changes. Move uses fresh inserts in target + cascading
deletes of source rows; in-place workspaceId rewrites are explicitly
out of scope.

### i18n

New keys (en + pseudo): `entities.relocate.copyToMatter`
("Copy to matter…"), `entities.relocate.moveToMatter`
("Move to matter…"), `entities.relocate.noOtherMatters`
(empty-state inside the submenu),
`entities.relocate.droppedFieldsWarning`,
`entities.relocate.noFileProperty`,
`entities.relocate.success.move`, `entities.relocate.success.copy`.
Translation flow per `/conventions-i18n`.

## Test Cases

- Copy a file into a matter in the same org → new entity in target,
  source preserved, S3 object exists at both keys.
- Move a file → source entity gone, target has it, source S3 object
  deleted.
- Copy/Move a folder with nested children → full subtree copied/moved,
  parent links preserved within the new tree.
- Copy where target has matching property by `(name, type)` → field
  carried over with target's `propertyId`.
- Copy where target lacks a property → field dropped, response reports
  `droppedFields: N`, frontend toast warns.
- Copy where source has a file field but target has no file property
  → 400 with clear error code, no partial state.
- Cross-org attempt (target workspace in different org) → 403, no
  leak of target name/existence in the error message.
- User without `entity:create` on target → 403.
- User without source `entity:update` (move) → 403.
- Read-only entity move → 409 (matches existing move handler).
- Filename collision in target → `_N` suffix applied via
  `resolveEntityName`, no overwrite.
- Concurrent move of the same entity → second attempt 404 (row lock +
  missing source).
- Entity-count limit on target → 400 with limit-reached error before
  any S3 work.
- Audit log: target workspace gets `CREATE` entries for every new
  entity; for move, source workspace additionally gets a `DELETE`
  entry per source entity.
- S3 failure mid-copy → DB transaction rolls back, target S3 keys
  cleaned up; source data untouched.
- Right-click menu on a file (tree/kanban/overview/table) shows
  "Copy to matter…" / "Move to matter…" items.
- Submenu lists same-org matters with the source matter excluded.
- User with no other accessible matters → menu items disabled or show
  an empty-state row.

## Commit Plan

Each commit should be reviewable in isolation, type-check, and not
break the build. Conventional Commits (`feat:`, `refactor:`, `fix:`);
rebase onto `main` for a linear history.

**What's already in place** (reuse, do not re-invent):

- **Cross-workspace access check.** `ctx.accessibleWorkspaces` is on
  every authed request (`apps/api/src/lib/auth.ts:798–810`). The
  target-workspace check is a 3-line inline lookup against that list
  with a status filter — no new helper needed.
- **Per-workspace permission check.** better-auth's
  `getAuth().api.hasPermission({ headers, body: { permissions } })`
  (`auth.ts:766`) handles per-workspace permission checks. Call it
  directly inside the handler.
- **Org-wide workspace list endpoint.** `GET /workspaces`
  (`apps/api/src/handlers/workspaces/read.ts`) already returns active
  workspaces in the active organization. No new endpoint required.
- **Frontend workspace query factory.** `workspacesOptions(activeOrgId)`
  in `apps/web/src/routes/_protected.workspaces/-queries.ts:34`
  already drives the matters list and is reused for the submenu.
- **Subtree walk + filename collision.** `getFolderSubtree` and
  `resolveEntityName` already implemented in `duplicate.ts`; a
  one-line `export` makes them reusable — no extraction, no new
  module.
- **S3 source deletion.** `deleteS3Objects` and `deleteS3Keys` in
  `apps/api/src/handlers/files/utils.ts` already handle batch S3
  deletion; the move handler reuses them.
- **Shared right-click menu.** `RowActions` is imported by
  `tree-view`, `kanban-card`, `overview-view`, and `workspace-table`.
  One edit covers all four surfaces.
- **Audit primitives.** `AUDIT_ACTION.CREATE` and `AUDIT_ACTION.DELETE`
  with structured `changes` already cover what we need; no new audit
  actions.

**Commits:**

1. **`feat(files): add copyS3Object utility`** — thin wrapper around
   `getS3().write(targetKey, getS3().file(sourceKey))` returning a
   `Result`, in `apps/api/src/handlers/files/utils.ts`. Self-contained;
   ships with a unit test. Both backend handlers consume it.

2. **`feat(entities): copy entity to another matter`** — backend
   `copy-to-matter` handler + route registration. Includes:
   - inline target-workspace access check via `accessibleWorkspaces`
     and `hasPermission`
   - one-line `export` of `getFolderSubtree` and `resolveEntityName`
     from `duplicate.ts`
   - new `reconcileProperties` helper in
     `apps/api/src/handlers/entities/relocation-utils.ts` that runs
     `tx.query.properties.findMany({ where: { workspaceId: target } })`
     and matches by `(name, type)`
   - S3 copy via commit 1
   - target-side audit log entries (`CREATE`)

   Tests: happy path, missing file property, cross-org rejection,
   dropped fields, permission failures.

3. **`feat(entities): move entity to another matter`** — backend
   `move-to-matter` handler + route. Implemented as copy
   (reusing the helpers from commit 2) plus source-entity deletion +
   source-S3 cleanup via existing `deleteS3Objects`. Source-side
   `DELETE` audit entries. Tests: read-only refusal, source row lock,
   bilateral audit (`CREATE` in target, `DELETE` in source), source
   S3 keys deleted, target untouched on failure.

4. **`feat(entities): copy/move-to-matter mutation hooks`** — add
   `useCopyEntityToMatter` and `useMoveEntityToMatter` to
   `-mutations/entities.ts`, each invalidating both source and target
   query keys on success and surfacing `droppedFields` in the toast.
   Hooks are exported but unused until commit 5.

5. **`feat(entities): copy/move to matter in row-actions menu`** —
   extend the existing `RowActions` right-click menu with two new
   `MenuSub` items listing same-org matters (sourced from
   `workspacesOptions(activeOrganizationId)`, current workspace
   filtered out). Selecting a target dispatches the mutation. i18n
   keys for menu labels, empty-state, and toasts. No new component
   file, no dialog. Single edit lights up tree-view, kanban,
   overview, and workspace-table.

Sequencing notes:

- Commit 3 depends on 2 (shares `reconcileProperties`,
  `getFolderSubtree`, `resolveEntityName`, and the copy code path).
- Commit 5 needs 4.

## Open Questions

- **`createdBy` / `createdAt` on copied entities.** Suggest:
  `createdBy = current user`, `createdAt = now`, and record
  `sourceEntityId` in audit log metadata for traceability. Matches
  `duplicate`'s existing behaviour.
- **Matter picker filter.** Filter to matters where the user has
  `entity:create`, or show all and 403 on submit? `workspacesOptions`
  doesn't currently surface per-workspace permission. Suggest: ship
  without filtering, add filtering as a follow-up if dead-end UX
  reports come in.
