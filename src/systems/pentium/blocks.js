// La traduzione a blocchi: il pezzo che smette di rileggere il codice.
//
// Un interprete fa tre lavori per ogni istruzione, e due li rifà per niente.
// Legge i byte uno per uno dalla memoria, li smonta — i prefissi, l'opcode, il
// byte mod-reg-r/m, lo spostamento, l'immediato — e poi finalmente fa quello
// che l'istruzione dice. Dentro un ciclo che gira un milione di volte, i primi
// due lavori danno ogni volta esattamente la stessa risposta, e ogni volta si
// pagano per intero. Su questo processore sono la maggior parte del tempo.
//
// Tradurre a blocchi vuol dire pagarli una volta sola. Si prende un pezzo di
// codice dal punto in cui il processore si trova fino al primo salto, lo si
// smonta tutto insieme, e da quello che ne esce si **scrive una funzione
// JavaScript** — una vera, fatta di testo e passata a `new Function`, che il
// motore del browser compila come se l'avessimo scritta noi a mano. Dentro
// quella funzione non c'è più niente da decidere: i registri sono indici
// costanti, le misure sono numeri scritti, gli indirizzi sono formule già
// ridotte, e i salti hanno la destinazione già calcolata. La funzione si tiene
// da parte, indicizzata dall'indirizzo *fisico* della sua prima istruzione, e
// la volta dopo che il processore passa di lì si esegue e basta.
//
// Quello che non si può perdere, e che qui non si perde:
//
// - **Le eccezioni a metà istruzione.** Un page fault deve poter arrivare nel
//   mezzo e far ricominciare l'istruzione da capo. Ogni istruzione del blocco
//   si lascia dietro da dove era cominciata (`startEIP`, `startESP`), e tutto
//   il blocco sta dentro un `try`: l'eccezione esce dall'istruzione, il blocco
//   la consegna a `serviceFault` come farebbe l'interprete, e finisce lì.
// - **Le interruzioni guardate fra un'istruzione e l'altra.** Un blocco finisce
//   a ogni salto, e a ogni istruzione che possa toccare il bit delle
//   interruzioni: STI, CLI, POPF, IRET, HLT, i registri di controllo, le porte
//   in uscita. La finestra di tre istruzioni che il firmware apre con `sti` e
//   richiude con `cli` resta larga com'era, perché quando c'è un rinvio in
//   corso (`stiDelay`) il blocco non si usa proprio e si torna a un'istruzione
//   per volta.
// - **Il codice che si riscrive da sé.** Ogni pagina fisica che contiene un
//   blocco è segnata in una mappa di bit, e ogni scrittura che cade lì dentro
//   — dal processore, dal DMA, da chiunque — butta via i blocchi che coprono
//   quel byte. È il caso normale, non quello strano: un programma del DOS che
//   si carica in memoria sta scrivendo sopra il codice di quello di prima.
// - **Tutto quello che non è ancora tradotto.** Un opcode senza un traduttore
//   suo non è un problema: nella funzione ci va una chiamata all'interprete
//   per quella sola istruzione, e un controllo che dice se il processore è
//   andato dove ci si aspettava. Se non c'è andato, il blocco finisce lì. È il
//   motivo per cui questa cosa si è potuta accendere tutta insieme senza
//   riscrivere trecento opcode: i più battuti hanno il loro traduttore, gli
//   altri passano di qui come sono sempre passati.

/* eslint-disable no-bitwise */

const CS = 1;
const SS = 2;
const DS = 3;
const ECX = 1;
const ESP = 4;

/** Quanti byte di immediato porta dietro un opcode; zero vuol dire nessuno. */
const IB = 1; // un byte
const IW = 2; // due byte
const IZ = 3; // la misura dell'operando
const IPTR = 4; // un puntatore lontano: offset più selettore
const MOFFS = 5; // un indirizzo assoluto, della misura degli indirizzi
const IWB = 6; // due byte e poi uno: solo ENTER
const GROUP3 = 7; // F6/F7: l'immediato c'è solo per TEST

/** Quanto è lungo un blocco, al massimo: oltre, il guadagno non cresce più. */
const MAX_INSTRUCTIONS = 48;

/**
 * Quante volte un blocco si può far riscrivere prima che si prenda sul serio: le
 * prime due volte può essere un programma caricato sopra un altro, e allora
 * tradurlo daccapo è giusto; dalla terza è codice che si rattoppa da sé, e
 * allora conviene fermare il blocco prima del byte che si muove.
 */
const PATIENCE = 3;


const MODRM = new Uint8Array(256);
const IMM = new Uint8Array(256);
const MODRM_0F = new Uint8Array(256);
const IMM_0F = new Uint8Array(256);

/**
 * Gli opcode che un blocco può attraversare senza tradurli: quelli che non
 * possono cambiare CS, il bit delle interruzioni, i registri di controllo o il
 * modo del processore. Tutti gli altri, se non hanno un traduttore, chiudono il
 * blocco — che è la scelta prudente, e costa solo qualche blocco più corto.
 */
const PASSABLE = new Uint8Array(256);
const PASSABLE_0F = new Uint8Array(256);

{
  const set = (table, list, value = 1) => {
    for (const entry of list) {
      if (Array.isArray(entry)) for (let i = entry[0]; i <= entry[1]; i++) table[i] = value;
      else table[entry] = value;
    }
  };

  // La griglia in testa alla tabella: quattro forme con mod-reg-r/m, due con
  // l'immediato in coda.
  for (let opcode = 0; opcode < 0x40; opcode++) {
    const form = opcode & 7;
    if (form < 4) MODRM[opcode] = 1;
    else if (form === 4) IMM[opcode] = IB;
    else if (form === 5) IMM[opcode] = IZ;
  }

  set(MODRM, [0x62, 0x63, 0x69, 0x6b, [0x80, 0x8f], [0xc0, 0xc1], 0xc4, 0xc5, 0xc6, 0xc7,
    [0xd0, 0xd3], [0xd8, 0xdf], 0xf6, 0xf7, 0xfe, 0xff]);
  set(IMM, [0x68], IZ);
  set(IMM, [0x6a], IB);
  set(IMM, [0x69], IZ);
  set(IMM, [0x6b], IB);
  set(IMM, [[0x70, 0x7f]], IB);
  set(IMM, [0x80, 0x82, 0x83], IB);
  set(IMM, [0x81], IZ);
  set(IMM, [0x9a], IPTR);
  set(IMM, [[0xa0, 0xa3]], MOFFS);
  set(IMM, [0xa8], IB);
  set(IMM, [0xa9], IZ);
  set(IMM, [[0xb0, 0xb7]], IB);
  set(IMM, [[0xb8, 0xbf]], IZ);
  set(IMM, [0xc0, 0xc1], IB);
  set(IMM, [0xc2, 0xca], IW);
  set(IMM, [0xc6], IB);
  set(IMM, [0xc7], IZ);
  set(IMM, [0xc8], IWB);
  set(IMM, [0xcd, 0xd4, 0xd5], IB);
  set(IMM, [[0xe0, 0xe7]], IB);
  set(IMM, [0xe8, 0xe9], IZ);
  set(IMM, [0xea], IPTR);
  set(IMM, [0xeb], IB);
  set(IMM, [0xf6, 0xf7], GROUP3);

  set(MODRM_0F, [0x00, 0x01, 0x02, 0x03, [0x20, 0x23], [0x90, 0x9f], 0xa3, 0xa4, 0xa5, 0xab,
    0xac, 0xad, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xba, 0xbb, 0xbc, 0xbd,
    0xbe, 0xbf, 0xc0, 0xc1, 0xc7]);
  set(IMM_0F, [[0x80, 0x8f]], IZ);
  set(IMM_0F, [0xa4, 0xac, 0xba], IB);

  // Quello che si attraversa senza tradurlo.
  set(PASSABLE, [
    0x06, 0x07, 0x0e, 0x16, 0x17, 0x1e, 0x1f, // i segmenti sullo stack
    0x27, 0x2f, 0x37, 0x3f, // il decimale a mano
    0x60, 0x61, 0x62, 0x63, 0x69, 0x6b, // PUSHA, POPA, BOUND, ARPL, IMUL
    [0x6c, 0x6d], // INS: legge da una porta, non cambia niente del processore
    0x8c, 0x8e, 0x8f, // i selettori e POP in memoria
    0x9b, 0x9c, 0x9e, 0x9f, // WAIT, PUSHF, SAHF, LAHF
    [0xa4, 0xa7], [0xaa, 0xaf], // le stringhe
    0xc4, 0xc5, 0xc8, 0xc9, // LES, LDS, ENTER, LEAVE
    0xd4, 0xd5, 0xd7, [0xd8, 0xdf], // AAM, AAD, XLAT, la virgola mobile
    0xe4, 0xe5, 0xec, 0xed, // IN: entra e basta
    0xf6, 0xf7, 0xfe, // i gruppi
  ]);
  set(PASSABLE_0F, [
    0x00, 0x02, 0x03, 0x06, 0x08, 0x09, // le tabelle, CLTS, le cache
    0x30, 0x31, 0x32, // i registri di modello e il contatore di cicli
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa8, 0xa9, 0xab, // i segmenti nuovi, CPUID, i bit
    0xac, 0xad, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xba, 0xbb, 0xbc, 0xbd,
    [0xc0, 0xc1], 0xc7, [0xc8, 0xcf], // XADD, CMPXCHG8B, BSWAP
  ]);
}

// ------------------------------------------------------------- scrivere il codice

/** Il registro `index` di questa misura, come espressione che lo legge. */
function readRegister(size, index) {
  if (size === 4) return `c.r[${index}]`;
  if (size === 2) return `(c.r[${index}]&0xffff)`;
  return index & 4 ? `((c.r[${index & 3}]>>>8)&0xff)` : `(c.r[${index}]&0xff)`;
}

/** Lo stesso registro, come istruzione che ci scrive dentro `value`. */
function writeRegister(size, index, value) {
  if (size === 4) return `c.r[${index}]=(${value});`;
  if (size === 2) return `c.r[${index}]=(c.r[${index}]&0xffff0000)|((${value})&0xffff);`;
  const at = index & 3;
  if (index & 4) return `c.r[${at}]=(c.r[${at}]&0xffff00ff)|(((${value})&0xff)<<8);`;
  return `c.r[${at}]=(c.r[${at}]&0xffffff00)|((${value})&0xff);`;
}

/** Tagliare un valore alla misura, come lo taglia il processore. */
function trim(size, value) {
  if (size === 4) return `((${value})>>>0)`;
  return `((${value})&${size === 2 ? '0xffff' : '0xff'})`;
}

/** Lo stesso valore letto col segno. */
function signed(size, value) {
  if (size === 4) return `((${value})|0)`;
  return `((${value})<<${size === 2 ? 16 : 24}>>${size === 2 ? 16 : 24})`;
}

/**
 * La condizione di un salto, scritta per intero invece che chiesta a una
 * funzione. Sono otto righe, e sono il pezzo più battuto di qualunque codice:
 * un `if` del C finisce sempre qui.
 */
function conditionOf(code) {
  const tests = ['c.of', 'c.cf', 'c.zf', '(c.cf|c.zf)', 'c.sf', 'c.pf', '(c.sf^c.of)', '((c.sf^c.of)|c.zf)'];
  const test = tests[(code >> 1) & 7];
  return code & 1 ? `!${test}` : `${test}!==0`;
}

/** Le otto operazioni della griglia, come espressione che le calcola. */
function aluOf(op, size, a, b) {
  switch (op) {
    case 0:
      return `c.add(${size},${a},${b})`;
    case 1:
      return `c.logic('or',${size},${a},${b})`;
    case 2:
      return `c.add(${size},${a},${b},c.cf)`;
    case 3:
      return `c.sub(${size},${a},${b},c.cf)`;
    case 4:
      return `c.logic('and',${size},${a},${b})`;
    case 5:
      return `c.sub(${size},${a},${b})`;
    default:
      return `c.logic('xor',${size},${a},${b})`;
  }
}

const SHIFTS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];

// ----------------------------------------------------------------- un'istruzione

/**
 * Smontare un'istruzione, dal primo prefisso all'ultimo byte dell'immediato.
 *
 * È la stessa lettura che fa l'interprete, con una differenza sola e decisiva:
 * qui si fa una volta per tutte, e quello che se ne ricava — le misure, i
 * registri, la formula dell'indirizzo, i valori scritti nel codice — diventa
 * testo di un programma invece che variabili da rileggere.
 *
 * @param {(at:number)=>number} read un byte, contato dall'inizio dell'istruzione
 * @param {boolean} big se il segmento di codice è a trentadue bit
 * @returns {?object} l'istruzione, o null se non si è capita
 */
function decode(read, big) {
  const instruction = {
    length: 0,
    opcode: 0,
    two: false,
    segment: -1,
    osize: big ? 4 : 2,
    asize: big ? 4 : 2,
    repeat: 0,
    lock: false,
    modrm: false,
    mod: 0,
    reg: 0,
    rm: 0,
    memory: false,
    base: -1,
    index: -1,
    scale: 0,
    displacement: 0,
    imm: 0,
    imm2: 0,
  };

  let at = 0;
  // I prefissi. Sono pochi e si riconoscono in un colpo; quello che cambiano —
  // la misura, il segmento — qui diventa un numero fisso invece che un campo da
  // rileggere a ogni giro.
  for (;;) {
    const byte = read(at);
    if (byte === 0x26) instruction.segment = 0;
    else if (byte === 0x2e) instruction.segment = 1;
    else if (byte === 0x36) instruction.segment = 2;
    else if (byte === 0x3e) instruction.segment = 3;
    else if (byte === 0x64) instruction.segment = 4;
    else if (byte === 0x65) instruction.segment = 5;
    else if (byte === 0x66) instruction.osize = big ? 2 : 4;
    else if (byte === 0x67) instruction.asize = big ? 2 : 4;
    else if (byte === 0xf2 || byte === 0xf3) instruction.repeat = byte;
    else if (byte === 0xf0) instruction.lock = true;
    else break;
    at++;
    if (at > 8) return null; // un mucchio di prefissi non è codice: lascialo all'interprete
  }

  let opcode = read(at++);
  if (opcode === 0x0f) {
    instruction.two = true;
    opcode = read(at++);
  }
  instruction.opcode = opcode;

  const table = instruction.two ? MODRM_0F : MODRM;
  const immediate = instruction.two ? IMM_0F[opcode] : IMM[opcode];

  if (table[opcode]) {
    instruction.modrm = true;
    const byte = read(at++);
    instruction.mod = byte >> 6;
    instruction.reg = (byte >> 3) & 7;
    instruction.rm = byte & 7;
    instruction.memory = instruction.mod !== 3;
    if (instruction.memory) {
      let segment = DS;
      if (instruction.asize === 2) {
        // Gli otto indirizzi a sedici bit, che sono una tabella chiusa.
        const bases = [[3, 6], [3, 7], [5, 6], [5, 7], [-1, 6], [-1, 7], [5, -1], [3, -1]];
        const [base, index] = bases[instruction.rm];
        instruction.base = base;
        instruction.index = index;
        if (instruction.rm === 2 || instruction.rm === 3 || (instruction.rm === 6 && instruction.mod !== 0)) {
          segment = SS;
        }
        if (instruction.rm === 6 && instruction.mod === 0) {
          instruction.base = -1;
          instruction.index = -1;
          instruction.displacement = read(at) | (read(at + 1) << 8);
          at += 2;
        }
      } else if (instruction.rm === 4) {
        const sib = read(at++);
        instruction.scale = sib >> 6;
        const index = (sib >> 3) & 7;
        const base = sib & 7;
        if (index !== 4) instruction.index = index;
        if (base === 5 && instruction.mod === 0) {
          instruction.displacement = read(at) | (read(at + 1) << 8) | (read(at + 2) << 16) | (read(at + 3) << 24);
          at += 4;
        } else {
          instruction.base = base;
          if (base === 4 || base === 5) segment = SS;
        }
      } else if (instruction.rm === 5 && instruction.mod === 0) {
        instruction.displacement = read(at) | (read(at + 1) << 8) | (read(at + 2) << 16) | (read(at + 3) << 24);
        at += 4;
      } else {
        instruction.base = instruction.rm;
        if (instruction.rm === 5) segment = SS;
      }
      if (instruction.mod === 1) {
        instruction.displacement += (read(at) << 24) >> 24;
        at += 1;
      } else if (instruction.mod === 2) {
        if (instruction.asize === 2) {
          instruction.displacement += read(at) | (read(at + 1) << 8);
          at += 2;
        } else {
          instruction.displacement += read(at) | (read(at + 1) << 8) | (read(at + 2) << 16) | (read(at + 3) << 24);
          at += 4;
        }
      }
      instruction.opSegment = instruction.segment < 0 ? segment : instruction.segment;
    }
  }

  const fetch = (bytes) => {
    let value = 0;
    for (let i = 0; i < bytes; i++) value |= read(at + i) << (i * 8);
    at += bytes;
    return bytes === 4 ? value >>> 0 : value;
  };

  switch (immediate) {
    case IB:
      instruction.imm = fetch(1);
      break;
    case IW:
      instruction.imm = fetch(2);
      break;
    case IZ:
      instruction.imm = fetch(instruction.osize);
      break;
    case IPTR:
      instruction.imm = fetch(instruction.osize);
      instruction.imm2 = fetch(2);
      break;
    case MOFFS:
      instruction.imm = fetch(instruction.asize);
      break;
    case IWB:
      instruction.imm = fetch(2);
      instruction.imm2 = fetch(1);
      break;
    case GROUP3:
      // F6 e F7 hanno l'immediato solo per TEST, che è il primo del gruppo.
      if (instruction.reg <= 1) instruction.imm = fetch(instruction.opcode === 0xf6 ? 1 : instruction.osize);
      break;
    default:
      break;
  }

  instruction.length = at;
  return instruction;
}

// ------------------------------------------------------------------- il blocco

/**
 * Il magazzino dei blocchi tradotti, e la macchina che li scrive.
 *
 * Sta appeso al processore, e il processore gli chiede un blocco al posto di
 * un'istruzione ogni volta che può. Tiene tre cose: i blocchi indicizzati
 * dall'indirizzo fisico da cui cominciano, gli stessi blocchi raggruppati per
 * pagina fisica — perché è a pagine che si buttano via — e una mappa di bit che
 * dice, a ogni scrittura in memoria, se quella pagina ne contiene.
 */
export class Blocks {
  /** @param {object} cpu il processore a cui appartiene */
  constructor(cpu) {
    this.cpu = cpu;
    /** @type {Map<number,object>} dall'indirizzo fisico al blocco */
    this.blocks = new Map();
    /**
     * Dalla pagina fisica ai blocchi che ci stanno, e a quali dei suoi 4096 byte
     * sono coperti da uno di loro.
     * @type {Map<number,{list:object[], covered:Uint8Array}>}
     */
    this.pages = new Map();
    /**
     * L'ultima pagina chiesta da `invalidate`, e la sua voce. Chi scrive in una
     * pagina di solito ci scrive ancora: un buffer si riempie una parola dopo
     * l'altra, e la risposta è quasi sempre quella di un attimo prima.
     */
    this.lastPage = -1;
    this.lastEntry = undefined;
    /**
     * Un byte per pagina fisica: se in quella pagina c'è del codice tradotto.
     * È la mappa che ogni scrittura in memoria guarda, ed è per questo che è un
     * array di byte e non un insieme: leggere da un array è quasi niente, e le
     * scritture in memoria sono tante. Copre tutti e quattro i giga — un mega di
     * byte, che è poco — così che valga anche per il codice che gira nella ROM
     * in cima allo spazio di indirizzamento, e non ci sia un indirizzo per cui
     * la domanda non abbia risposta.
     */
    this.flags = new Uint8Array(1 << 20);
    /**
     * I posti da cui un blocco si è già fatto riscrivere, e fin dove ci si può
     * fidare di loro. Vedi `invalidate`: è il modo in cui il codice che si
     * rattoppa da sé smette di costare una traduzione a ogni giro.
     * @type {Map<number,{strikes:number,at:number}>}
     */
    this.limits = new Map();
    this.compiled = 0;
    this.dropped = 0;
    /** Il blocco che sta girando adesso, per sapere se se lo stanno riscrivendo sotto. */
    this.running = null;
  }

  /** Butta via tutto: lo si fa quando cambia quello che c'è a un indirizzo. */
  clear() {
    this.forget();
    for (const page of this.pages.keys()) this.flags[page] = 0;
    this.blocks.clear();
    this.pages.clear();
    this.limits.clear();
    if (this.running !== null) this.cpu.abort = 1;
    this.running = null;
  }

  /**
   * Qualcuno ha scritto in una pagina che contiene codice tradotto.
   *
   * Si buttano via solo i blocchi che coprono davvero i byte scritti, e non
   * tutti quelli della pagina: il codice e i dati di un programma del DOS
   * stanno quasi sempre nella stessa pagina da quattro KB, e buttare via tutto a
   * ogni variabile scritta vorrebbe dire non tradurre mai niente.
   *
   * E poi c'è il codice che riscrive sé stesso, che non è un caso di scuola: il
   * modo normale di chiamare un servizio del DOS il cui numero non si sa a
   * priori è scriversi quel numero dentro il proprio `INT nn` e poi eseguirlo.
   * Un blocco così, tradotto, si butterebbe via a ogni chiamata — e tradurlo
   * costa più che leggerlo. Allora ci si ricorda **fin dove** quel posto si
   * lascia riscrivere, e dal terzo colpo in poi il blocco si ferma un byte
   * prima: le undici istruzioni buone restano tradotte, e la dodicesima, quella
   * che si rattoppa, passa dall'interprete come ha sempre fatto.
   */
  invalidate(phys, size = 1) {
    const page = phys >>> 12;
    let entry;
    if (page === this.lastPage) entry = this.lastEntry;
    else {
      entry = this.pages.get(page);
      this.lastPage = page;
      this.lastEntry = entry;
    }
    if (entry === undefined) {
      this.flags[page] = 0;
      return;
    }
    // Prima la domanda che costa poco: i byte scritti sono di un blocco? Il
    // DOS tiene i suoi buffer nelle stesse pagine del suo codice, e una copia
    // dal CD ci scrive dentro mezzo mega al secondo, una parola per volta:
    // scorrere la lista dei blocchi a ogni parola era un quarto di tutto il
    // tempo della macchina.
    const covered = entry.covered;
    const from = phys & 0xfff;
    const to = Math.min(from + size, 0x1000);
    let hit = false;
    for (let i = from; i < to; i++) {
      if (covered[i]) {
        hit = true;
        break;
      }
    }
    if (!hit) return;
    const list = entry.list;
    const end = phys + size;
    let kept = null;
    let dropped = 0;
    for (const block of list) {
      if (phys < block.end && end > block.phys) {
        if (this.blocks.get(block.phys) === block) this.blocks.delete(block.phys);
        dropped++;
        const at = phys > block.phys ? phys - block.phys : 0;
        const known = this.limits.get(block.phys);
        if (known === undefined) this.limits.set(block.phys, { strikes: 1, at });
        else {
          known.strikes++;
          if (at < known.at) known.at = at;
        }
      } else (kept ??= []).push(block);
    }
    if (dropped === 0) return;
    this.dropped += dropped;
    // Se quello che se ne va è il blocco che sta girando, chi lo sta eseguendo
    // deve fermarsi: da qui in avanti starebbe eseguendo un codice che in
    // memoria non c'è più.
    if (this.running !== null && phys < this.running.end && end > this.running.phys) {
      this.cpu.abort = 1;
    }
    if (kept === null) {
      this.pages.delete(page);
      this.flags[page] = 0;
      this.forget();
    } else this.setPage(page, kept);
  }

  /** La cache di `invalidate` non vale più: una pagina è cambiata. */
  forget() {
    this.lastPage = -1;
    this.lastEntry = undefined;
  }

  /** La lista dei blocchi di una pagina, e la mappa dei byte che coprono rifatta da capo. */
  setPage(page, list) {
    const covered = new Uint8Array(0x1000);
    for (const block of list) this.cover(covered, page, block);
    this.pages.set(page, { list, covered });
    this.forget();
  }

  cover(covered, page, block) {
    const base = page * 0x1000;
    covered.fill(1, block.phys - base, Math.min(block.end - base, 0x1000));
  }

  /**
   * Un blocco, dall'inizio alla fine.
   *
   * Torna il costo in cicli di quello che ha eseguito, come `step`, e come
   * `step` lascia il processore dove l'ultima istruzione l'ha portato. Se il
   * codice di qui non si può tradurre — la finestra video, una pagina che si
   * riscrive, un'istruzione che non si è capita — si torna a un'istruzione per
   * volta, che è sempre la risposta giusta e non è mai sbagliata.
   */
  run() {
    const cpu = this.cpu;
    // Si azzera qui e non alla fine: se un blocco se ne andasse per un errore
    // che non è un'eccezione del processore, non lascerebbe niente di storto
    // dietro di sé.
    this.running = null;
    cpu.abort = 0;
    const code = cpu.seg[CS];
    const eip = cpu.eip;
    const at = (code.base + eip) >>> 0;
    let phys = at;
    if (cpu.cr0 & 0x80000000) {
      try {
        phys = cpu.translate(at, false);
      } catch (error) {
        // Il page fault sulla pagina del codice: lo si serve come lo servirebbe
        // l'interprete, con il processore fermo dov'era.
        cpu.startEIP = eip;
        cpu.startCS = cpu.s[CS];
        cpu.startESP = cpu.r[ESP];
        const cost = cpu.serviceFault(error);
        cpu.tsc += cost;
        return cost;
      }
    }

    let block = this.blocks.get(phys);
    if (block === undefined || block.eip !== eip || block.big !== code.big) {
      block = this.compile(eip, phys, code.big);
      if (block === null) return cpu.step();
    }

    // Da dove è cominciato il blocco: CS non cambia finché il blocco dura,
    // perché ogni istruzione che lo cambia lo chiude.
    cpu.startCS = cpu.s[CS];
    this.running = block;
    const cost = block.run(cpu);
    cpu.tsc += cost;
    return cost;
  }

  /**
   * Scrivere la funzione JavaScript di un blocco, e tenersela.
   *
   * @param {number} eip da dove comincia, nel segmento
   * @param {number} phys lo stesso posto, come indirizzo fisico
   * @param {boolean} big se il segmento di codice è a trentadue bit
   * @returns {?object}
   */
  compile(eip, phys, big) {
    // La finestra video non si traduce: leggerci dentro muove i fermi della VGA,
    // e un traduttore legge più avanti di quanto l'interprete arriverebbe.
    if (phys >= 0xa0000 && phys < 0xc0000) return null;

    const cpu = this.cpu;
    const lines = [];
    let room = 0x1000 - (phys & 0xfff);
    const known = this.limits.get(phys);
    if (known !== undefined && known.strikes >= PATIENCE) {
      if (known.at === 0) return null;
      if (known.at < room) room = known.at;
    }
    let offset = 0;
    let count = 0;
    let ended = false;

    while (count < MAX_INSTRUCTIONS && offset < room) {
      const start = offset;
      const instruction = decode((k) => cpu.readPhys8(phys + start + k), big);
      if (instruction === null) break;
      // Un'istruzione che uscirebbe dalla pagina non si traduce: la pagina dopo
      // può non esserci, e il suo page fault deve arrivare mentre la si legge.
      if (start + instruction.length > room) break;
      const next = big ? (eip + start + instruction.length) >>> 0 : (eip + start + instruction.length) & 0xffff;
      // Un'istruzione a cavallo della fine del segmento a sedici bit: la lascio
      // all'interprete, che sa avvolgere EIP mentre legge.
      if (!big && eip + start + instruction.length > 0x10000) break;

      const piece = emit(instruction, eip + start, next, big);
      if (piece === null) break;
      // Ogni istruzione dentro le sue graffe: le variabili che si porta dietro
      // — un indirizzo calcolato una volta, un valore da scambiare — vivono
      // dentro l'istruzione e non si pestano con quelle di quella dopo.
      lines.push(`{${piece.code}}`);
      count++;
      offset = start + instruction.length;
      if (piece.ends) {
        ended = true;
        break;
      }
    }

    // Da qui non si ricava niente — un'istruzione che non ci sta nella pagina,
    // un mucchio di prefissi che non è codice: la si lascia all'interprete, e
    // non si segna niente, perché domani lì ci potrebbe essere un altro
    // programma.
    if (count === 0) return null;
    if (!ended) {
      // Il blocco è finito perché era lungo abbastanza, non perché il codice
      // saltava: EIP va lasciato dove arriva il blocco.
      const end = big ? (eip + offset) >>> 0 : (eip + offset) & 0xffff;
      lines.push(`c.eip=${end};`);
    }

    const source = `let n=0;\ntry{\n${lines.join('\n')}\n}catch(e){return n+c.serviceFault(e);}\nreturn n;`;
    // eslint-disable-next-line no-new-func
    const run = new Function('c', source);
    const block = { run, phys, end: phys + offset, eip, big, count };
    this.compiled++;

    const page = phys >>> 12;
    // Lo stesso indirizzo fisico può essere raggiunto da due EIP diversi: il
    // blocco di prima lascia il posto a questo, e deve uscire anche dalla lista
    // della sua pagina, o resterebbe lì a farsi cercare per sempre.
    const before = this.blocks.get(phys);
    if (before !== undefined) {
      const entry = this.pages.get(page);
      if (entry !== undefined) this.setPage(page, entry.list.filter((one) => one !== before));
    }
    this.blocks.set(phys, block);
    let entry = this.pages.get(page);
    if (entry === undefined) {
      entry = { list: [], covered: new Uint8Array(0x1000) };
      this.pages.set(page, entry);
      this.forget();
    }
    this.flags[page] = 1;
    entry.list.push(block);
    this.cover(entry.covered, page, block);
    return block;
  }
}

/**
 * Un'istruzione, tradotta.
 *
 * Torna il testo da mettere nella funzione, e se quel testo chiude il blocco.
 * Ogni istruzione comincia lasciandosi dietro da dove era partita — è quello
 * che serve a `serviceFault` per farla ricominciare — e finisce aggiungendo al
 * conto i cicli che l'interprete le avrebbe dato, gli stessi, perché il tempo
 * della macchina non deve cambiare solo perché è cambiato l'emulatore.
 *
 * Quello che non ha un traduttore suo passa dall'interprete: si rimette EIP
 * all'inizio dell'istruzione, si chiama `interpret`, e si guarda dove il
 * processore è finito. Se non è finito all'istruzione dopo, ha saltato — o ha
 * ricominciato da capo, che è quello che fa un `rep` — e il blocco finisce lì.
 */
function emit(instruction, ip, next, big) {
  const { opcode, two, osize, asize } = instruction;
  // Dove l'istruzione comincia, che è quello che serve a `serviceFault` per
  // farla ricominciare da capo se si ferma a metà. Il conto delle istruzioni lo
  // aggiunge chi la traduce davvero: quelle lasciate all'interprete se lo
  // contano da sé, dentro `interpret`.
  const head = `c.startEIP=${ip};c.startESP=c.r[${ESP}];`;
  const counted = `${head}c.instructions++;`;
  const done = (code, cost) => {
    // Un'istruzione che scrive in memoria può aver riscritto il blocco stesso:
    // dopo quelle, e solo dopo quelle, si guarda se si deve smettere.
    const touches = code.includes('c.write(') || code.includes('c.push(');
    const check = touches ? `if(c.abort!==0){c.eip=${next};return n;}` : '';
    return { code: `${counted}${code}n+=${cost};${check}`, ends: false };
  };
  const leave = (code, cost) => ({ code: `${counted}${code}return n+${cost};`, ends: true });

  // L'indirizzo dell'operando in memoria, come formula già ridotta: i registri
  // che ci sono, lo spostamento sommato in anticipo, e nient'altro.
  const address = () => {
    const parts = [];
    if (instruction.base >= 0) parts.push(asize === 2 ? `(c.r[${instruction.base}]&0xffff)` : `c.r[${instruction.base}]`);
    if (instruction.index >= 0) {
      const value = asize === 2 ? `(c.r[${instruction.index}]&0xffff)` : `c.r[${instruction.index}]`;
      parts.push(instruction.scale ? `(${value}<<${instruction.scale})` : value);
    }
    if (instruction.displacement !== 0 || parts.length === 0) parts.push(`${instruction.displacement | 0}`);
    const sum = parts.join('+');
    return asize === 2 ? `((${sum})&0xffff)` : `((${sum})>>>0)`;
  };

  let temporaries = 0;
  const temporary = () => `t${temporaries++}`;

  // L'operando r/m: o un registro, o la memoria. Quando si legge e si riscrive
  // lo stesso posto l'indirizzo si calcola una volta e si tiene in una
  // variabile, come lo tiene il processore.
  let held = null;
  const rmAddress = () => {
    if (held === null) {
      held = temporary();
      return { setup: `const ${held}=${address()};`, name: held };
    }
    return { setup: '', name: held };
  };
  const rmRead = (size) => {
    if (!instruction.memory) return { setup: '', code: readRegister(size, instruction.rm) };
    const { setup, name } = rmAddress();
    return { setup, code: `c.read(${size},${instruction.opSegment},${name})` };
  };
  const rmWrite = (size, value) => {
    if (!instruction.memory) return { setup: '', code: writeRegister(size, instruction.rm, value) };
    const { setup, name } = rmAddress();
    return { setup, code: `c.write(${size},${instruction.opSegment},${name},${value});` };
  };

  /** Quello che non si traduce: una chiamata all'interprete e un controllo. */
  const interpreted = (ends) => {
    if (ends) return { code: `${head}c.eip=${ip};return n+c.interpret();`, ends: true };
    return {
      code: `${head}c.eip=${ip};n+=c.interpret();if(c.eip!==${next}||c.abort!==0)return n;`,
      ends: false,
    };
  };

  if (two) {
    switch (opcode) {
      // I salti condizionati lunghi: la destinazione è già contata.
      case 0x80: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87:
      case 0x88: case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f: {
        const target = osize === 4 ? (next + (instruction.imm | 0)) >>> 0 : (next + ((instruction.imm << 16) >> 16)) & 0xffff;
        return leave(`if(${conditionOf(opcode & 0x0f)})c.eip=${target};else c.eip=${next};`, 1);
      }
      // SETcc: la condizione che diventa un numero.
      case 0x90: case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
      case 0x98: case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: case 0x9f: {
        const write = rmWrite(1, `${conditionOf(opcode & 0x0f)}?1:0`);
        return done(`${write.setup}${write.code}`, 1);
      }
      // MOVZX e MOVSX: allungare un byte o una parola, con o senza segno.
      case 0xb6: case 0xb7: case 0xbe: case 0xbf: {
        const from = opcode === 0xb6 || opcode === 0xbe ? 1 : 2;
        if (from === 2 && osize === 2) return interpreted(!PASSABLE_0F[opcode]);
        const read = rmRead(from);
        const value = opcode < 0xbe ? read.code : trim(osize, signed(from, read.code));
        return done(`${read.setup}${writeRegister(osize, instruction.reg, value)}`, 1);
      }
      default:
        return interpreted(!PASSABLE_0F[opcode]);
    }
  }

  // La griglia in testa alla tabella: otto operazioni per sei forme.
  if (opcode < 0x40 && (opcode & 7) < 6) {
    const op = (opcode >> 3) & 7;
    const form = opcode & 7;
    const size = form & 1 ? osize : 1;
    if (form < 2) {
      const read = rmRead(size);
      const other = readRegister(size, instruction.reg);
      if (op === 7) return done(`${read.setup}c.sub(${size},${read.code},${other});`, 2);
      const value = aluOf(op, size, read.code, other);
      const write = rmWrite(size, value);
      return done(`${read.setup}${write.setup}${write.code}`, 2);
    }
    if (form < 4) {
      const read = rmRead(size);
      const mine = readRegister(size, instruction.reg);
      if (op === 7) return done(`${read.setup}c.sub(${size},${mine},${read.code});`, 2);
      return done(`${read.setup}${writeRegister(size, instruction.reg, aluOf(op, size, mine, read.code))}`, 2);
    }
    // Con l'accumulatore e un immediato.
    const accumulator = readRegister(size, 0);
    if (op === 7) return done(`c.sub(${size},${accumulator},${instruction.imm});`, 1);
    return done(writeRegister(size, 0, aluOf(op, size, accumulator, instruction.imm)), 1);
  }

  switch (opcode) {
    // I segmenti che vanno e vengono dallo stack. In modo protetto a sedici bit
    // — che è dove sta Windows 3.1 — sono un'istruzione su dieci.
    case 0x06: case 0x0e: case 0x16: case 0x1e:
      return done(`c.push(c.s[${opcode >> 3}],${osize});`, 1);
    case 0x07: case 0x17: case 0x1f:
      return done(`c.loadSegment(${opcode >> 3},c.pop(${osize}));`, 3);

    // INC e DEC di un registro: un byte, e sono il conto di ogni ciclo.
    case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
    case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
      const index = opcode & 7;
      const how = opcode < 0x48 ? 'inc' : 'dec';
      return done(writeRegister(osize, index, `c.${how}(${osize},${readRegister(osize, index)})`), 1);
    }
    case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
      return done(`c.push(${readRegister(osize, opcode & 7)},${osize});`, 1);
    case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
      return done(writeRegister(osize, opcode & 7, `c.pop(${osize})`), 1);
    case 0x68:
      return done(`c.push(${instruction.imm},${osize});`, 1);
    case 0x6a: {
      const extended = (instruction.imm << 24) >> 24;
      return done(`c.push(${osize === 4 ? extended >>> 0 : extended & 0xffff},${osize});`, 1);
    }

    // I salti corti, la destinazione già contata.
    case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
      const relative = (instruction.imm << 24) >> 24;
      const target = osize === 4 ? (next + relative) >>> 0 : (next + relative) & 0xffff;
      return leave(`if(${conditionOf(opcode & 0x0f)})c.eip=${target};else c.eip=${next};`, 1);
    }

    // I gruppi con l'immediato.
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const size = opcode === 0x80 || opcode === 0x82 ? 1 : osize;
      const raw = opcode === 0x83 ? (instruction.imm << 24) >> 24 : instruction.imm;
      const value = size === 4 ? raw >>> 0 : raw & (size === 2 ? 0xffff : 0xff);
      const op = instruction.reg;
      const read = rmRead(size);
      if (op === 7) return done(`${read.setup}c.sub(${size},${read.code},${value});`, 2);
      const write = rmWrite(size, aluOf(op, size, read.code, value));
      return done(`${read.setup}${write.setup}${write.code}`, 2);
    }
    case 0x84: case 0x85: {
      const size = opcode === 0x84 ? 1 : osize;
      const read = rmRead(size);
      return done(`${read.setup}c.logic('and',${size},${read.code},${readRegister(size, instruction.reg)});`, 2);
    }
    case 0x86: case 0x87: {
      const size = opcode === 0x86 ? 1 : osize;
      const read = rmRead(size);
      const keep = temporary();
      const write = rmWrite(size, readRegister(size, instruction.reg));
      return done(
        `${read.setup}const ${keep}=${read.code};${write.setup}${write.code}${writeRegister(size, instruction.reg, keep)}`,
        3,
      );
    }
    // MOV, che è un quarto di tutto il codice del mondo.
    case 0x88: case 0x89: {
      const size = opcode === 0x88 ? 1 : osize;
      const write = rmWrite(size, readRegister(size, instruction.reg));
      return done(`${write.setup}${write.code}`, 1);
    }
    case 0x8a: case 0x8b: {
      const size = opcode === 0x8a ? 1 : osize;
      const read = rmRead(size);
      return done(`${read.setup}${writeRegister(size, instruction.reg, read.code)}`, 1);
    }
    case 0x8c: {
      // Un selettore in un registro: i sedici bit alti si azzerano, e non è un
      // dettaglio — vedi la nota nell'interprete.
      const value = `c.s[${instruction.reg & 7}]`;
      if (instruction.memory) {
        const { setup, name } = rmAddress();
        return done(`${setup}c.write(2,${instruction.opSegment},${name},${value});`, 1);
      }
      return done(writeRegister(osize === 4 ? 4 : 2, instruction.rm, value), 1);
    }
    case 0x8e: {
      // CS non si carica così: chi ci prova prende un opcode non valido, e
      // quello lo sa dire l'interprete.
      if ((instruction.reg & 7) === CS) return interpreted(true);
      const read = rmRead(2);
      return done(`${read.setup}c.loadSegment(${instruction.reg & 7},${read.code});`, 3);
    }
    case 0x8d: {
      // LEA: l'indirizzo senza la memoria, cioè la moltiplicazione gratis di
      // ogni compilatore.
      if (!instruction.memory) return interpreted(true);
      return done(writeRegister(osize, instruction.reg, address()), 1);
    }
    case 0x90:
      return done('', 1);
    case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
      const index = opcode & 7;
      const keep = temporary();
      return done(
        `const ${keep}=${readRegister(osize, 0)};${writeRegister(osize, 0, readRegister(osize, index))}${writeRegister(osize, index, keep)}`,
        2,
      );
    }
    case 0x98:
      return done(
        osize === 2
          ? writeRegister(2, 0, `${signed(1, readRegister(1, 0))}&0xffff`)
          : writeRegister(4, 0, signed(2, readRegister(2, 0))),
        1,
      );
    case 0x99:
      return done(
        osize === 2
          ? writeRegister(2, 2, `${signed(2, readRegister(2, 0))}<0?0xffff:0`)
          : writeRegister(4, 2, `(c.r[0]&0x80000000)!==0?0xffffffff:0`),
        1,
      );

    // L'indirizzo assoluto, che il DOS usa dappertutto.
    case 0xa0: case 0xa1: {
      const size = opcode === 0xa0 ? 1 : osize;
      const segment = instruction.segment < 0 ? DS : instruction.segment;
      return done(writeRegister(size, 0, `c.read(${size},${segment},${instruction.imm})`), 1);
    }
    case 0xa2: case 0xa3: {
      const size = opcode === 0xa2 ? 1 : osize;
      const segment = instruction.segment < 0 ? DS : instruction.segment;
      return done(`c.write(${size},${segment},${instruction.imm},${readRegister(size, 0)});`, 1);
    }
    case 0xa8: case 0xa9: {
      const size = opcode === 0xa8 ? 1 : osize;
      return done(`c.logic('and',${size},${readRegister(size, 0)},${instruction.imm});`, 1);
    }

    case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
      return done(writeRegister(1, opcode & 7, instruction.imm), 1);
    case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
      return done(writeRegister(osize, opcode & 7, instruction.imm), 1);

    // Gli scorrimenti: l'operazione si sa già, e il conteggio anche quando è
    // scritto nel codice.
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const size = opcode === 0xc0 || opcode === 0xd0 || opcode === 0xd2 ? 1 : osize;
      const count =
        opcode === 0xc0 || opcode === 0xc1 ? `${instruction.imm}`
          : opcode === 0xd0 || opcode === 0xd1 ? '1'
            : readRegister(1, 1);
      const read = rmRead(size);
      const write = rmWrite(size, `c.shift('${SHIFTS[instruction.reg]}',${size},${read.code},${count})`);
      return done(`${read.setup}${write.setup}${write.code}`, 2);
    }
    case 0xc2: {
      const keep = temporary();
      return leave(
        `const ${keep}=c.pop(${osize});c.set(c.stacksize,${ESP},c.get(c.stacksize,${ESP})+${instruction.imm});c.eip=${trim(osize, keep)};`,
        2,
      );
    }
    case 0xc3:
      return leave(`c.eip=${trim(osize, `c.pop(${osize})`)};`, 2);
    case 0xc9:
      // LEAVE: lo stack frame smontato, che è la fine di ogni funzione del C.
      return done(`c.set(c.stacksize,${ESP},c.get(${osize},5));${writeRegister(osize, 5, `c.pop(${osize})`)}`, 3);
    case 0xc6: case 0xc7: {
      const size = opcode === 0xc6 ? 1 : osize;
      const write = rmWrite(size, instruction.imm);
      return done(`${write.setup}${write.code}`, 1);
    }

    // I cicli, che sono il motivo per cui tutto questo serve.
    case 0xe0: case 0xe1: case 0xe2: {
      const relative = (instruction.imm << 24) >> 24;
      const target = osize === 4 ? (next + relative) >>> 0 : (next + relative) & 0xffff;
      const counter = asize === 4 ? 'c.r[1]' : '(c.r[1]&0xffff)';
      const step = asize === 4
        ? `c.r[${ECX}]=c.r[${ECX}]-1;`
        : `c.r[${ECX}]=(c.r[${ECX}]&0xffff0000)|((c.r[${ECX}]-1)&0xffff);`;
      const zero = opcode === 0xe1 ? '&&c.zf===1' : opcode === 0xe0 ? '&&c.zf===0' : '';
      return leave(`${step}if(${counter}!==0${zero})c.eip=${target};else c.eip=${next};`, 2);
    }
    case 0xe3: {
      const relative = (instruction.imm << 24) >> 24;
      const target = osize === 4 ? (next + relative) >>> 0 : (next + relative) & 0xffff;
      const counter = asize === 4 ? 'c.r[1]' : '(c.r[1]&0xffff)';
      return leave(`if(${counter}===0)c.eip=${target};else c.eip=${next};`, 2);
    }
    case 0xe8: {
      const relative = osize === 4 ? instruction.imm | 0 : (instruction.imm << 16) >> 16;
      const target = osize === 4 ? (next + relative) >>> 0 : (next + relative) & 0xffff;
      return leave(`c.push(${next},${osize});c.eip=${target};`, 2);
    }
    case 0xe9: case 0xeb: {
      const relative = opcode === 0xeb
        ? (instruction.imm << 24) >> 24
        : osize === 4 ? instruction.imm | 0 : (instruction.imm << 16) >> 16;
      const target = osize === 4 ? (next + relative) >>> 0 : (next + relative) & 0xffff;
      return leave(`c.eip=${target};`, 1);
    }

    case 0x9a:
      // L'indirizzo di ritorno che la chiamata impila è quello dell'istruzione
      // dopo: EIP deve essere già lì.
      return leave(`c.eip=${next};c.farCall(${instruction.imm2},${instruction.imm},${osize});`, 6);
    case 0xcd:
      return leave(`c.eip=${next};c.v86Sensitive();c.interrupt(${instruction.imm},{software:true});`, 10);
    case 0xcf:
      return leave(`c.eip=${next};c.iret(${osize});`, 10);

    case 0xc8:
      return done(`c.enterFrame(${osize},${instruction.imm},${instruction.imm2 & 0x1f});`, 6);
    case 0xca: case 0xcb:
      return leave(`c.farReturn(${osize},${opcode === 0xca ? instruction.imm : 0});`, 5);

    case 0xf5:
      return done('c.cf^=1;', 1);
    case 0xf8:
      return done('c.cf=0;', 1);
    case 0xf9:
      return done('c.cf=1;', 1);
    case 0xfc:
      return done('c.df=0;', 1);
    case 0xfd:
      return done('c.df=1;', 1);

    case 0xf6: case 0xf7: {
      const size = opcode === 0xf6 ? 1 : osize;
      const read = rmRead(size);
      switch (instruction.reg) {
        case 0: case 1:
          return done(`${read.setup}c.logic('and',${size},${read.code},${instruction.imm});`, 2);
        case 2: {
          const write = rmWrite(size, trim(size, `~${read.code}`));
          return done(`${read.setup}${write.setup}${write.code}`, 2);
        }
        case 3: {
          // NEG, che è l'unica sottrazione in cui il riporto si scrive a mano.
          const keep = temporary();
          const write = rmWrite(size, `c.sub(${size},0,${keep})`);
          return done(`${read.setup}const ${keep}=${read.code};${write.setup}${write.code}c.cf=${keep}===0?0:1;`, 2);
        }
        default:
          // Moltiplicare e dividere vuol dire sessantaquattro bit, e quelli li
          // sa fare l'interprete con i suoi BigInt.
          return interpreted(false);
      }
    }
    case 0xfe: {
      if (instruction.reg > 1) return interpreted(true);
      const how = instruction.reg === 0 ? 'inc' : 'dec';
      const read = rmRead(1);
      const write = rmWrite(1, `c.${how}(1,${read.code})`);
      return done(`${read.setup}${write.setup}${write.code}`, 2);
    }
    case 0xff: {
      switch (instruction.reg) {
        case 0: case 1: {
          const how = instruction.reg === 0 ? 'inc' : 'dec';
          const read = rmRead(osize);
          const write = rmWrite(osize, `c.${how}(${osize},${read.code})`);
          return done(`${read.setup}${write.setup}${write.code}`, 2);
        }
        case 2: {
          const read = rmRead(osize);
          const keep = temporary();
          return leave(
            `${read.setup}const ${keep}=${read.code};c.push(${next},${osize});c.eip=${trim(osize, keep)};`,
            2,
          );
        }
        case 4: {
          const read = rmRead(osize);
          return leave(`${read.setup}c.eip=${trim(osize, read.code)};`, 1);
        }
        case 6: {
          const read = rmRead(osize);
          return done(`${read.setup}c.push(${read.code},${osize});`, 2);
        }
        case 3: case 5: {
          // La chiamata e il salto lontani, con l'indirizzo preso dalla memoria:
          // quattro o sei byte di cui i due in cima sono il selettore.
          if (!instruction.memory) return interpreted(true);
          const { setup, name } = rmAddress();
          const offset = temporary();
          const selector = temporary();
          const body = `${setup}const ${offset}=c.read(${osize},${instruction.opSegment},${name});`
            + `const ${selector}=c.read(2,${instruction.opSegment},${name}+${osize});`;
          if (instruction.reg === 3) return leave(`${body}c.eip=${next};c.farCall(${selector},${offset},${osize});`, 6);
          return leave(`${body}c.farJump(${selector},${offset});`, 4);
        }
        default:
          return interpreted(true);
      }
    }

    default:
      return interpreted(!PASSABLE[opcode]);
  }
}
