/** Serialized, in-memory implementation of Harness credential-record semantics. */
export class MemoryCredentials {
  constructor() {
    this.records = new Map();
    this.writes = [];
    this.keysRead = [];
    this.queue = Promise.resolve();
    this.beforeRead = null;
  }
  async readRecord(key) {
    this.keysRead.push(key);
    if (this.beforeRead) await this.beforeRead(key);
    return structuredClone(this.records.get(key));
  }
  modifyRecord(key, modify) {
    const operation = this.queue.then(async () => {
      const next = await modify(structuredClone(this.records.get(key)));
      if (next !== undefined) {
        this.records.set(key, structuredClone(next));
        this.writes.push({ key, record: structuredClone(next) });
      }
      return structuredClone(this.records.get(key));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async deleteRecord(key) { await this.queue; this.records.delete(key); }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
