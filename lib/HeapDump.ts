import fs from 'fs';
import { getHeapSnapshot } from 'v8';

export const dumpHeap = async (filePath: string) =>
  new Promise<void>((resolve, reject) => {
    const snapshot = getHeapSnapshot();
    // Heap snapshots contain the plaintext mnemonic and derived key material,
    // so restrict the file to the owner only.
    const fileStream = fs.createWriteStream(filePath, { mode: 0o600 });
    snapshot.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.end();
      resolve();
    });
    fileStream.on('error', (err) => reject(err));
  });
