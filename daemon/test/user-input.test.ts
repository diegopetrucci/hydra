import { describe, expect, it } from "vitest";
import { modelMessagesAreHuman } from "../src/user-input.js";

const user = (content: string | { type: "text"; text: string }[]) => ({
  role: "user",
  content,
  timestamp: 0,
});

describe("modelMessagesAreHuman", () => {
  it("fails closed on empty or missing model", () => {
    expect(modelMessagesAreHuman([])).toBe(false);
    expect(modelMessagesAreHuman(undefined)).toBe(false);
  });
  it("accepts a plain user message, string or text blocks", () => {
    expect(modelMessagesAreHuman([user("hello")])).toBe(true);
    expect(modelMessagesAreHuman([user([{ type: "text", text: "hi" }])])).toBe(true);
  });
  it("rejects marker-prefixed input", () => {
    expect(modelMessagesAreHuman([user("[Hydra check-in] go")])).toBe(false);
  });
  it("inspects the LAST message, not the first", () => {
    expect(modelMessagesAreHuman([user("hello"), user("[Hydra CI] x")])).toBe(false);
    expect(modelMessagesAreHuman([user("[Hydra intro]"), user("real")])).toBe(true);
  });
  it("rejects a non-user last message or empty text", () => {
    expect(modelMessagesAreHuman([user("hello"), { role: "assistant", content: [] }])).toBe(false);
    expect(modelMessagesAreHuman([user("")])).toBe(false);
    expect(modelMessagesAreHuman([user([])])).toBe(false);
  });
});
