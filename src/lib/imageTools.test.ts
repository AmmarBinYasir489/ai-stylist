import { describe, expect, it } from "vitest";
import { hexForColorName, nearestColorName, sha256Hex } from "./imageTools";

describe("image analysis helpers", () => {
  it("maps LAB values to a readable nearest color", () => {
    expect(nearestColorName([20, 0, 0])).toBe("charcoal");
    expect(nearestColorName([95, 0, 0])).toBe("white");
  });

  it("maps stored color names back to their canonical hex value", () => {
    expect(hexForColorName("navy blue")).toBe("#22314f");
    expect(hexForColorName("unknown color")).toBeNull();
  });

  it("uses content hashes to identify duplicate uploads", async () => {
    const first = new Blob(["same garment bytes"], { type: "image/png" });
    const second = new Blob(["same garment bytes"], { type: "image/png" });
    const different = new Blob(["different garment bytes"], { type: "image/png" });

    await expect(sha256Hex(first)).resolves.toBe(await sha256Hex(second));
    await expect(sha256Hex(first)).resolves.not.toBe(await sha256Hex(different));
  });
});
