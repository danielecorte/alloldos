// Aprire uno zip, che nel 1988 era il modo in cui il software viaggiava.
//
// PKZIP è del 1989 — un anno dopo questa macchina — ed è il formato con cui
// tutto quello che si scaricava da una BBS arrivava a casa. Il pezzo che conta
// sta in fondo: un catalogo con dentro, per ogni file, il nome, quanto è
// grande, com'è compresso e a che punto dell'archivio comincia. È per quello
// che uno zip si apre dalla coda, e che si può tirar fuori un file solo senza
// leggere gli altri: una scelta fatta quando i file stavano su un dischetto e
// leggerli tutti voleva dire farlo girare per un minuto.
//
// Il metodo di compressione che si trova quasi sempre è deflate, che è lo
// stesso di gzip e delle pagine web: il browser lo sa fare da sé, e qui si usa
// il suo — nessuna libreria, e la scompattazione la fa il codice che sta già
// dentro il browser (`DecompressionStream`, che Node ha anche lui, così le
// prove usano la stessa strada).

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_CATALOG = 0x06054b50;

/** Le due compressioni che si trovano in uno zip di roba per DOS. */
const STORED = 0;
const DEFLATED = 8;

const u16 = (view, at) => view.getUint16(at, true);
const u32 = (view, at) => view.getUint32(at, true);

/**
 * La somma di controllo che ogni voce si porta dietro. È la stessa di gzip e
 * del PNG, e nel 1989 serviva a una cosa sola: un archivio arrivato via modem
 * su una linea disturbata aveva dei byte sbagliati, e senza questa somma non
 * c'era modo di accorgersene prima di far girare il programma.
 */
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Uno zip si riconosce da come comincia: sono le iniziali di Phil Katz. */
export function isZip(bytes) {
  return bytes.length > 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export class UnreadableZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnreadableZipError';
  }
}

/**
 * La coda dell'archivio: dove comincia il catalogo e quante voci ha. Si cerca
 * all'indietro perché in fondo ci può essere un commento, e allora la fine
 * vera non è l'ultimo byte.
 */
function findCatalog(view, length) {
  for (let at = length - 22; at >= 0; at--) {
    if (u32(view, at) === END_OF_CATALOG) {
      return { start: u32(view, at + 16), count: u16(view, at + 10) };
    }
  }
  throw new UnreadableZipError('non è uno zip, o è troncato: manca il catalogo');
}

async function inflate(stored) {
  const stream = new Blob([stored]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Tutto quello che c'è dentro, già scompattato.
 *
 * I nomi arrivano come stanno nell'archivio, con le loro cartelle separate da
 * barre: chi lo svuota decide poi che farne. Le cartelle vuote non tornano —
 * una cartella nello zip è una voce che finisce con la barra e non ha niente
 * dentro, e su un disco DOS non serve a nessuno.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{path:string, bytes:Uint8Array}[]>}
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { start, count } = findCatalog(view, bytes.length);
  const decoder = new TextDecoder();
  const files = [];

  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(view, at) !== CENTRAL_ENTRY) {
      throw new UnreadableZipError(`il catalogo si interrompe al file numero ${i + 1}`);
    }
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    const checksum = u32(view, at + 16);
    const packed = u32(view, at + 20);
    const size = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const local = u32(view, at + 42);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) continue; // una cartella, e basta
    if (flags & 1) throw new UnreadableZipError(`«${path}» ha una parola d'ordine`);
    if (method !== STORED && method !== DEFLATED) {
      throw new UnreadableZipError(`«${path}» è compresso in un modo che non conosco (${method})`);
    }
    if (u32(view, local) !== LOCAL_HEADER) {
      throw new UnreadableZipError(`«${path}» non è dove il catalogo dice`);
    }

    // Il nome e i campi in più si ripetono davanti ai byte veri, e possono
    // essere lunghi diversamente da quelli del catalogo: la lunghezza da
    // credere è questa.
    const from = local + 30 + u16(view, local + 26) + u16(view, local + 28);
    const stored = bytes.subarray(from, from + packed);
    const content = method === STORED ? stored.slice() : await inflate(stored);
    if (content.length !== size) {
      throw new UnreadableZipError(`«${path}» esce lungo ${content.length} invece di ${size}`);
    }
    // La lunghezza giusta non basta: la somma dice che sono anche i byte
    // giusti. Un archivio rovinato che passasse di qui finirebbe sul disco
    // fisso, e il DOS non avrebbe più niente con cui accorgersene.
    if (checksum && crc32(content) !== checksum) {
      throw new UnreadableZipError(`«${path}» non torna: l'archivio è rovinato`);
    }
    files.push({ path, bytes: content });
  }

  if (!files.length) throw new UnreadableZipError('lo zip è vuoto');
  return files;
}
