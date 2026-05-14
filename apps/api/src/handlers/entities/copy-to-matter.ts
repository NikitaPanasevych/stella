import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { getFolderSubtree } from "@/api/handlers/entities/duplicate";
import type { EntitySnapshot } from "@/api/handlers/entities/duplicate";
import {
  reconcileProperties,
  resolveTargetEntityName,
  rewriteFileContent,
} from "@/api/handlers/entities/relocation-utils";
import type { FileCopyPlan } from "@/api/handlers/entities/relocation-utils";
import { copyS3Object, deleteS3Keys } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { processExtraction } from "@/api/lib/search/process-extraction";

const copyToMatterBodySchema = t.Object({
  entityId: tSafeId("entity"),
  targetWorkspaceId: tSafeId("workspace"),
});

type CopyToMatterBody = Static<typeof copyToMatterBodySchema>;

type EntityCopyPlan = {
  source: EntitySnapshot;
  newEntityId: SafeId<"entity">;
  newVersionId: SafeId<"entityVersion">;
  rewrittenFields: { propertyId: SafeId<"property">; content: FieldContent }[];
  fileCopies: FileCopyPlan[];
};

type CopyToMatterHandlerOptions = {
  safeDb: SafeDb;
  accessibleWorkspaces: AccessibleWorkspace[];
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  request: Request;
  server: Parameters<typeof createAuditContext>[0]["server"];
  body: CopyToMatterBody;
};

const copyToMatterHandler = async function* ({
  safeDb,
  accessibleWorkspaces,
  organizationId,
  sourceWorkspaceId,
  userId,
  request,
  server,
  body,
}: CopyToMatterHandlerOptions) {
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

  const targetPermission = await getAuth().api.hasPermission({
    headers: request.headers,
    body: { permissions: { entity: ["create"] } },
  });
  if (!targetPermission.success) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Not allowed to create entities in target matter",
      }),
    );
  }

  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: sourceEntityId },
          workspaceId: { eq: sourceWorkspaceId },
        },
        columns: { id: true, kind: true, name: true, parentId: true },
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

  const sourceFieldList = subtree.flatMap(
    (entity) => entity.currentVersion?.fields ?? [],
  );

  const sourcePropertyIds = new Set(
    sourceFieldList.map((field) => field.propertyId),
  );

  const [sourceProperties, targetProperties] = yield* Result.await(
    safeDb(
      async (tx) =>
        await Promise.all([
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
    .map((p) => ({
      id: p.id,
      name: p.name,
      contentType: p.content.type,
    }));

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
          "Target matter has no matching file property; add one before copying",
      }),
    );
  }

  const plans: EntityCopyPlan[] = [];
  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();

  for (const entity of subtree) {
    const newEntityId = createSafeId<"entity">();
    const newVersionId = createSafeId<"entityVersion">();
    idMap.set(entity.id, newEntityId);

    const fileCopies: FileCopyPlan[] = [];
    const rewrittenFields: EntityCopyPlan["rewrittenFields"] = [];

    for (const field of entity.currentVersion?.fields ?? []) {
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
        captureError(result.error, {
          sourceKey: copy.sourceKey,
          targetKey: copy.targetKey,
          sourceWorkspaceId,
          targetWorkspaceId,
        });
        await rollbackS3(copiedKeys);
        return Result.err(
          new HandlerError({
            status: 500,
            message: `Failed to copy file content (${copy.sourceKey} -> ${copy.targetKey})`,
            cause: result.error,
          }),
        );
      }
      copiedKeys.push(copy.targetKey);
    }
  }

  const auditContext = createAuditContext({
    organizationId,
    workspaceId: targetWorkspaceId,
    userId,
    request,
    server,
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
          message: "Empty copy plan",
        };
      }

      const { renamed: rootRenamed, value: rootName } =
        await resolveTargetEntityName({
          tx,
          targetWorkspaceId,
          parentId: null,
          name: rootPlan.source.name,
        });

      if (rootRenamed) {
        // Only sync the file field whose fileName was in lockstep with
        // the source entity name (the canonical primary content). Other
        // file fields — attachments, custom labels — are left alone.
        rootPlan.rewrittenFields = rootPlan.rewrittenFields.map((field) =>
          field.content.type === "file" &&
          field.content.fileName === rootPlan.source.name
            ? {
                ...field,
                content: { ...field.content, fileName: rootName },
              }
            : field,
        );
      }

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

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, targetWorkspaceId));

      await writeAuditLog(
        plans.map((plan) => ({
          ...auditContext,
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

      return {
        ok: true as const,
        rootEntityId: rootPlan.newEntityId,
        entityIds: plans.map((plan) => plan.newEntityId),
      };
    }),
  );

  if (!txResult.ok) {
    await rollbackS3(copiedKeys);
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
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
  permissions: { entity: ["create"] },
  body: copyToMatterBodySchema,
} satisfies HandlerConfig;

const copyToMatter = createSafeHandler(
  config,
  async function* ({
    safeDb,
    accessibleWorkspaces,
    session,
    workspaceId,
    user,
    request,
    server,
    body,
  }) {
    return yield* copyToMatterHandler({
      safeDb,
      accessibleWorkspaces,
      organizationId: session.activeOrganizationId,
      sourceWorkspaceId: workspaceId,
      userId: user.id,
      request,
      server,
      body,
    });
  },
);

export default copyToMatter;
