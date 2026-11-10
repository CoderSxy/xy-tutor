import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_IMAGES,
  assertImageInputSupported,
  imageSubmissionInput,
} from "../../packages/contracts/src/conversation-images.js";
import { AppError } from "../../packages/contracts/src/api.js";

const file = () => crypto.randomUUID();

describe("image submissions", () => {
  it("accepts image only and rejects empty or four images", () => {
    const one = imageSubmissionInput.parse({
      message: "",
      attachmentIds: [file()],
    });
    expect(one.attachmentIds).toHaveLength(1);
    expect(one.message).toBe("");

    expect(() =>
      imageSubmissionInput.parse({ message: "   ", attachmentIds: [] }),
    ).toThrow();

    expect(() =>
      imageSubmissionInput.parse({
        message: "",
        attachmentIds: Array.from({ length: MAX_MESSAGE_IMAGES + 1 }, file),
      }),
    ).toThrow();

    const duplicate = file();
    expect(() =>
      imageSubmissionInput.parse({ message: "", attachmentIds: [duplicate, duplicate] }),
    ).toThrow();
  });

  it("rejects images when the model cannot read them", () => {
    expect(() =>
      assertImageInputSupported([file()], { images: "disabled" }),
    ).toThrow(AppError);
    expect(() => assertImageInputSupported([], { images: "disabled" })).not.toThrow();
    expect(() =>
      assertImageInputSupported([file()], { images: "enabled-unverified" }),
    ).not.toThrow();
    expect(() =>
      assertImageInputSupported([file()], undefined),
    ).toThrow(AppError);
  });
});
