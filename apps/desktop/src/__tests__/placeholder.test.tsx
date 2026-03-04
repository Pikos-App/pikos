import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("renders HTML", () => {
    const { getByText } = render(<p>hello</p>);
    expect(getByText("hello")).toBeInTheDocument();
  });
});
