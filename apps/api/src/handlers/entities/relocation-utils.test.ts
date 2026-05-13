import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { reconcileProperties } from "@/api/handlers/entities/relocation-utils";
import { toSafeId } from "@/api/lib/branded-types";

const sourceTextId = toSafeId<"property">("prop_src_text");
const sourceFileId = toSafeId<"property">("prop_src_file");
const sourceUnmappedId = toSafeId<"property">("prop_src_unmapped");
const targetTextId = toSafeId<"property">("prop_tgt_text");
const targetFileId = toSafeId<"property">("prop_tgt_file");
const targetWrongTypeId = toSafeId<"property">("prop_tgt_wrongtype");

const fileFieldContent: FieldContent = {
  type: "file",
  version: 1,
  id: "00000000-0000-0000-0000-000000000001",
  fileName: "doc.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
};

const textFieldContent: FieldContent = {
  type: "text",
  version: 1,
  value: "hello",
};

describe("reconcileProperties", () => {
  test("matches by (name, contentType) and maps source to target ids", () => {
    const result = reconcileProperties({
      sourceProperties: [
        { id: sourceTextId, name: "Notes", contentType: "text" },
        { id: sourceFileId, name: "File", contentType: "file" },
      ],
      targetProperties: [
        { id: targetTextId, name: "Notes", contentType: "text" },
        { id: targetFileId, name: "File", contentType: "file" },
      ],
      sourceFields: [
        { propertyId: sourceTextId, content: textFieldContent },
        { propertyId: sourceFileId, content: fileFieldContent },
      ],
    });

    expect(result.propertyMap.get(sourceTextId)).toBe(targetTextId);
    expect(result.propertyMap.get(sourceFileId)).toBe(targetFileId);
    expect(result.droppedFields).toBe(0);
    expect(result.hasFileFieldButNoFileProperty).toBe(false);
  });

  test("drops fields whose property has no name match in target", () => {
    const result = reconcileProperties({
      sourceProperties: [
        { id: sourceUnmappedId, name: "OnlyInSource", contentType: "text" },
      ],
      targetProperties: [
        { id: targetTextId, name: "Notes", contentType: "text" },
      ],
      sourceFields: [
        { propertyId: sourceUnmappedId, content: textFieldContent },
        { propertyId: sourceUnmappedId, content: textFieldContent },
      ],
    });

    expect(result.propertyMap.size).toBe(0);
    expect(result.droppedFields).toBe(2);
    expect(result.hasFileFieldButNoFileProperty).toBe(false);
  });

  test("does not match when name agrees but content type differs", () => {
    const result = reconcileProperties({
      sourceProperties: [
        { id: sourceTextId, name: "Notes", contentType: "text" },
      ],
      targetProperties: [
        { id: targetWrongTypeId, name: "Notes", contentType: "int" },
      ],
      sourceFields: [{ propertyId: sourceTextId, content: textFieldContent }],
    });

    expect(result.propertyMap.size).toBe(0);
    expect(result.droppedFields).toBe(1);
  });

  test("flags hasFileFieldButNoFileProperty when source has unmapped file field", () => {
    const result = reconcileProperties({
      sourceProperties: [
        { id: sourceFileId, name: "File", contentType: "file" },
      ],
      targetProperties: [
        { id: targetTextId, name: "File", contentType: "text" },
      ],
      sourceFields: [{ propertyId: sourceFileId, content: fileFieldContent }],
    });

    expect(result.hasFileFieldButNoFileProperty).toBe(true);
    expect(result.droppedFields).toBe(1);
  });

  test("does not flag when file field maps to a target file property", () => {
    const result = reconcileProperties({
      sourceProperties: [
        { id: sourceFileId, name: "Documents", contentType: "file" },
      ],
      targetProperties: [
        { id: targetFileId, name: "Documents", contentType: "file" },
      ],
      sourceFields: [{ propertyId: sourceFileId, content: fileFieldContent }],
    });

    expect(result.hasFileFieldButNoFileProperty).toBe(false);
    expect(result.propertyMap.get(sourceFileId)).toBe(targetFileId);
  });
});
