/** Durable attachment bytes, separate from expiring server uploads. */
const DATABASE = 'tolktak.outbox-files.v1';
const STORE = 'files';
type StoredFile = { server: string; uid: number; localID: string; blob: Blob; name: string };

function scope(server: string, uid: number): [string, number] {
  const base = server.trim().replace(/\/+$/, '');
  if (!base || !Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid outgoing attachment account');
  return [base, uid];
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: ['server', 'uid', 'localID'] });
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open outgoing attachment storage'));
    request.onblocked = () => {
      failed = true;
      reject(new Error('Outgoing attachment storage is blocked by another window'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // A blocked request can succeed later; close that connection.
      if (failed) return db.close();
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode, { durability: 'strict' });
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    let result: T;
    let failure: unknown;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = () => {
      db.close();
      reject(failure ?? tx.error ?? new Error('Outgoing attachment storage transaction aborted'));
    };
    try {
      const request = operation(tx.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { failure = request.error; };
    } catch (error) {
      failure = error;
      tx.abort();
    }
  });
}

/** Resolves after commit; storage errors reject. */
export async function saveOutgoingFile(server: string, uid: number, blob: Blob, name: string): Promise<string> {
  const [base, account] = scope(server, uid);
  const localID = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
  const entry: StoredFile = { server: base, uid: account, localID, blob, name };
  await transaction('readwrite', (store) => store.add(entry));
  return localID;
}

/** A missing or other-account reference is null; inaccessible/corrupt storage rejects. */
export async function loadOutgoingFile(server: string, uid: number, localID: string): Promise<{ blob: Blob; name: string } | null> {
  const [base, account] = scope(server, uid);
  const entry: StoredFile | undefined = await transaction('readonly', (store) => store.get([base, account, localID]));
  if (!entry) return null;
  if (!(entry.blob instanceof Blob) || typeof entry.name !== 'string') throw new Error('Outgoing attachment data is corrupt');
  return { blob: entry.blob, name: entry.name };
}

/** Idempotent cleanup of one account-scoped attachment. */
export async function deleteOutgoingFile(server: string, uid: number, localID: string): Promise<void> {
  const [base, account] = scope(server, uid);
  await transaction('readwrite', (store) => store.delete([base, account, localID]));
}
