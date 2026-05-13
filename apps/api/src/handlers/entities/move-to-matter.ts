import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import {
  getFolderSubtree,
  resolveEntityName,
} from "@/api/handlers/entities/duplicate";
import type { EntitySnapshot } from "@/api/handlers/entities/duplicate";
import {
  extractFileRefs,
  reconcileProperties,
  rewriteFileContent,
} from "@/api/handlers/entities/relocation-utils";
import type {
  FileCopyPlan,
  FileRef,
} from "@/api/handlers/entities/relocation-utils";
import {
  copyS3Object,
  deleteS3Keys,
  deleteS3Objects,
} from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { getSearchProvider } from "@/api/lib/search/provider";

const moveToMatterBodySchema = t.Object({
  entityId: tSafeId("entity"),
  targetWorkspaceId: tSafeId("workspace"),
});

type MoveToMatterBody = Static<typeof moveToMatterBodySchema>;

type EntityCopyPlan = {
  source: EntitySnapshot;
  newEntityId: SafeId<"entity">;
  newVersionId: SafeId<"entityVersion">;
  rewrittenFields: { propertyId: SafeId<"property">; content: FieldContent }[];
  fileCopies: FileCopyPlan[];
};

type MoveToMatterHandlerOptions = {
  safeDb: SafeDb;
  accessibleWorkspaces: AccessibleWorkspace[];
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  request: Request;
  body: MoveToMatterBody;
};

const moveToMatterHandler = async function* ({
  safeDb,
  accessibleWorkspaces,
  organizationId,
  sourceWorkspaceId,
  userId,
  request,
  body,
}: MoveToMatterHandlerOptions) {
  const { entityId: sourceEntityId, targetWorkspaceId } = body;

  if (targetWorkspaceId === sourceWorkspaceId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Target matter must differ from source",
      }),
    );
  }

  const target = accessibleWorkspaces.find((w) => w.id === targetWorkspaceId);
  if (!target || target.status !== "active") {
    return Result.err(
      new HandlerError({ status: 404, message: "Target matter not found" }),
    );
  }

  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: sourceEntityId },
          workspaceId: { eq: sourceWorkspaceId },
        },
        columns: {
          id: true,
          kind: true,
          name: true,
          parentId: true,
          readOnly: true,
        },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              fields: { columns: { propertyId: true, content: true } },
            },
          },
        },
      }),
    ),
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  if (source.readOnly) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }

  const subtree: EntitySnapshot[] =
    source.kind === "folder"
      ? yield* Result.await(
          safeDb(async (tx) => {
            const all = await tx.query.entities.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              columns: { id: true, kind: true, name: true, parentId: true },
              with: {
                currentVersion: {
                  columns: { id: true },
                  with: {
                    fields: {
                      columns: { propertyId: true, content: true },
                    },
                  },
                },
              },
              limit: LIMITS.entitiesCount,
            });
            return getFolderSubtree(all, sourceEntityId) ?? [];
          }),
        )
      : [source];

  if (subtree.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  const subtreeIds = subtree.map((entity) => entity.id);
  const readOnlyDescendants = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findMany({
        where: {
          id: { in: subtreeIds },
          workspaceId: { eq: sourceWorkspaceId },
          readOnly: { eq: true },
        },
        columns: { id: true },
      }),
    ),
  );
  if (readOnlyDescendants.length > 0) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }

  const sourceFieldList = subtree.flatMap(
    (entity) => entity.currentVersion?.fields ?? [],
  );

  const sourcePropertyIds = new Set(
    sourceFieldList.map((field) => field.propertyId),
  );

  const [sourceProperties, targetProperties] = yield* Result.await(
    safeDb( async (tx) =>
      Promise.all([
        tx.query.properties.findMany({
          where: { workspaceId: { eq: sourceWorkspaceId } },
          columns: { id: true, name: true, content: true },
        }),
        tx.query.properties.findMany({
          where: { workspaceId: { eq: targetWorkspaceId } },
          columns: { id: true, name: true, content: true },
        }),
      ]),
    ),
  );

  const sourcePropertiesUsed = sourceProperties
    .filter((p) => sourcePropertyIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, contentType: p.content.type }));

  const { propertyMap, droppedFields, hasFileFieldButNoFileProperty } =
    reconcileProperties({
      sourceProperties: sourcePropertiesUsed,
      targetProperties: targetProperties.map((p) => ({
        id: p.id,
        name: p.name,
        contentType: p.content.type,
      })),
      sourceFields: sourceFieldList,
    });

  if (hasFileFieldButNoFileProperty) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "Target matter has no matching file property; add one before moving",
      }),
    );
  }

  const plans: EntityCopyPlan[] = [];
  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();
  const sourceFileRefs: FileRef[] = [];

  for (const entity of subtree) {
    const newEntityId = createSafeId<"entity">();
    const newVersionId = createSafeId<"entityVersion">();
    idMap.set(entity.id, newEntityId);

    const fileCopies: FileCopyPlan[] = [];
    const rewrittenFields: EntityCopyPlan["rewrittenFields"] = [];

    for (const field of entity.currentVersion?.fields ?? []) {
      sourceFileRefs.push(...extractFileRefs(field.content));

      const targetPropertyId = propertyMap.get(field.propertyId);
      if (!targetPropertyId) {
        continue;
      }

      if (field.content.type === "file") {
        const { rewritten, copies } = rewriteFileContent({
          content: field.content,
          organizationId,
          sourceWorkspaceId,
          targetWorkspaceId,
        });
        fileCopies.push(...copies);
        rewrittenFields.push({
          propertyId: targetPropertyId,
          content: rewritten,
        });
        continue;
      }

      rewrittenFields.push({
        propertyId: targetPropertyId,
        content: field.content,
      });
    }

    plans.push({
      source: entity,
      newEntityId,
      newVersionId,
      rewrittenFields,
      fileCopies,
    });
  }

  const copiedKeys: string[] = [];
  for (const plan of plans) {
    for (const copy of plan.fileCopies) {
      const result = await copyS3Object(copy);
      if (Result.isError(result)) {
        await rollbackS3(copiedKeys);
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to copy file content to target matter",
          }),
        );
      }
      copiedKeys.push(copy.targetKey);
    }
  }

  const targetAuditContext = createAuditContext({
    organizationId,
    workspaceId: targetWorkspaceId,
    userId,
    request,
  });
  const sourceAuditContext = createAuditContext({
    organizationId,
    workspaceId: sourceWorkspaceId,
    userId,
    request,
  });

  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const targetEntityCount = await tx.$count(
        entities,
        eq(entities.workspaceId, targetWorkspaceId),
      );

      if (targetEntityCount + plans.length > LIMITS.entitiesCount) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Entities limit reached in target matter",
        };
      }

      const rootPlan = plans[0];
      if (!rootPlan) {
        return {
          ok: false as const,
          status: 500 as const,
          message: "Empty move plan",
        };
      }

      const rootName = await resolveEntityName({
        tx,
        workspaceId: targetWorkspaceId,
        parentId: null,
        name: rootPlan.source.name,
      });

      const rootSourceId = rootPlan.source.id;
      const newParentByPlan = new Map<
        SafeId<"entity">,
        SafeId<"entity"> | null
      >();
      const newNameByPlan = new Map<SafeId<"entity">, string>();

      for (const plan of plans) {
        const isRoot = plan.source.id === rootSourceId;
        const mappedParentId = plan.source.parentId
          ? (idMap.get(plan.source.parentId) ?? null)
          : null;
        const newParentId = isRoot ? null : mappedParentId;
        const newName = isRoot ? rootName : plan.source.name;
        newParentByPlan.set(plan.newEntityId, newParentId);
        newNameByPlan.set(plan.newEntityId, newName);

        const stamp =
          plan.source.kind === "document"
            ? await allocateEntityStamp(tx, targetWorkspaceId)
            : null;

        await tx.insert(entities).values({
          id: plan.newEntityId,
          workspaceId: targetWorkspaceId,
          kind: plan.source.kind,
          parentId: newParentId,
          name: newName,
          createdBy: userId,
          docSequence: stamp?.docSequence ?? null,
        });

        await tx.insert(entityVersions).values({
          id: plan.newVersionId,
          workspaceId: targetWorkspaceId,
          entityId: plan.newEntityId,
          versionNumber: 1,
          stamp: stamp?.stamp ?? null,
          verificationCode: stamp?.verificationCode ?? null,
        });

        await tx
          .update(entities)
          .set({ currentVersionId: plan.newVersionId })
          .where(eq(entities.id, plan.newEntityId));

        if (plan.rewrittenFields.length > 0) {
          await tx.insert(fields).values(
            plan.rewrittenFields.map((field) => ({
              workspaceId: targetWorkspaceId,
              propertyId: field.propertyId,
              entityVersionId: plan.newVersionId,
              content: field.content,
            })),
          );
        }
      }

      const deletedSource = await tx
        .delete(entities)
        .where(
          and(
            eq(entities.workspaceId, sourceWorkspaceId),
            inArray(entities.id, subtreeIds),
          ),
        )
        .returning({
          id: entities.id,
          kind: entities.kind,
          name: entities.name,
          parentId: entities.parentId,
        });

      const activityNow = new Date();
      await tx
        .update(workspaces)
        .set({ lastActivityAt: activityNow })
        .where(eq(workspaces.id, targetWorkspaceId));
      await tx
        .update(workspaces)
        .set({ lastActivityAt: activityNow })
        .where(eq(workspaces.id, sourceWorkspaceId));

      await writeAuditLog(
        plans.map((plan) => ({
          ...targetAuditContext,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: plan.newEntityId,
          changes: {
            created: {
              old: { sourceEntityId: plan.source.id },
              new: {
                kind: plan.source.kind,
                name: newNameByPlan.get(plan.newEntityId) ?? plan.source.name,
                parentId: newParentByPlan.get(plan.newEntityId) ?? null,
                workspaceId: targetWorkspaceId,
              },
            },
          },
        })),
        tx,
      );

      await writeAuditLog(
        deletedSource.map((entity) => ({
          ...sourceAuditContext,
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entity.id,
          changes: {
            deleted: {
              old: {
                kind: entity.kind,
                name: entity.name,
                parentId: entity.parentId,
              },
              new: null,
            },
          },
        })),
        tx,
      );

      return {
        ok: true as const,
        rootEntityId: rootPlan.newEntityId,
        entityIds: plans.map((plan) => plan.newEntityId),
        deletedSourceIds: deletedSource.map((entity) => entity.id),
      };
    }),
  );

  if (!txResult.ok) {
    await rollbackS3(copiedKeys);
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  if (sourceFileRefs.length > 0) {
    const deleteResult = await deleteS3Objects({
      fileRows: sourceFileRefs,
      organizationId,
      workspaceId: sourceWorkspaceId,
    });
    if (Result.isError(deleteResult)) {
      captureError(deleteResult.error);
    }
  }

  const provider = getSearchProvider();
  for (const sourceId of txResult.deletedSourceIds) {
    provider.removeEntity(sourceId).catch(captureError);
  }
  for (const entityId of txResult.entityIds) {
    processExtraction(entityId).catch(captureError);
  }

  return Result.ok({
    entityId: txResult.rootEntityId,
    droppedFields,
  });
};

const rollbackS3 = async (keys: string[]) => {
  if (keys.length === 0) {
    return;
  }
  const result = await deleteS3Keys(keys);
  if (Result.isError(result)) {
    captureError(result.error);
  }
};

const config = {
  permissions: { entity: ["update"] },
  body: moveToMatterBodySchema,
} satisfies HandlerConfig;

const moveToMatter = createSafeHandler(
  config,
  async function* ({
    safeDb,
    accessibleWorkspaces,
    session,
    workspaceId,
    user,
    request,
    body,
  }) {
    return yield* moveToMatterHandler({
      safeDb,
      accessibleWorkspaces,
      organizationId: session.activeOrganizationId,
      sourceWorkspaceId: workspaceId,
      userId: user.id,
      request,
      body,
    });
  },
);

export default moveToMatter;
