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

const { default: copyToMatter } = await import("./copy-to-matter");

const organizationId = toSafeId<"organization">("organization_1");
const sourceWorkspaceId = toSafeId<"workspace">("workspace_src");
const targetWorkspaceId = toSafeId<"workspace">("workspace_tgt");
const userId = toSafeId<"user">("user_1");
const documentId = toSafeId<"entity">("entity_doc");
const sourceFileProperty = toSafeId<"property">("prop_src_file");
const sourceTextProperty = toSafeId<"property">("prop_src_text");
const sourceOrphanProperty = toSafeId<"property">("prop_src_orphan");
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
  currentVersion: {
    fields: [
      { propertyId: sourceFileProperty, content: fileFieldContent },
      { propertyId: sourceTextProperty, content: textFieldContent },
    ],
  },
};

type CopyHandlerArgs = Parameters<typeof copyToMatter.handler>[0];

const baseContext = {
  workspaceId: sourceWorkspaceId,
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
  memberRole: { role: "owner" },
  request: new Request("https://example.test/v1/entities/copy-to-matter"),
  route: "/v1/entities/:workspaceId/copy-to-matter",
};

const buildContext = (overrides: {
  accessibleWorkspaces: { id: SafeId<"workspace">; status: string }[];
  body: { entityId: SafeId<"entity">; targetWorkspaceId: SafeId<"workspace"> };
  safeDb: CopyHandlerArgs["safeDb"];
}): CopyHandlerArgs =>
  // SAFETY: test fixture only provides fields touched by the handler.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  ({
    ...baseContext,
    ...overrides,
  }) as CopyHandlerArgs;

describe("copy entity to another matter", () => {
  test("404 when target workspace is not accessible", async () => {
    const { safeDb } = createScopedDbMock({});

    const result = await copyToMatter.handler(
      buildContext({
        accessibleWorkspaces: [{ id: sourceWorkspaceId, status: "active" }],
        body: { entityId: documentId, targetWorkspaceId },
        safeDb,
      }),
    );

    expect(result).toMatchObject({ code: 404 });
  });

  test("400 when target equals source", async () => {
    const { safeDb } = createScopedDbMock({});

    const result = await copyToMatter.handler(
      buildContext({
        accessibleWorkspaces: [{ id: sourceWorkspaceId, status: "active" }],
        body: { entityId: documentId, targetWorkspaceId: sourceWorkspaceId },
        safeDb,
      }),
    );

    expect(result).toMatchObject({ code: 400 });
  });

  test("400 when target has no matching file property", async () => {
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceDocument,
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
              ];
            }
            return [
              {
                id: targetTextProperty,
                name: "Documents",
                content: { type: "text", version: 1 },
              },
            ];
          },
        },
      },
    };
    const { safeDb } = createScopedDbMock(tx);

    const result = await copyToMatter.handler(
      buildContext({
        accessibleWorkspaces: [
          { id: sourceWorkspaceId, status: "active" },
          { id: targetWorkspaceId, status: "active" },
        ],
        body: { entityId: documentId, targetWorkspaceId },
        safeDb,
      }),
    );

    expect(result).toMatchObject({ code: 400 });
  });

  test("copies a document, rewrites file content, drops unmapped fields", async () => {
    s3WriteMock.mockClear();
    s3FileMock.mockClear();
    processExtractionMock.mockClear();

    const sourceWithExtraField = {
      ...sourceDocument,
      currentVersion: {
        fields: [
          { propertyId: sourceFileProperty, content: fileFieldContent },
          { propertyId: sourceTextProperty, content: textFieldContent },
          { propertyId: sourceOrphanProperty, content: textFieldContent },
        ],
      },
    };

    type InsertedEntity = {
      id: string;
      parentId: string | null;
      name: string;
      kind: string;
    };
    type InsertedField = { propertyId: string; content: FieldContent };
    const insertedEntities: InsertedEntity[] = [];
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;

    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceWithExtraField,
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
                {
                  id: sourceOrphanProperty,
                  name: "OnlyInSource",
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
            // SAFETY: fixture asserts the handler inserts a row whose shape
            // matches InsertedEntity; the mock has no other way to type-narrow.
            // eslint-disable-next-line typescript/no-unsafe-type-assertion
            insertedEntities.push(value as InsertedEntity);
          } else if (table === fields) {
            const rows = Array.isArray(value) ? value : [value];
            for (const row of rows) {
              // SAFETY: as above — the handler inserts InsertedField rows.
              // eslint-disable-next-line typescript/no-unsafe-type-assertion
              insertedFields.push(row as InsertedField);
            }
          } else if (
            table !== auditLogs &&
            table !== entityVersions &&
            table !== properties
          ) {
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
    };

    const { safeDb } = createScopedDbMock(tx);

    const result = await copyToMatter.handler(
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
      droppedFields: 1,
    });
    expect(insertedEntities).toHaveLength(1);
    expect(insertedEntities.at(0)?.kind).toBe("document");
    expect(insertedEntities.at(0)?.parentId).toBeNull();

    expect(insertedFields).toHaveLength(2);
    const fileField = insertedFields.find((f) => f.content.type === "file");
    expect(fileField).toBeDefined();
    if (fileField && fileField.content.type === "file") {
      expect(fileField.content.id).not.toBe(fileFieldContent.id);
      expect(fileField.propertyId).toBe(targetFileProperty);
    }
    const textField = insertedFields.find((f) => f.content.type === "text");
    expect(textField?.propertyId).toBe(targetTextProperty);

    expect(s3WriteMock).toHaveBeenCalledTimes(1);
    expect(processExtractionMock).toHaveBeenCalledTimes(1);
  });
});
