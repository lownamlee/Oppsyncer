import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";

export function bytesToBase64(bytes: Uint8Array): string {
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return arrayBufferToBase64(exact);
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(value.replace(/\s/g, "")));
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
