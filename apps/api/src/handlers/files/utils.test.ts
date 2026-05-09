import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

const writeMock = mock(async (_target: string, _source: unknown) => {});
const fileMock = mock((key: string) => ({ __sourceKey: key }));

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    write: writeMock,
    file: fileMock,
  }),
}));

const { copyS3Object } = await import("./utils");

describe("copyS3Object", () => {
  test("forwards source/target keys to S3 and returns ok", async () => {
    writeMock.mockClear();
    fileMock.mockClear();

    const result = await copyS3Object({
      sourceKey: "org_1/ws_1/file_1.pdf",
      targetKey: "org_1/ws_2/file_1.pdf",
    });

    expect(Result.isError(result)).toBe(false);
    expect(fileMock).toHaveBeenCalledWith("org_1/ws_1/file_1.pdf");
    expect(writeMock).toHaveBeenCalledWith("org_1/ws_2/file_1.pdf", {
      __sourceKey: "org_1/ws_1/file_1.pdf",
    });
  });

  test("wraps S3 failures in a tagged S3Error referencing the target key", async () => {
    writeMock.mockImplementationOnce(async () => {
      throw new Error("s3 write boom");
    });

    const result = await copyS3Object({
      sourceKey: "org_1/ws_1/file_1.pdf",
      targetKey: "org_1/ws_2/file_1.pdf",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("S3Error");
      expect(result.error.key).toBe("org_1/ws_2/file_1.pdf");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });
});
