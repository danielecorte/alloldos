# AllOldOs

**→ [danielecorte.github.io/alloldos](https://danielecorte.github.io/alloldos/)**

Un raccoglitore di vecchi sistemi operativi emulati, che gira interamente dentro
il browser. Si parte da una schermata di boot in stile GRUB: scegli la macchina
con le frecce, premi Invio, e quella macchina si accende.

Ce ne sono due che partono davvero:

- il **Commodore 64**, emulato dal silicio in su — 6510, VIC-II, due CIA e il
  SID — e avviato sul KERNAL e sul BASIC V2 originali;
- l'**Amiga 500**, con il 68000, Agnus, Denise, Paula, due CIA 8520 e il drive
  DF0:, avviato sulla Kickstart e capace di leggere un `.adf`. Ci gira sopra un
  sistema operativo vero: **AROS m68k** arriva alla sua schermata di avvio.

Non è una simulazione dell'aspetto di quei computer: sono quei computer che
eseguono il loro firmware. Il firmware però non è incluso — è di chi lo ha
scritto — quindi al primo avvio la macchina te lo chiede e tu glielo trascini
sopra, una volta sola.

In fondo al menu c'è la voce **About**: una pagina in stile C64 con i crediti,
la licenza, e poi una sezione per macchina con quello che c'è dentro e quello
che manca ancora.

## Avvio

```sh
npm run fetch-roms   # scarica KERNAL, BASIC e il generatore di caratteri
npm start            # http://localhost:8080
```

Nessuna dipendenza, nessun passo di build: sono moduli ES serviti così come
sono. `npm test` esegue cinque prove a schermo spento: la prima accende il C64,
verifica che arrivi al prompt `READY.` e ci fa girare un programma; la seconda
preme i tasti attraverso lo stesso codice che usa il browser e rilegge dallo
schermo i caratteri arrivati davvero al BASIC; la terza registra un nastro e lo
fa ricaricare al KERNAL; la quarta prende l'Amiga a pezzi (vedi sotto); la
quinta monta un DOM finto e fa girare l'intera sessione del browser di
entrambe le macchine, canvas e audio compresi.

Se in cartella c'è un `.tap`, l'ultima prova ci carica dentro anche quello e poi
**ci gioca**: tiene premuta una direzione e guarda dove finisce il personaggio.
Con `1994.tap` — che si guida con su e giù, su cammina a destra e giù a
sinistra — la prova è che la sua coordinata cala tenendo giù, risale tenendo su
e non si muove di un pixel se non premi niente. È tutta la catena in una riga
sola: l'evento del browser, la matrice, il joystick sulla porta 1, la lettura
che il gioco fa di `$dc01`, il pixel sullo schermo.

## Le ROM

Nessun firmware è incluso in questo progetto, e nessuno è coperto dalla sua
licenza. Le due macchine se lo procurano in due modi diversi, perché in due modi
diversi si può fare onestamente.

**Il C64** ha il suo in VICE, che lo distribuisce da decenni:
`npm run fetch-roms` scarica `kernal.bin`, `basic.bin` e `chargen.bin` in
`roms/c64/`. In alternativa trascina i tre file sulla finestra: vengono
riconosciuti dal contenuto — il nome non conta — e restano salvati in quel
browser.

**L'Amiga** non ha niente del genere. La Kickstart non è un aiuto all'avvio: è
il sistema operativo, con dentro exec, graphics, intuition e dos, ed è di
Cloanto. Nessuna copia gratuita in circolazione è una copia legale, quindi non
c'è niente da scaricare. Ci sono però due strade oneste:

- [Amiga Forever](https://www.amigaforever.com/) di Cloanto, che è la licenza
  ufficiale delle ROM;
- la Kickstart di rimpiazzo di [AROS](https://aros.sourceforge.io/), che è
  **software libero** — ed è quella su cui alloldos è provato.

Quella di AROS viaggia dentro **FS-UAE**, quindi `npm run fetch-roms` la va a
cercare da sé: se hai `fs-uae` installato (`apt install fs-uae`, o il download
da fs-uae.net) se la prende e la mette in `roms/amiga/`. Altrimenti ti dice
dove guardare.

Serve un file da 256 KB (Kickstart 1.2 o 1.3) o da 512 KB (2.0 e successive),
da trascinare sulla finestra o da mettere in `roms/amiga/kickstart.rom`. Le ROM
cifrate di Cloanto — quelle che iniziano con `AMIROMTYPE1` — non vanno bene così
come sono: serve la versione in chiaro.

AROS è divisa in due: la Kickstart vera e propria, e una **ROM di estensione**
con dentro il resto del sistema. Va in `roms/amiga/extended.rom`, o trascinata
anche lei — la macchina la mette nel secondo zoccolo, a `$e00000`, che è dove
l'A600, l'A1200 e il CDTV tengono la loro.

Quello che trascini resta nel tuo browser e non va da nessuna parte: alloldos
non ha un server a cui mandarlo.

## Commodore 64

### Far girare un file `.bas`

Trascina un `.bas` sulla finestra, oppure usa **Carica .bas / .prg**. Quello che
succede è la stessa cosa che succedeva nel 1982, solo più in fretta:

1. il testo viene **tokenizzato** come lo tokenizzerebbe il BASIC in ROM —
   `PRINT` diventa il byte `$99`, `+` diventa `$aa`, il testo diventa PETSCII;
2. il risultato viene scritto in memoria a `$0801` come lista concatenata di
   righe, e i puntatori di BASIC (`$2b`/`$2d`/`$2f`/`$31`) vengono aggiornati;
3. `RUN` più Invio finiscono nel buffer di tastiera del KERNAL a `$0277`.

Da lì in poi è il BASIC vero a interpretare il programma. Nessuna scorciatoia:
`PEEK`, `POKE`, `SYS`, `RND`, gli errori di sintassi, la velocità — tutto viene
dalla ROM.

Vanno bene anche i `.prg`: se si caricano a `$0801` partono con `RUN`, altrimenti
l'emulatore mostra l'indirizzo a cui li ha messi, così puoi lanciarli con `SYS`.
**Salva .bas** fa il percorso inverso, da memoria a testo.

Il testo è quello che scriveresti sul C64, con due comodità in più:

- le maiuscole non contano, `print` e `PRINT` sono la stessa cosa;
- i caratteri di controllo si scrivono per nome: `{clr}`, `{home}`, `{down}`,
  `{rvs on}`, `{cyan}`, e anche `{5 right}` o `{$93}` per un byte qualsiasi.

In `programs/` ci sono quattro esempi da provare subito, incluso l'immortale
labirinto di una riga sola.

### Le cassette (`.tap`)

Un `.tap` non contiene file: contiene il treno di impulsi che usciva dalla
testina, misurato in cicli di clock fra un fronte e il successivo. Quindi non
viene interpretato — viene **risuonato**. La linea di lettura del registratore
è collegata al piedino /FLAG del CIA 1, ogni impulso alza un interrupt, e il
KERNAL misura le distanze con il Timer B esattamente come faceva nel 1982.

Questo significa che funzionano anche i **turbo loader**: nessuno qui capisce il
formato del nastro, quindi non c'è niente da capire di sbagliato.

Trascina un `.tap` e la sequenza parte da sola: `LOAD`, `PRESS PLAY ON TAPE`,
`SEARCHING`, `FOUND`, `LOADING`, e infine `RUN`. Il nastro viene mandato avanti
il più in fretta possibile — su hardware vero ci volevano minuti — e sotto lo
schermo compaiono il contatore e i comandi del registratore.

**Salva .tap** fa il contrario: registra il programma in memoria su un'immagine
di nastro, nel formato che scrive la ROM.

#### Come è stato ricavato il formato

Non da una tabella. Il registratore emulato sa anche registrare, quindi al C64
emulato è stato fatto scrivere un nastro con la sua `SAVE`, e la forma d'onda è
stata misurata: ogni impulso è fatto di due semionde uguali da 184, 256 o 344
cicli, il leader è di `$6A00` impulsi, e fra le due copie di ogni blocco c'è uno
stacco di 80 impulsi corti. `npm test` chiude il cerchio: fa registrare un
nastro alla macchina e glielo ridà da leggere.

### Tasti

Il layout è **simbolico**: il carattere che digiti è il carattere che arriva al
C64. Su una tastiera italiana `;` è `Shift+,` e sul C64 è un tasto senza shift —
lo Shift che tieni premuto viene tolto di mezzo, altrimenti uscirebbe `]`. Vale
per tutta la punteggiatura: `"` è `Shift+2`, `£` è `Shift+3`, `?` è `Shift+'`.

Due caratteri non esistono sul C64 e finiscono sul parente più prossimo:
`_` diventa `←` e `^` diventa `↑`.

| Tasto | Sul C64 |
| --- | --- |
| Invio, Backspace, Spazio | RETURN, INST/DEL, SPACE |
| Frecce | CRSR (Shift automatico per su e sinistra) |
| Esc | RUN/STOP |
| Tab | CTRL |
| Alt sinistro | tasto Commodore |
| Pag↑ | RESTORE (NMI) |
| Home, Fine | CLR/HOME, CLR |
| F1…F8 | i quattro tasti funzione, con Shift |
| Tastierino numerico | joystick |
| F9, F10 | reset, apri un file |

`Ctrl+V` incolla del testo battendolo nella macchina un tasto alla volta.

Il tasto Commodore sta su Alt e non su Ctrl di proposito: `Ctrl`+lettera è una
scorciatoia del browser, e la finestra se ne va prima che arrivi il `keyup` —
il tasto resterebbe premuto e da lì in poi uscirebbe tutt'altro. Per la stessa
ragione lo stato di Shift e Commodore viene ricostruito dai flag di ogni
evento, così un `keyup` perso si ripara da solo al tasto successivo.

Se qualcosa non torna, **Diagnostica tasti** nella barra in basso mostra in
diretta l'evento ricevuto e la cella della matrice in cui viene tradotto.

### Il joystick

Il pulsante **Joystick** nella barra cicla fra tre stati: frecce = tasti cursore
del C64 (com'è all'inizio, perché al BASIC servono), frecce = joystick nella
porta 1, frecce = joystick nella porta 2. Lo spazio diventa il fuoco. Il
tastierino numerico è sempre un joystick, sulla porta selezionata.

Le due porte servono entrambe perché i giochi si dividono più o meno a metà fra
l'una e l'altra, e sulla cassetta non c'è scritto da nessuna parte quale
vogliono. Per questo la macchina **guarda quale porta il programma sta
interrogando** e te lo dice nella barra di stato: *"Questo programma usa il
joystick nella porta 1"*. Lo dice in fretta — bastano una trentina di letture,
cioè meno di un secondo per un gioco che guarda la porta a ogni quadro e pochi
secondi per uno che la guarda a ogni mossa — perché serve mentre stai ancora
agitando le frecce chiedendoti perché non succede niente.

La porta 1 sta sulle stesse linee delle colonne della tastiera, quindi una
lettura conta come joystick solo se il programma non si è appena selezionato
una riga di tastiera: chi scandisce la tastiera tira giù una linea della porta A
prima di leggere, chi legge il joystick prende la porta B com'è.

Una curiosità che non è un difetto: sul C64 le linee del joystick e quelle
della tastiera sono le stesse. Il fuoco della porta 1 è il bit PB4, e nella
matrice lo spazio sta esattamente lì — quindi in molti giochi si spara con la
barra spaziatrice anche senza joystick. Lo riproduciamo perché succedeva.

## Amiga 500

Un A500 PAL: 68000 a 7,09 MHz, Agnus, Denise e Paula, due CIA 8520 e il drive
DF0:. Trascinaci sopra una Kickstart e si accende; dagli poi un `.adf` e premi
**Reset**, e da lì in avanti è AmigaOS che fa il resto.

La memoria è quella di un A500 cresciuto bene, e non per vezzo: 1 MB di Chip RAM
(l'Agnus 8372A dell'A500+, a cui moltissimi A500 sono stati portati), i 512 KB
dello sportello — la scheda A501, che avevano quasi tutti — e 8 MB di Fast RAM su
una scheda Zorro II che si annuncia da sé in autoconfig. Il motivo è AROS: è un
sistema operativo molto più grande della Kickstart per cui questo software è
stato scritto, riempie da solo i 512 KB dello sportello e, senza altro spazio, si
piazza in cima alla Chip RAM — cioè esattamente dove un gioco mette lo schermo. È
la differenza fra uno schermo nero e un gioco che parte.

### I dischi (`.adf`)

Un `.adf` è il contenuto di un floppy senza niente di quello che lo rendeva un
floppy: 80 cilindri, due facce, undici settori da 512 byte, in fila e basta.
Quello che l'hardware dell'Amiga legge davvero, però, è un flusso di bit — con
intestazioni, checksum, sync e gap — che `trackdisk.device` decodifica via
software.

Quindi l'emulatore rimette quello che l'immagine ha tolto: ogni traccia viene
**ricodificata in MFM**, bit di clock compresi, e data alla DMA come flusso
grezzo. Il sync `$4489` è l'unico schema che viola apertamente la regola dei bit
di clock, ed è proprio per questo che si riesce a ritrovare in mezzo a tutto il
resto — la prova in `npm test` verifica che nient'altro nella traccia gli
somigli.

Il resto del drive è fatto con le stesse mani: il motore si aggancia sul fronte
in cui la testina viene selezionata, i passi arrivano come impulsi su /STEP con
la direzione su un altro piedino, e le quattro linee di stato (/RDY, /TK0,
/WPRO, /CHNG) tornano indietro sulla porta A del CIA-A. Con il motore fermo
/RDY fa anche da identificazione del drive, che è il modo in cui il ROM scopre
che al connettore c'è un 3,5" da 880 KB.

DF0: è **sempre protetto in scrittura**: qui non si scrive su nessun disco.

### Tastiera e mouse

La tastiera è **posizionale**: ogni tasto del PC va sul tasto che sta nello
stesso posto sulla tastiera Amiga. La tastiera dell'Amiga è un computer per
conto suo — scandisce la propria matrice e manda alla macchina un byte alla
volta su una linea seriale — quindi qui succede lo stesso: il codice del tasto
viene spostato di un bit, il bit che avanza dice se è andato giù o è tornato su,
e il tutto viene invertito perché la linea a riposo sta alta.

| Tasto | Sull'Amiga |
| --- | --- |
| Invio, Backspace, Tab, Esc | Return, Backspace, Tab, Esc |
| Canc | Del |
| Ins | Help |
| Win sinistro / destro | Amiga sinistro / destro |
| Alt destro | Alt destro |
| F1…F10 | F1…F10 |
| F9 | reset della macchina |
| F11 | apri un file |

Il mouse è più strano: l'Amiga non sa dove sia il puntatore, sa solo di quanto è
girata la pallina. Per questo il puntatore dell'host va **catturato** — il
pulsante nella barra, o un clic sull'immagine — altrimenti i due puntatori si
troverebbero d'accordo solo fino al primo bordo dello schermo. Si libera con
Esc, come qualsiasi altra pagina che cattura il mouse. Il tasto sinistro è un
piedino del CIA-A, il destro sta in POTGOR: sono due strade completamente
diverse dentro la macchina, ed è per quello che i menu si aprono con il destro.

### Cosa c'è dentro

Il **68000** è completo: modo utente e supervisore, i due stack pointer, e le
eccezioni vere — errore di indirizzo con il suo frame lungo, violazione di
privilegio, `TRAP`, divisione per zero, `CHK`, `STOP`, gli interrupt
autovettorizzati. Serve tutto: un sistema operativo in ROM lo usa molto prima
di disegnare qualsiasi cosa.

**Agnus** conta il pennello e distribuisce la DMA, e soprattutto fa girare il
**copper** — il processore che non sa fare altro che aspettare il pennello e
scrivere nei registri mentre lo schermo si sta disegnando. Qui la riga viene
disegnata a pezzi e non tutta insieme, così una MOVE del copper a metà riga
cambia il colore a metà riga, non dall'inizio.

Il **blitter** ha i quattro canali, i 256 minterm, il barrel shifter, l'area
fill e il tracciamento di linee alla Bresenham — sì, anche le linee sono un
blit. **Denise** fa da uno a sei bitplane, lores e hires, dual playfield, HAM ed
extra half brite, gli otto sprite con le priorità di BPLCON2 e la finestra di
visualizzazione. **Paula** raccoglie gli interrupt di tutta la macchina e suona
quattro canali in DMA, 0 e 3 a sinistra e 1 e 2 a destra.

Un dettaglio che spiega il primo istante di vita della macchina: appena accesa,
la linea di *overlay* non è pilotata da nessuno, e una linea non pilotata sta
alta — quindi la ROM si vede anche all'indirizzo zero, che è dove il 68000 va a
cercare il suo stack pointer e la sua prima istruzione. Una delle prime cose che
la Kickstart fa è tirarla giù attraverso la porta A del CIA-A, e da quel momento
all'indirizzo zero c'è la RAM.

L'**interlace** c'è: ogni riga di quadro ha due righe di framebuffer, e i due
semiquadri finiscono su quelle alterne invece che uno sopra l'altro — senza,
un Workbench a 640×512 viene fuori schiacciato a metà altezza.

Non c'è tutto: i blit finiscono in un colpo solo invece di rubare i cicli di DMA
che ruberebbero davvero (chi aspetta BBUSY o l'interrupt non se ne accorge, chi
conta i cicli sì), non si scrive sui dischi, e mancano i collision detect, le
porte pot, il secondo drive e la memoria autoconfig.

### Le prove

`node scripts/amigatest.mjs` prende la macchina a pezzi senza bisogno di una
Kickstart, che non c'è e non ci può essere:

- **il 68000** viene messo alla prova un'istruzione alla volta, scritta in
  codice macchina a mano: gli overflow con segno, ADDX su 64 bit, MOVEM,
  DBcc, la divisione per zero che diventa un'eccezione, i due stack pointer che
  si scambiano il posto entrando e uscendo dal modo supervisore;
- **l'MFM** viene generato e poi riletto come lo rileggerebbe trackdisk —
  cercando i sync, ricomponendo le metà pari e dispari, verificando i checksum —
  e i dati devono tornare indietro byte per byte;
- **la macchina intera** viene fatta partire con una ROM di poche istruzioni
  scritte a mano, che accende i bitplane, fa girare una copper list, avvia un
  blit e mette uno sprite sullo schermo: quello che si controlla sono i pixel
  che escono, non i registri che ci sono entrati;
- **il drive** viene guidato come lo guida il ROM: selezione e motore dalla
  porta B del CIA-B, i piedini di stato letti dalla porta A del CIA-A, la
  testina portata a passi fino alla traccia 0, e poi una traccia intera letta in
  DMA, in cui si va a ripescare l'intestazione di un settore.

E poi, se in `roms/amiga/` c'è una Kickstart, la prova che conta più di tutte le
altre: **si accende la macchina e si guarda se un sistema operativo ci sale
sopra**. Con la ROM di AROS ci vogliono 900 quadri — diciotto secondi di tempo
Amiga, quattro di tempo vero — e alla fine la prova controlla che la ROM si sia
tolta dall'indirizzo zero, che abbia acceso la DMA e messo su dei bitplane, che
una copper list stia girando, e che sullo schermo ci sia un'immagine sparsa su
decine di righe e non ammucchiata in due.

### Le due cose che solo un sistema operativo vero ha trovato

Il resto delle prove qui sopra passava anche prima. Queste due no, e nessuna
delle due si vede finché non provi a far girare del software vero:

- **Un timer CIA in one-shot parte quando gli scrivi il byte alto.** Sta nel
  foglio dati del 6526 in una riga sola, e nessuno lo implementa la prima volta:
  scrivere il latch alto di un timer fermo lo carica *e*, se è in one-shot, lo
  fa anche partire. AmigaOS ci costruisce sopra l'handshake della tastiera —
  scrive il timer e non tocca più il bit di start — quindi senza quella riga la
  macchina si inchioda a metà avvio, con tutte le task in attesa e nessuna
  pronta. È lo stesso chip del C64, quindi la correzione è andata anche lì.
- **Il fetch dei bitplane si conta a blocchi di otto color clock, arrotondando
  per eccesso.** Un DDFSTOP che cade in mezzo a un blocco non lo tronca. Se lo
  tronchi, ogni riga dello schermo pesca due byte più indietro di quella sopra,
  e il risultato è un Workbench perfettamente leggibile — in diagonale.

## Schermo intero

Il pulsante **Schermo intero** nella barra, o un doppio clic sull'immagine. A
schermo intero ci va la macchina intera, barra compresa: i pulsanti, il
contatore del nastro e la riga di stato restano dove sono, e il quadro si
prende tutta l'altezza rimasta mantenendo le proporzioni dei pixel PAL. Si esce
col pulsante, che nel frattempo è diventato **Finestra**, o come si esce da
qualsiasi schermo intero. Comunque tu esca, l'etichetta del pulsante lo sa:
segue il browser, non i nostri clic.

## Com'è fatto

```
index.html            la pagina
src/main.js           menu di boot -> macchina -> menu di boot
src/boot/             il bootloader in stile GRUB e l'elenco delle macchine
src/about/            la pagina About, che si avvia come se fosse una macchina
src/systems/c64/      il Commodore 64
  cpu6502.js          il 6510: tutti gli opcode, illegali compresi
  machine.js          RAM, ROM, banking PLA, bus, e il giro di un frame PAL
  vic2.js             VIC-II: testo, multicolor, bitmap, sprite, raster IRQ
  cia.js              6526: timer, TOD, tastiera, joystick, NMI, /FLAG
  datasette.js        il 1530: motore, tasti, impulsi in lettura e scrittura
  tap.js              il formato .tap, letto e scritto
  sid.js              6581: tre voci, ADSR vero, filtro approssimato
  keyboard.js         matrice della tastiera e mappatura dal PC
  basic.js            tokenizzatore e detokenizzatore del BASIC V2
  roms.js             dove trovare il firmware
  index.js            la sessione: canvas, audio, file, comandi
src/systems/amiga/    l'Amiga 500
  cpu68000.js         il 68000: utente e supervisore, eccezioni comprese
  machine.js          Chip RAM, Kickstart, overlay, bus, e il giro di un frame
  agnus.js            beam, DMA di bitplane e sprite, e il copper
  blitter.js          quattro canali, 256 minterm, area fill, linee
  denise.js           bitplane, sprite, priorità, HAM, EHB, e i pixel
  paula.js            interrupt di tutta la macchina, e quattro voci in DMA
  cia.js              8520: timer, TOD a 24 bit, tastiera seriale, overlay
  disk.js             DF0:: motore, testina, passi, e la DMA del disco
  adf.js              da immagine .adf a flusso MFM, checksum compresi
  keyboard.js         tastiera posizionale e contatori del mouse
  roms.js             dove trovare la Kickstart
  index.js            la sessione: canvas, audio, dischi, mouse, comandi
```

Le due macchine sono costruite allo stesso modo: la CPU esegue i cicli di una
riga, poi la riga viene disegnata. Non è esatto al singolo ciclo, ma sul C64 le
badline, i contatori di riga e gli interrupt di raster ci sono — che è quello
che serve agli split di schermo e allo scrolling — e sull'Amiga la riga viene
divisa in blocchi da otto color clock, così il copper e la CPU si alternano e le
scritture del copper cadono nel punto della riga in cui avvengono davvero.
Entrambi i quadri sono PAL: 312 righe da 63 cicli a 50,125 Hz per il C64, 312
righe da 227 color clock a 50,06 Hz per l'Amiga.

## Aggiungere una macchina

Un sistema è un modulo con un solo export:

```js
export async function boot(container, { onExit }) {
  // prende possesso di `container`, e chiama onExit() per tornare al menu
  return { dispose() {} };
}
```

Poi si aggiunge una voce a `src/boot/systems.js` con la descrizione e un
`load: () => import(...)`. Il modulo viene scaricato solo quando quella voce
viene davvero avviata. Le voci senza `load` compaiono nel menu ma non partono,
come una partizione che GRUB elenca e non sa leggere — ce ne sono già tre in
attesa di qualcuno che le scriva.

Non serve che sia una macchina: la voce **About** in fondo al menu è una pagina
in stile C64 con crediti, licenza e una sezione per macchina, e si avvia
esattamente attraverso questo contratto. Una voce può anche descriversi con le
proprie righe invece che con cpu/memoria/note, passando
`details: [[etichetta, valore]]`.

## Licenza

alloldos è software libero, sotto **GNU General Public License versione 3** —
il testo completo è in [`LICENSE`](LICENSE). Puoi usarlo, studiarlo,
modificarlo e ridistribuirlo, a patto che chi lo riceve da te si ritrovi con le
stesse libertà.

Le ROM del Commodore 64 (KERNAL, BASIC, generatore di caratteri) e la Kickstart
dell'Amiga sono proprietà Commodore/Cloanto: non sono incluse in questo progetto
e non sono coperte da questa licenza.

Scritto da Daniele Corte e Claude Code. Il codice sta su
[github.com/danielecorte/alloldos](https://github.com/danielecorte/alloldos).
