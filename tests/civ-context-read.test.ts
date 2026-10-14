import test from "node:test";
import assert from "node:assert/strict";
import {
  planContextRead,
  isAllowedContextReadRequest,
  decodeContextReadResponse,
  type ContextReadKind,
  type ContextReadReading,
} from "../packages/devices/src/civ-context-read.js";
import { CivConfigError, CivProtocolError, CivFrameParser, type CivFrame } from "../packages/devices/src/civ.js";
import { isAllowedCivReadRequest } from "../packages/devices/src/serial.js";

// Independent fixtures from the IC-7300 manual (19-3/19-7/19-9).
const fixtures: readonly {
  kind: ContextReadKind;
  body: readonly number[];
  command: number;
  data: readonly number[];
  reading: ContextReadReading;
}[] = [
  { kind: "txFrequency", body: [0x1c, 3], command: 0x1c, data: [3, 0, 0x80, 0x10, 0x14, 0], reading: { kind: "txFrequency", frequencyHz: 14_108_000 } },
  { kind: "txStatus", body: [0x1c, 0], command: 0x1c, data: [0, 1], reading: { kind: "txStatus", status: "TX" } },
  { kind: "splitEnabled", body: [0x0f], command: 0x0f, data: [1], reading: { kind: "splitEnabled", enabled: true } },
  { kind: "ritEnabled", body: [0x21, 1], command: 0x21, data: [1, 1], reading: { kind: "ritEnabled", enabled: true } },
  { kind: "xitEnabled", body: [0x21, 2], command: 0x21, data: [2, 1], reading: { kind: "xitEnabled", enabled: true } },
  { kind: "breakIn", body: [0x16, 0x47], command: 0x16, data: [0x47, 2], reading: { kind: "breakIn", mode: "FULL" } },
];

function frame(command: number, data: readonly number[]): CivFrame {
  return { to: 0xe0, from: 0x94, command, data };
}

for (const fixture of fixtures) {
  test(`${fixture.kind}: exact request, independent response and parser fragments`, () => {
    const expected = [0xfe, 0xfe, 0x94, 0xe0, ...fixture.body, 0xfd];
    const plan = planContextRead(fixture.kind);
    assert.equal(plan.kind, fixture.kind);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.executable, false);
    assert.deepEqual([...plan.bytes], expected);
    assert.equal(isAllowedContextReadRequest(expected), true);
    assert.equal(isAllowedContextReadRequest(plan.bytes), true);
    assert.equal(isAllowedCivReadRequest(plan.bytes), false);
    assert.deepEqual(decodeContextReadResponse(fixture.kind, frame(fixture.command, fixture.data)), fixture.reading);
    const parser = new CivFrameParser();
    const wire = Uint8Array.from([0xfe, 0xfe, 0xe0, 0x94, fixture.command, ...fixture.data, 0xfd]);
    assert.deepEqual(parser.push(wire.subarray(0, 4)), []);
    const parsed = parser.push(wire.subarray(4));
    assert.equal(parsed.length, 1);
    assert.deepEqual(decodeContextReadResponse(fixture.kind, parsed[0]!), fixture.reading);
    for (let cut = 1; cut < wire.length; cut += 1) {
      const fragmented = new CivFrameParser();
      assert.deepEqual(fragmented.push(wire.subarray(0, cut)), []);
      const result = fragmented.push(wire.subarray(cut));
      assert.equal(result.length, 1);
      assert.deepEqual(decodeContextReadResponse(fixture.kind, result[0]!), fixture.reading);
    }
  });

  test(`${fixture.kind}: request mutations and appended setting data are refused`, () => {
    const bytes = [0xfe, 0xfe, 0x94, 0xe0, ...fixture.body, 0xfd];
    for (let index = 0; index < bytes.length; index += 1) {
      for (const value of [-1, 256, 1.5, NaN, Infinity, undefined, "0", null]) {
        const invalid: unknown[] = [...bytes];
        invalid[index] = value;
        assert.equal(isAllowedContextReadRequest(invalid), false);
      }
    }
    for (const value of [0, 1, 2, 0xff]) {
      assert.equal(isAllowedContextReadRequest([...bytes.slice(0, -1), value, 0xfd]), false);
    }
    assert.equal(isAllowedContextReadRequest(bytes.slice(1)), false);
    assert.equal(isAllowedContextReadRequest([...bytes, 0]), false);
    const otherAddress = [...bytes];
    otherAddress[2] = 0x95;
    assert.equal(isAllowedContextReadRequest(otherAddress), false);
    const echo = [...bytes];
    echo[2] = 0xe0;
    echo[3] = 0x94;
    assert.equal(isAllowedContextReadRequest(echo), false);
    const plan = planContextRead(fixture.kind);
    plan.bytes.fill(0);
    assert.equal(isAllowedContextReadRequest(plan.bytes), false);
    assert.deepEqual([...planContextRead(fixture.kind).bytes], bytes);
    assert.equal(isAllowedContextReadRequest(bytes), true);
  });

  test(`${fixture.kind}: unrelated replies return null, matching malformed replies throw`, () => {
    const valid = frame(fixture.command, fixture.data);
    for (const unrelated of [
      { ...valid, to: 0x00 }, { ...valid, to: 0x94, from: 0xe0 },
      { ...valid, from: 0x95 }, { ...valid, command: 0xfa, data: [] },
      { ...valid, command: 0xfb, data: [] }, { ...valid, command: 0x00 },
    ]) assert.equal(decodeContextReadResponse(fixture.kind, unrelated), null);
    assert.throws(() => decodeContextReadResponse(fixture.kind, frame(fixture.command, [])), CivProtocolError);
    assert.throws(() => decodeContextReadResponse(fixture.kind, frame(fixture.command, [...fixture.data, 0])), CivProtocolError);
    assert.throws(() => decodeContextReadResponse(fixture.kind, frame(fixture.command, fixture.data.slice(0, -1))), CivProtocolError);
    if (fixture.body.length === 2) {
      assert.equal(decodeContextReadResponse(fixture.kind, frame(fixture.command, [0x7f, 0])), null);
    }
  });
}

test("runtime kinds are checked by both APIs", () => {
  for (const value of [undefined, null, 0, {}, [], "", "toString", "__proto__", "send", Symbol("kind")]) {
    const kind = value as ContextReadKind;
    assert.throws(() => planContextRead(kind), CivConfigError);
    assert.throws(() => decodeContextReadResponse(kind, frame(0x0f, [0])), CivConfigError);
  }
});

test("whitelist rejects non-byte containers and sparse/inherited array entries", () => {
  for (const value of [undefined, null, "fefe", {}, new Uint16Array([0xfe]), { length: 7 }, new Array(100_000)]) {
    assert.equal(isAllowedContextReadRequest(value), false);
  }
  const original = [...planContextRead("txStatus").bytes];
  const sparse = [...original];
  delete sparse[4];
  assert.equal(isAllowedContextReadRequest(sparse), false);
  const prototype = Object.create(Array.prototype) as Record<string, unknown>;
  prototype[4] = 0x1c;
  Object.setPrototypeOf(sparse, prototype);
  assert.equal(sparse[4], 0x1c);
  assert.equal(isAllowedContextReadRequest(sparse), false);
});

test("frame structures and all byte fields are validated", () => {
  for (const value of [null, undefined, 1, "frame", {}, { to: 0xe0, from: 0x94, command: 0x0f, data: "01" }]) {
    assert.throws(() => decodeContextReadResponse("splitEnabled", value as CivFrame), CivProtocolError);
  }
  for (const value of [-1, 256, NaN, Infinity, 1.5, "1", null, undefined]) {
    for (const field of ["to", "from", "command"] as const) {
      const invalid = { ...frame(0x0f, [1]), [field]: value } as CivFrame;
      assert.throws(() => decodeContextReadResponse("splitEnabled", invalid), CivProtocolError);
    }
    assert.throws(() => decodeContextReadResponse("splitEnabled", frame(0x0f, [value as number])), CivProtocolError);
  }
  const sparse = new Array<number>(1);
  for (const data of [new Uint16Array([1]), { 0: 1, length: 1 }, new DataView(new ArrayBuffer(1))]) {
    assert.throws(() => decodeContextReadResponse("splitEnabled", { ...frame(0x0f, [1]), data } as unknown as CivFrame), CivProtocolError);
  }
  assert.throws(() => decodeContextReadResponse("splitEnabled", frame(0x0f, sparse)), CivProtocolError);
  const prototype = Object.create(Array.prototype) as Record<string, unknown>;
  prototype[0] = 1;
  Object.setPrototypeOf(sparse, prototype);
  assert.equal(sparse[0], 1);
  assert.throws(() => decodeContextReadResponse("splitEnabled", frame(0x0f, sparse)), CivProtocolError);
  // Structural errors are rejected even for an unrelated address.
  assert.throws(() => decodeContextReadResponse("splitEnabled", { ...frame(0x0f, sparse), to: 0 }), CivProtocolError);
});

test("response length is bounded before copying, with exact matched payload lengths", () => {
  const overlong = new Array<number>(33).fill(0);
  let byteReads = 0;
  Object.defineProperty(overlong, 0, { get() { byteReads += 1; throw new Error("byte read before length guard"); } });
  assert.throws(() => decodeContextReadResponse("txStatus", frame(0x1c, overlong)), /exceeds 32/);
  assert.equal(byteReads, 0);
  assert.throws(() => decodeContextReadResponse("txStatus", frame(0x1c, new Array<number>(33).fill(0))), /exceeds 32/);
  assert.throws(() => decodeContextReadResponse("txStatus", frame(0x1c, new Array<number>(1_000_000))), /exceeds 32/);
  assert.equal(decodeContextReadResponse("txStatus", frame(0x1c, [0x7f, ...new Array<number>(31).fill(0)])), null);
  assert.throws(() => decodeContextReadResponse("txStatus", frame(0x1c, new Array<number>(32).fill(0))), /payload/);
});

test("all status enumerations accept only documented values", () => {
  for (const kind of ["txStatus", "splitEnabled", "ritEnabled", "xitEnabled", "breakIn"] as const) {
    const fixture = fixtures.find((item) => item.kind === kind)!;
    for (let value = 0; value <= 255; value += 1) {
      const data = fixture.body.length === 1 ? [value] : [fixture.body[1]!, value];
      const allowed = kind === "breakIn" ? value <= 2 : value <= 1;
      if (!allowed) {
        assert.throws(() => decodeContextReadResponse(kind, frame(fixture.command, data)), CivProtocolError);
      } else {
        const expected: ContextReadReading = kind === "breakIn"
          ? { kind, mode: (["OFF", "SEMI", "FULL"] as const)[value]! }
          : kind === "txStatus" ? { kind, status: value === 0 ? "RX" : "TX" }
          : { kind, enabled: value === 1 };
        assert.deepEqual(decodeContextReadResponse(kind, frame(fixture.command, data)), expected);
      }
    }
  }
});

test("TX frequency strictly validates every BCD position without inferring hardware range", () => {
  assert.deepEqual(decodeContextReadResponse("txFrequency", frame(0x1c, [3, 0, 0, 0, 0, 0])), { kind: "txFrequency", frequencyHz: 0 });
  assert.deepEqual(decodeContextReadResponse("txFrequency", frame(0x1c, [3, 0x99, 0x99, 0x99, 0x99, 0x99])), { kind: "txFrequency", frequencyHz: 9_999_999_999 });
  for (let index = 0; index < 5; index += 1) {
    for (let byte = 0; byte <= 255; byte += 1) {
      const data = [3, 0, 0, 0, 0, 0];
      data[index + 1] = byte;
      const high = byte >> 4;
      const low = byte & 15;
      if (high > 9 || low > 9) {
        assert.throws(() => decodeContextReadResponse("txFrequency", frame(0x1c, data)), CivProtocolError);
      } else {
        assert.deepEqual(decodeContextReadResponse("txFrequency", frame(0x1c, data)), { kind: "txFrequency", frequencyHz: (high * 10 + low) * 100 ** index });
      }
    }
  }
});

test("Uint8Array response data is accepted and the original frame is not mutated", () => {
  const data = Uint8Array.from([0, 1]);
  const input = { to: 0xe0, from: 0x94, command: 0x1c, data } as unknown as CivFrame;
  assert.deepEqual(decodeContextReadResponse("txStatus", input), { kind: "txStatus", status: "TX" });
  assert.deepEqual([...data], [0, 1]);
  assert.equal(isAllowedCivReadRequest([0xfe, 0xfe, 0x94, 0xe0, 3, 0xfd]), true);
  assert.equal(isAllowedCivReadRequest([0xfe, 0xfe, 0x94, 0xe0, 4, 0xfd]), true);
  assert.equal(isAllowedContextReadRequest([0xfe, 0xfe, 0x94, 0xe0, 0x17, 0xff, 0xfd]), false);
});
