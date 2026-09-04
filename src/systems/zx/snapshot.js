// Le istantanee `.sna`: una macchina fotografata a metà lavoro.
//
// Un `.sna` non è un programma, è una macchina: i registri come stavano in
// quel momento, i 48 KB di RAM, e il colore del bordo. Si rimette tutto dov'era
// e si riparte dall'istruzione dopo. È il formato più vecchio e più semplice
// che ci sia — 27 byte di intestazione — e ha una stranezza che racconta come
// è nato: non c'è il program counter. Chi lo inventò salvava la macchina da
// dentro un'interruzione, con l'indirizzo di ritorno già sullo stack, e quindi
// per far ripartire la macchina basta una RETN. Il PC sta nei due byte in cima
// allo stack, e rimetterlo a posto vuol dire toglierlo da lì.

export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** I 27 byte dell'intestazione, nell'ordine in cui stanno. */
export const SNA_HEADER = 27;
export const SNA_SIZE = SNA_HEADER + 49152;

export function isSNA(bytes) {
  return bytes.length === SNA_SIZE;
}

/**
 * Rimette la macchina dove era.
 * @param {import('./machine.js').Spectrum} machine
 * @param {Uint8Array} bytes
 */
export function loadSNA(machine, bytes) {
  if (!isSNA(bytes)) throw new SnapshotError('un .sna sono 49179 byte, né uno di più né uno di meno');
  const cpu = machine.cpu;
  const word = (at) => bytes[at] | (bytes[at + 1] << 8);

  cpu.i = bytes[0];
  cpu.alt.r[4] = bytes[2]; cpu.alt.r[5] = bytes[1]; // HL'
  cpu.alt.r[2] = bytes[4]; cpu.alt.r[3] = bytes[3]; // DE'
  cpu.alt.r[0] = bytes[6]; cpu.alt.r[1] = bytes[5]; // BC'
  cpu.alt.r[7] = bytes[8]; cpu.alt.f = bytes[7]; //     AF'
  cpu.hl = word(9);
  cpu.de = word(11);
  cpu.bc = word(13);
  cpu.iy = word(15);
  cpu.ix = word(17);
  cpu.iff2 = (bytes[19] & 0x04) !== 0;
  cpu.iff1 = cpu.iff2;
  cpu.rReg = bytes[20];
  cpu.f = bytes[21];
  cpu.r[7] = bytes[22];
  cpu.sp = word(23);
  cpu.im = bytes[25] & 3;
  machine.ula.border = bytes[26] & 7;
  machine.ula.borderChanges = [{ t: 0, colour: machine.ula.border }];

  machine.memory.set(bytes.subarray(SNA_HEADER), 0x4000);

  // E la RETN che manca: il program counter esce dallo stack.
  cpu.pc = machine.memory[cpu.sp] | (machine.memory[(cpu.sp + 1) & 0xffff] << 8);
  cpu.sp = (cpu.sp + 2) & 0xffff;
  cpu.halted = false;
}

/**
 * E il contrario, per portarsi via dove si è arrivati. Il program counter
 * torna sullo stack, che è dove il formato lo vuole.
 * @param {import('./machine.js').Spectrum} machine
 * @returns {Uint8Array}
 */
export function saveSNA(machine) {
  const cpu = machine.cpu;
  const bytes = new Uint8Array(SNA_SIZE);
  const memory = machine.memory.slice();
  let sp = (cpu.sp - 2) & 0xffff;
  if (sp >= 0x4000) {
    memory[sp] = cpu.pc & 0xff;
    memory[(sp + 1) & 0xffff] = (cpu.pc >> 8) & 0xff;
  } else {
    sp = cpu.sp; // niente da fare: lo stack sta nella ROM, e lì non si scrive
  }

  const putWord = (at, value) => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
  };
  bytes[0] = cpu.i;
  putWord(1, (cpu.alt.r[4] << 8) | cpu.alt.r[5]);
  putWord(3, (cpu.alt.r[2] << 8) | cpu.alt.r[3]);
  putWord(5, (cpu.alt.r[0] << 8) | cpu.alt.r[1]);
  putWord(7, (cpu.alt.r[7] << 8) | cpu.alt.f);
  putWord(9, cpu.hl);
  putWord(11, cpu.de);
  putWord(13, cpu.bc);
  putWord(15, cpu.iy);
  putWord(17, cpu.ix);
  bytes[19] = cpu.iff2 ? 0x04 : 0;
  bytes[20] = cpu.rReg;
  bytes[21] = cpu.f;
  bytes[22] = cpu.r[7];
  putWord(23, sp);
  bytes[25] = cpu.im;
  bytes[26] = machine.ula.border;
  bytes.set(memory.subarray(0x4000), SNA_HEADER);
  return bytes;
}
