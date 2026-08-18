import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";

export function bytesToBase64(bytes: Uint8Array): string {
  return arrayBufferToBase64(toArrayBuffer(bytes));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
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
