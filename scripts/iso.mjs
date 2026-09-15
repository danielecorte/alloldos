// Un CD da provare: un'immagine ISO 9660 minima, fatta qui, con dentro dei file.
//
// Le prove del lettore di CD hanno bisogno di un disco, e un disco vero non
// viaggia col repository. Il formato però è semplice abbastanza da scriverlo a
// mano: sedici settori vuoti, il descrittore del volume, il terminatore, le due
// tabelle dei percorsi — una in ordine Intel e una in ordine Motorola, perché
// nel 1988 non ci si era messi d'accordo — la cartella principale, e i file.
// Nomi da otto più tre, maiuscoli, come li vuole il livello 1 dello standard.

const SECTOR = 2048;

const both16 = (value) => [value & 0xff, value >> 8, value >> 8, value & 0xff];
const both32 = (value) => {
  const le = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
  return [...le, ...[...le].reverse()];
};
const text = (value, length) => Array.from(value.padEnd(length, ' ').slice(0, length), (c) => c.charCodeAt(0));

/** Una voce di cartella: dove sta, quanto è lunga, e come si chiama. */
function record(sector, size, name, directory) {
  const id = typeof name === 'number' ? [name] : Array.from(name, (c) => c.charCodeAt(0));
  const length = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
  const out = new Uint8Array(length);
  out.set([length, 0, ...both32(sector), ...both32(size), 126, 9, 15, 12, 0, 0, 0, directory ? 2 : 0, 0, 0, ...both16(1), id.length, ...id]);
  return out;
}

/**
 * @param {{name:string, bytes:Uint8Array}[]} files nomi da otto più tre
 * @param {string} [label] il nome del volume
 * @returns {Uint8Array}
 */
export function makeISO(files, label = 'ALLOLDOS') {
  const ROOT = 20;
  let next = ROOT + 1;
  const placed = files.map(({ name, bytes }) => {
    const at = next;
    next += Math.max(1, Math.ceil(bytes.length / SECTOR));
    return { name: `${name.toUpperCase()};1`, bytes, at };
  });
  const image = new Uint8Array(next * SECTOR);

  const root = [record(ROOT, SECTOR, 0, true), record(ROOT, SECTOR, 1, true), ...placed.map((f) => record(f.at, f.bytes.length, f.name, false))];
  let offset = ROOT * SECTOR;
  for (const entry of root) {
    image.set(entry, offset);
    offset += entry.length;
  }
  for (const f of placed) image.set(f.bytes, f.at * SECTOR);

  const pvd = new Uint8Array(SECTOR);
  pvd.set([1, ...text('CD001', 5), 1], 0);
  pvd.set(text('', 32), 8);
  pvd.set(text(label, 32), 40);
  pvd.set(both32(next), 80);
  pvd.set(both16(1), 120);
  pvd.set(both16(1), 124);
  pvd.set(both16(SECTOR), 128);
  pvd.set(both32(10), 132);
  pvd.set([18, 0, 0, 0], 140); // la tabella dei percorsi in ordine Intel
  pvd.set([0, 0, 0, 19], 148); // e in ordine Motorola
  pvd.set(record(ROOT, SECTOR, 0, true), 156);
  pvd.set(text('', 623), 190);
  for (const at of [813, 830, 847, 864]) pvd.set([...text('0000000000000000', 16), 0], at);
  pvd[881] = 1;
  image.set(pvd, 16 * SECTOR);
  image.set([255, ...text('CD001', 5), 1], 17 * SECTOR);
  image.set([1, 0, ROOT, 0, 0, 0, 1, 0, 0, 0], 18 * SECTOR);
  image.set([1, 0, 0, 0, 0, ROOT, 0, 1, 0, 0], 19 * SECTOR);
  return image;
}
