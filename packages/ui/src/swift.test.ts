import { describe, expect, it } from "vitest";

import {
  renderAssetColors,
  renderEditorCssBlock,
  renderSwiftTokens,
  resolveColor,
  rgbaLiteral,
  swiftName,
} from "./swift.ts";
import { hex, mix, ref, transparent } from "./token-types.ts";

describe("native colour resolution", () => {
  it("resolves a mix into transparent as the colour at that alpha, the way CSS does", () => {
    const tint = mix("srgb", hex("#2dd4a8"), 12, transparent);
    expect(rgbaLiteral(resolveColor(tint, "dark"))).toBe("0x2DD4A81F");
  });

  it("follows refs per scheme", () => {
    expect(rgbaLiteral(resolveColor(ref("brand-identity"), "light"))).toBe("0xA65544FF");
    expect(rgbaLiteral(resolveColor(ref("brand-identity"), "dark"))).toBe("0xC06A58FF");
  });

  it("names tokens the way Swift spells them", () => {
    expect(swiftName("surface-nav-selected")).toBe("surfaceNavSelected");
    expect(swiftName("color-folder-red")).toBe("folderRed");
  });
});

describe("Swift palette", () => {
  const swift = renderSwiftTokens();

  it("carries the surfaces, the interactive teal and the folder palette in both schemes", () => {
    expect(swift).toContain(
      "public static let surfacePrimary = TokenColor(light: 0xFFFFFFFF, dark: 0x161613FF)"
    );
    expect(swift).toContain(
      "public static let interactivePrimary = TokenColor(light: 0x1AAE8AFF, dark: 0x2DD4A8FF)"
    );
    expect(swift).toContain("public static let folderBlue = TokenColor(light: 0x539BF5FF");
  });

  it("carries the type scale and radii", () => {
    expect(swift).toContain("public static let typeUiSm = TokenType(size: 11, weight: 500");
    expect(swift).toContain("public static let radiusMd: Double = 6");
  });

  it("leaves the web-only aliases out", () => {
    expect(swift).not.toContain("sidebarAccent");
    expect(swift).not.toContain("chart1");
  });
});

describe("asset catalog colours", () => {
  it("writes a light and a dark appearance for the accent", () => {
    const accent = renderAssetColors().find((a) => a.path.includes("AccentColor"))!;
    const json = JSON.parse(accent.contents) as {
      colors: { appearances?: { value: string }[]; color: { components: { red: string } } }[];
    };
    expect(json.colors).toHaveLength(2);
    expect(json.colors[0]!.color.components.red).toBe("0x11");
    expect(json.colors[1]!.appearances?.[0]?.value).toBe("dark");
    expect(json.colors[1]!.color.components.red).toBe("0x2D");
  });
});

describe("editor stylesheet block", () => {
  it("declares both schemes and renders alpha tokens as rgba", () => {
    const css = renderEditorCssBlock();
    expect(css).toContain("  --pikos-bg: #161613;");
    expect(css).toContain("  --pikos-accent: #117a60;");
    expect(css).toContain("  --pikos-selection: rgba(45, 212, 168, 0.12);");
  });
});
