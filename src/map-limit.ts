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
