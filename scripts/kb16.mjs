// KB16.COM: i due pezzi di BIOS da AT che mancano all'XT, per far funzionare KEYB.
//
// Una tastiera italiana e una americana sono lo stesso pezzo di ferro, e che il
// tasto numero 26 sia una parentesi quadra o una «è» lo decide il software. Sul
// DOS lo decide KEYB: si mette davanti all'INT 9, guarda il codice del tasto, e
// se la tastiera scelta ci vuole un'altra lettera la mette lui nel buffer della
// tastiera del BIOS. Per farlo conta su due cose che i BIOS AT del 1986 hanno e
// che nessun BIOS XT ha mai avuto, GLaBIOS compreso:
//
//  - **l'INT 16h con AH=05h**, «scrivi nel buffer della tastiera». È così che
//    KEYB consegna ogni lettera che traduce. Un BIOS XT risponde con un'alzata
//    di spalle, e la «è» sparisce senza che nessuno se ne accorga: le lettere
//    che KEYB non traduce passano, e quelle che traduce no.
//  - **l'Alt di destra distinto da quello di sinistra.** Fuori dagli Stati
//    Uniti l'Alt di destra è l'AltGr, il tasto delle lettere del terzo livello
//    — la chiocciola, il cancelletto, le quadre. La tastiera estesa lo manda con
//    un prefisso, E0h, e un BIOS AT se ne accorge e accende il bit dell'Alt ma
//    non quello dell'«Alt di sinistra». GLaBIOS non conosce il prefisso, e ogni
//    Alt per lui è quello di sinistra: KEYB guarda, vede un Alt normale, e non
//    scrive niente.
//
// Allora si faceva così: un programmino residente che aggiunge quello che
// manca. Questo è quel programmino, e fa le due cose:
//
//  - si aggancia all'INT 16h, risponde da sé alla funzione 5 e passa tutte le
//    altre al BIOS;
//  - si aggancia all'INT 9, davanti a tutti: si annota il byte che arriva dalla
//    tastiera *prima* di passarlo agli altri — perché mentre gli altri lavorano
//    può arrivare il byte dopo, e con lui un'altra interruzione dentro questa —
//    e quando il BIOS ha finito, se il byte era un Alt o un Ctrl con E0 davanti,
//    spegne il bit che lo diceva «di sinistra».
//
// Per stare davanti a KEYB va caricato dopo di lui: nell'AUTOEXEC la riga di
// KB16 viene subito dopo quella di KEYB. E prima di installarsi chiede al BIOS
// se la funzione 5 ce l'ha già, infilando nel buffer un tasto che non esiste —
// scansione FFh, carattere FFh — e guardando se la coda si è mossa. Se si è
// mossa, la rimette dov'era e se ne va senza lasciare niente in memoria: è
// quello che succede sul Pentium, che lo stesso disco lo avvia con SeaBIOS, e
// SeaBIOS è un BIOS AT. È anche quello che succede se lo si lancia due volte.
//
// Nessun assemblatore: i byte sono scritti qui sotto uno per uno, ciascuno con
// la sua istruzione accanto, e le etichette le risolve `assemble()` in due
// passate — che è tutto quello che un assemblatore fa, a parte i messaggi
// d'errore. Solo istruzioni dell'8086, così gira anche su un XT vero.
//
// Il buffer è quello di sempre: sedici posti da due byte fra 40:1Eh e 40:3Eh,
// con la testa in 40:1Ah e la coda in 40:1Ch. I BIOS AT permettono di spostarlo
// (40:80h e 40:82h), GLaBIOS no, e il programma non se ne preoccupa.

/** Dove il DOS carica un .COM: subito dopo i 256 byte del PSP. */
const ORIGIN = 0x100;

/** I due byte di un numero a sedici bit, il meno significativo per primo. */
const word = (value) => [value & 0xff, (value >> 8) & 0xff];

/**
 * Il programma, un'istruzione per riga. Una stringa è un'etichetta; una
 * funzione riceve le etichette e l'indirizzo in cui si trova e dà i suoi byte —
 * serve ai salti e agli indirizzi, che si sanno solo alla seconda passata.
 */
const PROGRAM = [
  // Il .COM comincia dall'inizio: si salta subito all'installazione, che sta in
  // fondo così da poterla buttare via una volta finita.
  (l, at) => [0xeb, rel8(l.install, at + 2)], //   jmp short install

  'old16', //                                       il vettore di prima, per tutto il resto
  [0, 0, 0, 0], //                                  dd 0
  'old9',
  [0, 0, 0, 0], //                                  dd 0
  'last', //                                        l'ultimo byte arrivato dalla tastiera
  [0], //                                           db 0

  // ------------------------------------------ INT 16h, funzione 5: scrivi nel buffer

  'int16',
  [0x80, 0xfc, 0x05], //                            cmp ah, 5
  (l, at) => [0x74, rel8(l.store, at + 2)], //      je store
  (l) => [0x2e, 0xff, 0x2e, ...word(l.old16)], //   jmp far [cs:old16]

  'store', //                                       CH = scansione, CL = carattere
  [0x1e], //                                        push ds
  [0x56], //                                        push si
  [0x53], //                                        push bx
  [0xbe, ...word(0x40)], //                         mov si, 40h
  [0x8e, 0xde], //                                  mov ds, si
  [0xfa], //                                        cli
  [0x8b, 0x1e, ...word(0x1c)], //                   mov bx, [1Ch]        la coda
  [0x8d, 0x77, 0x02], //                            lea si, [bx+2]       il posto dopo
  [0x83, 0xfe, 0x3e], //                            cmp si, 3Eh          in fondo al buffer?
  (l, at) => [0x72, rel8(l.inside, at + 2)], //     jb inside
  [0xbe, ...word(0x1e)], //                         mov si, 1Eh          si ricomincia da capo
  'inside',
  [0x3b, 0x36, ...word(0x1a)], //                   cmp si, [1Ah]        raggiungerebbe la testa?
  (l, at) => [0x74, rel8(l.full, at + 2)], //       je full
  [0x89, 0x0f], //                                  mov [bx], cx
  [0x89, 0x36, ...word(0x1c)], //                   mov [1Ch], si
  [0x30, 0xc0], //                                  xor al, al           fatto
  (l, at) => [0xeb, rel8(l.stored, at + 2)], //     jmp short stored
  'full',
  [0xb0, 0x01], //                                  mov al, 1            buffer pieno
  'stored',
  [0xfb], //                                        sti
  [0x5b], //                                        pop bx
  [0x5e], //                                        pop si
  [0x1f], //                                        pop ds
  [0xcf], //                                        iret

  // ------------------------------------------------ INT 9: l'Alt e il Ctrl di destra

  'int9',
  [0x50], //                                        push ax
  [0x53], //                                        push bx
  [0x1e], //                                        push ds
  [0xe4, 0x60], //                                  in al, 60h           il byte, ancora sul filo
  [0x88, 0xc4], //                                  mov ah, al
  (l) => [0x2e, 0x86, 0x06, ...word(l.last)], //    xchg al, [cs:last]   AL = quello di prima
  [0x89, 0xc3], //                                  mov bx, ax           BL = prima, BH = adesso
  [0x9c], //                                        pushf
  (l) => [0x2e, 0xff, 0x1e, ...word(l.old9)], //    call far [cs:old9]   KEYB, poi il BIOS
  [0x80, 0xfb, 0xe0], //                            cmp bl, 0E0h         aveva il prefisso?
  (l, at) => [0x75, rel8(l.leave, at + 2)], //      jne leave
  [0xb0, 0xfd], //                                  mov al, 0FDh         il bit dell'Alt di sinistra
  [0x80, 0xff, 0x38], //                            cmp bh, 38h          Alt premuto?
  (l, at) => [0x74, rel8(l.right, at + 2)], //      je right
  [0xb0, 0xfe], //                                  mov al, 0FEh         il bit del Ctrl di sinistra
  [0x80, 0xff, 0x1d], //                            cmp bh, 1Dh          Ctrl premuto?
  (l, at) => [0x75, rel8(l.leave, at + 2)], //      jne leave
  'right',
  [0xbb, ...word(0x40)], //                         mov bx, 40h
  [0x8e, 0xdb], //                                  mov ds, bx
  [0x20, 0x06, ...word(0x18)], //                   and [18h], al        era quello di destra
  'leave',
  [0x1f], //                                        pop ds
  [0x5b], //                                        pop bx
  [0x58], //                                        pop ax
  [0xcf], //                                        iret

  // ------------------------------------------------- l'installazione, che se ne va

  'install',
  [0xb8, ...word(0x40)], //                         mov ax, 40h
  [0x8e, 0xc0], //                                  mov es, ax
  [0x26, 0x8b, 0x1e, ...word(0x1c)], //             mov bx, [es:1Ch]     la coda prima
  [0xb9, 0xff, 0xff], //                            mov cx, 0FFFFh       un tasto che non esiste
  [0xb4, 0x05], //                                  mov ah, 5
  [0xcd, 0x16], //                                  int 16h
  [0x26, 0x3b, 0x1e, ...word(0x1c)], //             cmp bx, [es:1Ch]     la coda si è mossa?
  (l, at) => [0x74, rel8(l.missing, at + 2)], //    je missing
  [0x26, 0x89, 0x1e, ...word(0x1c)], //             mov [es:1Ch], bx     sì: si toglie il tasto finto
  [0xb8, 0x00, 0x4c], //                            mov ax, 4C00h        e si esce senza restare
  [0xcd, 0x21], //                                  int 21h

  'missing',
  [0xb8, 0x16, 0x35], //                            mov ax, 3516h        dov'è l'INT 16h adesso
  [0xcd, 0x21], //                                  int 21h              → ES:BX
  (l) => [0x89, 0x1e, ...word(l.old16)], //         mov [old16], bx
  (l) => [0x8c, 0x06, ...word(l.old16 + 2)], //     mov [old16+2], es
  [0xb8, 0x09, 0x35], //                            mov ax, 3509h        e l'INT 9
  [0xcd, 0x21], //                                  int 21h
  (l) => [0x89, 0x1e, ...word(l.old9)], //          mov [old9], bx
  (l) => [0x8c, 0x06, ...word(l.old9 + 2)], //      mov [old9+2], es
  (l) => [0xba, ...word(l.int16)], //               mov dx, int16
  [0xb8, 0x16, 0x25], //                            mov ax, 2516h        l'INT 16h adesso è questo
  [0xcd, 0x21], //                                  int 21h
  (l) => [0xba, ...word(l.int9)], //                mov dx, int9
  [0xb8, 0x09, 0x25], //                            mov ax, 2509h        e l'INT 9 quest'altro
  [0xcd, 0x21], //                                  int 21h
  [0x8e, 0x06, ...word(0x2c)], //                   mov es, [2Ch]        l'ambiente, che non serve
  [0xb4, 0x49], //                                  mov ah, 49h
  [0xcd, 0x21], //                                  int 21h
  (l) => [0xba, ...word((l.install + 15) >> 4)], // mov dx, paragrafi fino a install
  [0xb8, 0x00, 0x31], //                            mov ax, 3100h        termina e resta residente
  [0xcd, 0x21], //                                  int 21h
];

/** Vero durante la prima passata, quando le etichette in avanti non si sanno ancora. */
let sizing = false;

/** Lo spostamento di un salto corto, contato da dopo l'istruzione. */
function rel8(target, next) {
  if (sizing) return 0;
  const distance = target - next;
  if (distance < -128 || distance > 127) throw new Error(`salto troppo lungo: ${distance}`);
  return distance & 0xff;
}

/**
 * Le due passate. Nella prima le etichette non si sanno ancora, e ogni
 * istruzione dice solo quanto è lunga — con le etichette a un valore qualunque,
 * che per la lunghezza fa lo stesso; nella seconda si sanno tutte e si
 * scrivono i byte.
 */
function assemble(program) {
  const labels = {};
  const placeholder = new Proxy({}, { get: (_, name) => labels[name] ?? ORIGIN });
  let at = ORIGIN;
  sizing = true;
  for (const item of program) {
    if (typeof item === 'string') labels[item] = at;
    else at += (typeof item === 'function' ? item(placeholder, at) : item).length;
  }
  sizing = false;
  const bytes = [];
  at = ORIGIN;
  for (const item of program) {
    if (typeof item === 'string') continue;
    const chunk = typeof item === 'function' ? item(labels, at) : item;
    bytes.push(...chunk);
    at += chunk.length;
  }
  return Uint8Array.from(bytes);
}

/** Il nome con cui sta sul disco, accanto a KEYB. */
export const KB16_NAME = 'KB16.COM';

/** Il programma, pronto da scrivere sul disco. */
export const KB16 = assemble(PROGRAM);
