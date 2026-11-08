export type StoredObject = {
  size: number;
  contentType: string;
  prefix: Buffer;
};
export class MemoryFileStore {
  private objects = new Map<string, StoredObject>();
  put(key: string, value: StoredObject) {
    this.objects.set(key, value);
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
    const sealed = "sealed/" + crypto.randomUUID();
    this.objects.set(sealed, structuredClone(await this.head(key)));
    const object = this.objects.get(sealed)!;
    object.prefix = Buffer.from(object.prefix);
    return sealed;
  }
  async read(key: string) {
    return (await this.head(key)).prefix;
  }
}
