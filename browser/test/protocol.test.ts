import assert from "node:assert/strict";
import test from "node:test";
import { parseServerMessage } from "../lib/protocol.ts";

function frame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    id: "msg_test",
    datatype: "latex",
    sent_at: "2025-01-01T00:00:00Z",
    payload: "x^2",
    ...overrides,
  });
}

const textPayloads = {
  plaintext: "hello world",
  latex: "x^2",
  smiles: "CCO",
  tikz: "\\draw (0,0) -- (1,1);",
};

for (const [datatype, payload] of Object.entries(textPayloads)) {
  test(`parses ${datatype} text`, () => {
    const result = parseServerMessage(frame({ datatype, payload }));

    assert.ok(result.ok);
    assert.equal(result.message.datatype, datatype);
  });
}

test("parses an image datatype with its base64 payload", () => {
  const result = parseServerMessage(
    frame({ datatype: "image/png", payload: "iVBORw0KGgo=" }),
  );

  assert.ok(result.ok);
  assert.deepEqual(result.message, {
    version: 1,
    id: "msg_test",
    datatype: "image/png",
    sent_at: "2025-01-01T00:00:00Z",
    payload: "iVBORw0KGgo=",
  });
});

test("reports unsupported datatypes", () => {
  const result = parseServerMessage(frame({ datatype: "future/type" }));

  assert.ok(!result.ok);
  assert.equal(result.reason, "unsupported-datatype");
});

test("rejects unparseable input", () => {
  const result = parseServerMessage("not json at all");

  assert.ok(!result.ok);
  assert.equal(result.reason, "frame is not valid JSON");
});

const malformedEnvelopes = [
  { name: "wrong version", overrides: { version: 2 } },
  { name: "empty id", overrides: { id: "" } },
  { name: "missing id", overrides: { id: undefined } },
  { name: "invalid sent_at", overrides: { sent_at: "not-a-date" } },
  { name: "invalid datatype", overrides: { datatype: "Not Valid" } },
  { name: "non-string payload", overrides: { payload: 42 } },
  { name: "missing payload", overrides: { payload: undefined } },
];

for (const { name, overrides } of malformedEnvelopes) {
  test(`rejects ${name}`, () => {
    const result = parseServerMessage(frame(overrides));

    assert.ok(!result.ok);
  });
}

for (const [name, payload] of [
  ["empty", ""],
  ["whitespace-only", "   "],
]) {
  test(`rejects ${name} text`, () => {
    const result = parseServerMessage(frame({ payload }));

    assert.ok(!result.ok);
    assert.equal(result.reason, "text payload must not be empty");
  });
}

test("rejects an empty image payload", () => {
  const result = parseServerMessage(frame({ datatype: "image/png", payload: "" }));

  assert.ok(!result.ok);
  assert.equal(result.reason, "image payload must not be empty");
});

test("rejects invalid image base64", () => {
  const result = parseServerMessage(
    frame({ datatype: "image/png", payload: "not base64!" }),
  );

  assert.ok(!result.ok);
  assert.equal(result.reason, "image payload must be single-line base64");
});
