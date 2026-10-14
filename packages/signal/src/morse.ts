// Morse 编码适配：复用固定版本的 morse-code-translator，不复制也不 fork 其实现。
// 限制支持字符，避免宽松转换静默改变输入。
import { encode } from "@ozdemirburak/morse-code-translator";
import { CW_LIMITS, CwContractError, type CwMorseWords } from "./contracts.js";

/** 首版支持的标点（已对照 ITU 标准逐项验证）。 */
export const CW_SUPPORTED_PUNCTUATION = ["/", "?", ".", ","] as const;

const PUNCTUATION_SET: ReadonlySet<string> = new Set(CW_SUPPORTED_PUNCTUATION);

function isSupportedCharacter(ch: string): boolean {
  return /^[A-Z0-9]$/.test(ch) || PUNCTUATION_SET.has(ch);
}

/** 折叠所有空白为单个空格并去掉首尾，再转大写。保留原始文本由调用方负责。 */
export function normalizeCwText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toUpperCase();
}

/** 对单个字符调用库编码；不支持的字符必须显式报错，绝不静默返回 '?'。 */
export function encodeMorseChar(ch: string): string {
  if (!isSupportedCharacter(ch)) {
    throw new CwContractError(
      "unsupported_character",
      `unsupported character for Morse encoding: ${JSON.stringify(ch)}`,
    );
  }
  const encoded = encode(ch);
  if (typeof encoded !== "string" || encoded.length === 0 || encoded === "?" || !/^[.-]+$/.test(encoded)) {
    throw new CwContractError(
      "morse_library_mismatch",
      `morse library did not return a valid code for ${JSON.stringify(ch)}: ${JSON.stringify(encoded)}`,
    );
  }
  if (encoded.length > CW_LIMITS.MORSE_LETTER_MAX_SYMBOLS) {
    throw new CwContractError(
      "morse_library_mismatch",
      `morse code for ${JSON.stringify(ch)} exceeds ${CW_LIMITS.MORSE_LETTER_MAX_SYMBOLS} symbols`,
    );
  }
  return encoded;
}

/** 把规范文本编码为按词分组的 Morse（每个字母是一个 '.'/'-' 字符串）。 */
export function encodeCwText(normalizedText: string): CwMorseWords {
  const words: CwMorseWords = [];
  let totalLetters = 0;
  for (const word of normalizedText.split(" ")) {
    if (word.length === 0) continue;
    const letters: string[] = [];
    for (const ch of word) {
      letters.push(encodeMorseChar(ch));
      totalLetters += 1;
    }
    words.push(letters);
  }
  if (words.length === 0 || totalLetters === 0) {
    throw new CwContractError("empty_message", "message contains no encodable Morse characters");
  }
  if (totalLetters > CW_LIMITS.TEXT_MAX_CHARS) {
    throw new CwContractError(
      "message_too_long",
      `message has ${totalLetters} letters, exceeding ${CW_LIMITS.TEXT_MAX_CHARS}`,
    );
  }
  return words;
}
