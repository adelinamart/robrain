import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lastTextByRole, textOf } from "./messages.js";

describe("textOf", () => {
  it("string content and text parts; ignores non-text parts", () => {
    assert.equal(textOf("hi"), "hi");
    assert.equal(textOf([{ type: "text", text: "a" }, { type: "file", data: "x" }, { type: "text", text: "b" }]), "a\nb");
    assert.equal(textOf(42), "");
  });
});

describe("lastTextByRole", () => {
  it("finds the last non-empty message of a role", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply one" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "x" }] },
      { role: "assistant", content: "final answer" },
    ];
    assert.equal(lastTextByRole(messages, "user"), "second");
    assert.equal(lastTextByRole(messages, "assistant"), "final answer");
    assert.equal(lastTextByRole(messages, "system"), "");
  });
});
