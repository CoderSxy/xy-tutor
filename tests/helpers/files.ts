import { createHash } from "node:crypto";
export type StoredObject = {
  size: number;
  contentType: string;
  prefix: Buffer;
};
export class MemoryFileStore {
  private objects = new Map<string, StoredObject>();
  private failedDeletes = new Set<string>();
  put(key: string, value: StoredObject) {
    this.objects.set(key, value);
  }
  keys() {
    return [...this.objects.keys()];
  }
  async signUpload(input: { key: string; contentType: string }) {
    return {
      url: `https://test.invalid/upload/${input.key}`,
      headers: { "Content-Type": input.contentType },
    };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) throw Error("Missing object");
    return object;
  }
  async signDownload(key: string, _ttl: number) {
    return `https://test.invalid/download/${key}`;
  }
  async seal(key: string) {
    const sealed =
      "sealed/" + createHash("sha256").update(key).digest("hex");
    this.objects.set(sealed, structuredClone(await this.head(key)));
    const object = this.objects.get(sealed)!;
    object.prefix = Buffer.from(object.prefix);
    return sealed;
  }
  async read(key: string) {
    return (await this.head(key)).prefix;
  }
  async delete(key: string) {
    if (this.failedDeletes.delete(key)) throw Error("Delete failed");
    this.objects.delete(key);
  }
  failDeleteOnce(key: string) {
    this.failedDeletes.add(key);
  }
}
