import { statfs, readFile } from "node:fs/promises";
import { tmpdir, freemem } from "node:os";
export type ResourceSnapshot = {
  diskFreeBytes: number;
  diskTotalBytes: number;
  availableMemoryBytes: number;
  rssBytes: number;
};
export function canProcess(s: ResourceSnapshot): boolean {
  return (
    s.diskTotalBytes > 0 &&
    s.diskFreeBytes / s.diskTotalBytes >= 0.1 &&
    s.availableMemoryBytes >= 128 * 1024 ** 2 &&
    s.rssBytes < 512 * 1024 ** 2
  );
}
export async function resourcesAvailable(): Promise<boolean> {
  const disk = await statfs(process.env.RESOURCE_DISK_PATH ?? tmpdir());
  let available = freemem();
  try {
    const [current, max] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.current", "utf8"),
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
    ]);
    if (max.trim() !== "max")
      available = Math.min(available, Number(max) - Number(current));
  } catch {
    /* Local systems may not expose cgroups. */
  }
  return canProcess({
    diskFreeBytes: disk.bavail * disk.bsize,
    diskTotalBytes: disk.blocks * disk.bsize,
    availableMemoryBytes: available,
    rssBytes: process.memoryUsage().rss,
  });
}
