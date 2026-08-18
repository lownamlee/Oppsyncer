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

export async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await operation(values[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), values.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
