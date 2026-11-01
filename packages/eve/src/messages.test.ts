import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lastTextByRole, textOf, toolNamesIn } from "./messages.js";

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

describe("toolNamesIn", () => {
  it("collects assistant tool-call names once each, in order, never arguments", () => {
    const messages = [
      { role: "user", content: "Send the weekly digest" },
      { role: "assistant", content: [
        { type: "text", text: "On it." },
        { type: "tool-call", toolCallId: "1", toolName: "send_email", input: { to: "x@y.z" } },
        { type: "tool-call", toolCallId: "2", toolName: "calendar.list", input: {} },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "send_email", output: { type: "text", value: "ok" } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "3", toolName: "send_email", input: {} }] },
    ];
    assert.deepEqual(toolNamesIn(messages), ["send_email", "calendar.list"]);
    assert.deepEqual(toolNamesIn([{ role: "assistant", content: "plain text" }]), []);
    assert.deepEqual(toolNamesIn([]), []);
  });
});
