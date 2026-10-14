// Offline IC-7300 CI-V CW command planning.
//
// This module only validates and builds an immutable dry-run plan. It does not
// accept a transport and cannot write to a serial port. A future real adapter
// must add its own ownership, preflight, approval, abort, and audit checks.

import { CivConfigError, CivError, CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS,
  CIV_EOM, CIV_PREAMBLE } from "./civ.js";

/** IC-7300 CI-V command for the built-in CW message sender. */
export const CIV_COMMAND_SEND_CW = 0x17;
/** Payload byte documented by Icom to stop the queued CW message. */
export const CIV_CW_STOP_BYTE = 0xff;
/** The IC-7300 accepts at most 30 message bytes for command 0x17. */
export const CIV_CW_MAX_MESSAGE_BYTES = 30;

// Module-private whitelist taken from the Command 17 ("Send CW messages")
// dedicated table on printed page 19-13 of the IC-7300 instruction manual. The
// general character-input table on printed page 19-10 must NOT be substituted:
// it accepts characters (for example ! # $ % & *) that Command 17 does not.
//
// This constant is deliberately not exported, so no caller can read, widen or
// mutate the authorized transmit character set at runtime. "^" is included
// because the same manual page documents it for continuous keying.
const CIV_CW_ALLOWED_ASCII_CODES: ReadonlySet<number> = (() => {
  const codes = new Set<number>();
  codes.add(0x20); // space
  for (let code = 0x30; code <= 0x39; code += 1) codes.add(code); // 0-9
  for (let code = 0x41; code <= 0x5a; code += 1) codes.add(code); // A-Z
  for (let code = 0x61; code <= 0x7a; code += 1) codes.add(code); // a-z
  // " ' ( ) + , - . / : = ? @
  for (const code of [0x22, 0x27, 0x28, 0x29, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x3a, 0x3d, 0x3f, 0x40]) {
    codes.add(code);
  }
  codes.add(0x5e); // ^ continuous keying, no inter-character space
  return codes;
})();

export class CivTxPlanError extends CivError {
  constructor(message: string) {
    super("tx_plan", message);
  }
}

export interface CivCwPlan {
  readonly kind: "message" | "stop";
  readonly radioAddress: number;
  readonly controllerAddress: number;
  readonly command: typeof CIV_COMMAND_SEND_CW;
  readonly text: string | null;
  readonly payload: readonly number[];
  readonly bytes: readonly number[];
  readonly dryRun: true;
  readonly executable: false;
}

export interface CivCwPlanOptions {
  readonly radioAddress?: number;
  readonly controllerAddress?: number;
}

function assertRadioAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0x01 || address > 0xdf) {
    throw new CivConfigError(`radio address must be in 0x01..0xdf, got 0x${address.toString(16)}`);
  }
}

function assertControllerAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0xe0 || address > 0xef) {
    throw new CivConfigError(`controller address must be in 0xe0..0xef, got 0x${address.toString(16)}`);
  }
}

function addresses(options: CivCwPlanOptions): { radioAddress: number; controllerAddress: number } {
  const radioAddress = options.radioAddress ?? CIV_DEFAULT_RADIO_ADDRESS;
  const controllerAddress = options.controllerAddress ?? CIV_DEFAULT_CONTROLLER_ADDRESS;
  assertRadioAddress(radioAddress);
  assertControllerAddress(controllerAddress);
  if (radioAddress === controllerAddress) {
    throw new CivConfigError("radio and controller addresses must differ");
  }
  return { radioAddress, controllerAddress };
}

function frame(radioAddress: number, controllerAddress: number, payload: readonly number[]): readonly number[] {
  return Object.freeze([
    CIV_PREAMBLE,
    CIV_PREAMBLE,
    radioAddress,
    controllerAddress,
    CIV_COMMAND_SEND_CW,
    ...payload,
    CIV_EOM,
  ]);
}

function basePlan(kind: CivCwPlan["kind"], text: string | null, payload: readonly number[], options: CivCwPlanOptions): CivCwPlan {
  const { radioAddress, controllerAddress } = addresses(options);
  return Object.freeze({
    kind,
    radioAddress,
    controllerAddress,
    command: CIV_COMMAND_SEND_CW,
    text,
    payload: Object.freeze([...payload]),
    bytes: frame(radioAddress, controllerAddress, payload),
    dryRun: true,
    executable: false,
  });
}

/**
 * Render a rejected character for an error message. Printable ASCII keeps the
 * quoted character; control, invisible and non-ASCII code points are reported
 * only as their code point so the error stays readable.
 */
function describeCwCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  const codePoint = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  if (character.length === 1 && code >= 0x21 && code <= 0x7e) {
    return `"${character}" (${codePoint})`;
  }
  return codePoint;
}

/**
 * Build a dry-run plan for one IC-7300 CW message.
 *
 * The message is restricted to the Command 17 character codes printed in the
 * IC-7300 manual (printed page 19-13): 0-9, A-Z, a-z, space, the punctuation
 * `" ' ( ) + , - . / : = ? @`, and `^` for continuous keying. Every other byte,
 * including the non-ASCII, control and invisible ones, is rejected and named in
 * the error. No Unicode transcoding, normalization or implicit truncation is
 * performed, and at most 30 single-byte characters are accepted.
 */
export function planCivCwMessage(text: string, options: CivCwPlanOptions = {}): CivCwPlan {
  if (typeof text !== "string" || text.length === 0) {
    throw new CivTxPlanError("CW message must be a non-empty string");
  }
  const payload: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined || character.length !== 1 || !CIV_CW_ALLOWED_ASCII_CODES.has(code)) {
      throw new CivTxPlanError(
        `CW message contains unsupported character ${describeCwCharacter(character)}; ` +
          "the IC-7300 Command 17 table accepts only 0-9 A-Z a-z, space, " +
          "\" ' ( ) + , - . / : = ? @, and ^",
      );
    }
    payload.push(code);
    if (payload.length > CIV_CW_MAX_MESSAGE_BYTES) {
      throw new CivTxPlanError(
        `CW message must be at most ${CIV_CW_MAX_MESSAGE_BYTES} bytes (IC-7300 Command 17 limit); ` +
          "the message is not truncated",
      );
    }
  }
  return basePlan("message", text, payload, options);
}

/** Build a dry-run plan for the documented IC-7300 CW stop payload. */
export function planCivCwStop(options: CivCwPlanOptions = {}): CivCwPlan {
  return basePlan("stop", null, [CIV_CW_STOP_BYTE], options);
}

/** Render a plan's bytes for audit/UI output without making it executable. */
export function civPlanHex(plan: CivCwPlan): string {
  return [...plan.bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
