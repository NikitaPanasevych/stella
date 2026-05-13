import { describe, expect, mock, test } from "bun:test";

import {
  auditLogs,
  documentCounters,
  entities,
  entityVersions,
  fields,
  properties,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const processExtractionMock = mock(async () => {});

void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));

const removeEntityMock = mock(async () => {});

void mock.module("@/api/lib/search/provider", () => ({
  getSearchProvider: () => ({ removeEntity: removeEntityMock }),
}));

const s3WriteMock = mock(async () => {});
const s3FileMock = mock((key: string) => ({ __sourceKey: key }));
const s3DeleteMock = mock(async () => {});

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    write: s3WriteMock,
    file: s3FileMock,
    delete: s3DeleteMock,
  }),
}));

const { default: moveToMatter } = await import("./move-to-matter");

const organizationId = toSafeId<"organization">("organization_1");
const sourceWorkspaceId = toSafeId<"workspace">("workspace_src");
const targetWorkspaceId = toSafeId<"workspace">("workspace_tgt");
const userId = toSafeId<"user">("user_1");
const documentId = toSafeId<"entity">("entity_doc");
const sourceFileProperty = toSafeId<"property">("prop_src_file");
const sourceTextProperty = toSafeId<"property">("prop_src_text");
const targetFileProperty = toSafeId<"property">("prop_tgt_file");
const targetTextProperty = toSafeId<"property">("prop_tgt_text");

const fileFieldContent = {
  type: "file" as const,
  version: 1 as const,
  id: "00000000-0000-0000-0000-000000000001",
  fileName: "doc.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
} satisfies FieldContent;

const textFieldContent = {
  type: "text" as const,
  version: 1 as const,
  value: "hello",
} satisfies FieldContent;

const sourceDocument = {
  id: documentId,
  kind: "document" as const,
  name: "Memo.pdf",
  parentId: null,
  readOnly: false,
  currentVersion: {
    fields: [
      { propertyId: sourceFileProperty, content: fileFieldContent },
      { propertyId: sourceTextProperty, content: textFieldContent },
    ],
  },
};

type MoveHandlerArgs = Parameters<typeof moveToMatter.handler>[0];

const baseContext = {
  workspaceId: sourceWorkspaceId,
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
  memberRole: { role: "owner" },
  request: new Request("https://example.test/v1/entities/move-to-matter"),
  route: "/v1/entities/:workspaceId/move-to-matter",
};

const buildContext = (overrides: {
  accessibleWorkspaces: { id: SafeId<"workspace">; status: string }[];
  body: { entityId: SafeId<"entity">; targetWorkspaceId: SafeId<"workspace"> };
  safeDb: MoveHandlerArgs["safeDb"];
}): MoveHandlerArgs =>
  // SAFETY: test fixture only provides fields touched by the handler.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  ({
    ...baseContext,
    ...overrides,
  }) as MoveHandlerArgs;

describe("move entity to another matter", () => {
  test("409 when source entity is read-only", async () => {
    const tx = {
      query: {
        entities: {
          findFirst: async () => ({ ...sourceDocument, readOnly: true }),
        },
      },
    };
    const { safeDb } = createScopedDbMock(tx);

    const result = await moveToMatter.handler(
      buildContext({
        accessibleWorkspaces: [
          { id: sourceWorkspaceId, status: "active" },
          { id: targetWorkspaceId, status: "active" },
        ],
        body: { entityId: documentId, targetWorkspaceId },
        safeDb,
      }),
    );

    expect(result).toMatchObject({ code: 409 });
  });

  test("404 when target workspace is not accessible", async () => {
    const { safeDb } = createScopedDbMock({});

    const result = await moveToMatter.handler(
      buildContext({
        accessibleWorkspaces: [{ id: sourceWorkspaceId, status: "active" }],
        body: { entityId: documentId, targetWorkspaceId },
        safeDb,
      }),
    );

    expect(result).toMatchObject({ code: 404 });
  });

  test(
    "copies subtree to target, deletes source, writes bilateral audit, " +
      "removes source from search",
    async () => {
      s3WriteMock.mockClear();
      s3FileMock.mockClear();
      processExtractionMock.mockClear();
      removeEntityMock.mockClear();

      type InsertedEntity = {
        id: string;
        parentId: string | null;
        name: string;
        kind: string;
        workspaceId: string;
      };
      type InsertedField = { propertyId: string; content: FieldContent };
      type AuditRow = { action: string; resourceId: string };
      const insertedEntities: InsertedEntity[] = [];
      const insertedFields: InsertedField[] = [];
      const insertedAudits: AuditRow[] = [];
      const deletedEntityIds: string[] = [];
      let nextDocumentSequence = 0;

      const tx = {
        query: {
          entities: {
            findFirst: async () => sourceDocument,
            findMany: async ({
              where,
            }: {
              where: { readOnly?: { eq: boolean } };
            }) => {
              if (where.readOnly?.eq === true) {
                return [];
              }
              return [];
            },
          },
          properties: {
            findMany: async ({
              where,
            }: {
              where: { workspaceId: { eq: SafeId<"workspace"> } };
            }) => {
              if (where.workspaceId.eq === sourceWorkspaceId) {
                return [
                  {
                    id: sourceFileProperty,
                    name: "Documents",
                    content: { type: "file", version: 1 },
                  },
                  {
                    id: sourceTextProperty,
                    name: "Notes",
                    content: { type: "text", version: 1 },
                  },
                ];
              }
              return [
                {
                  id: targetFileProperty,
                  name: "Documents",
                  content: { type: "file", version: 1 },
                },
                {
                  id: targetTextProperty,
                  name: "Notes",
                  content: { type: "text", version: 1 },
                },
              ];
            },
          },
          workspaces: {
            findFirst: async () => ({ reference: null }),
          },
        },
        $count: async () => 0,
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
        insert: (table: unknown) => ({
          values: (value: unknown) => {
            if (table === documentCounters) {
              return {
                onConflictDoUpdate: () => ({
                  returning: async () => {
                    nextDocumentSequence += 1;
                    return [{ lastValue: nextDocumentSequence }];
                  },
                }),
              };
            }

            if (table === entities) {
              // SAFETY: fixture asserts the handler inserts an InsertedEntity.
              // eslint-disable-next-line typescript/no-unsafe-type-assertion
              insertedEntities.push(value as InsertedEntity);
            } else if (table === fields) {
              const rows = Array.isArray(value) ? value : [value];
              for (const row of rows) {
                // SAFETY: handler inserts InsertedField rows.
                // eslint-disable-next-line typescript/no-unsafe-type-assertion
                insertedFields.push(row as InsertedField);
              }
            } else if (table === auditLogs) {
              const rows = Array.isArray(value) ? value : [value];
              for (const row of rows) {
                // SAFETY: handler emits AuditRow-shaped entries.
                // eslint-disable-next-line typescript/no-unsafe-type-assertion
                insertedAudits.push(row as AuditRow);
              }
            } else if (table !== entityVersions && table !== properties) {
              // Unknown insert target — ignore in fixture.
            }
            return undefined;
          },
        }),
        update: () => ({
          set: () => ({
            where: async () => {},
          }),
        }),
        delete: () => ({
          where: () => ({
            returning: async () => {
              deletedEntityIds.push(String(documentId));
              return [
                {
                  id: documentId,
                  kind: "document",
                  name: "Memo.pdf",
                  parentId: null,
                },
              ];
            },
          }),
        }),
      };
      const { safeDb } = createScopedDbMock(tx);

      const result = await moveToMatter.handler(
        buildContext({
          accessibleWorkspaces: [
            { id: sourceWorkspaceId, status: "active" },
            { id: targetWorkspaceId, status: "active" },
          ],
          body: { entityId: documentId, targetWorkspaceId },
          safeDb,
        }),
      );

      expect(result).toMatchObject({
        entityId: expect.any(String),
        droppedFields: 0,
      });

      expect(insertedEntities).toHaveLength(1);
      expect(insertedEntities.at(0)?.workspaceId).toBe(targetWorkspaceId);
      expect(insertedFields).toHaveLength(2);

      const createAudits = insertedAudits.filter((a) => a.action === "create");
      const deleteAudits = insertedAudits.filter((a) => a.action === "delete");
      expect(createAudits).toHaveLength(1);
      expect(deleteAudits).toHaveLength(1);
      expect(deleteAudits.at(0)?.resourceId).toBe(documentId);

      expect(s3WriteMock).toHaveBeenCalledTimes(1);
      expect(s3DeleteMock).toHaveBeenCalled();
      expect(removeEntityMock).toHaveBeenCalledWith(documentId);
      expect(processExtractionMock).toHaveBeenCalledTimes(1);
    },
  );
});
