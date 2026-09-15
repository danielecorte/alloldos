# AllOldOs

**→ [danielecorte.github.io/alloldos](https://danielecorte.github.io/alloldos/)**

Un raccoglitore di vecchi sistemi operativi emulati, che gira interamente dentro
il browser. Si parte da una schermata di boot in stile GRUB: scegli la macchina
con le frecce, premi Invio, e quella macchina si accende.

Ce ne sono sei che partono davvero:

- il **Commodore 64**, emulato dal silicio in su — 6510, VIC-II, due CIA e il
  SID — e avviato sul KERNAL e sul BASIC V2 originali;
- l'**Amiga 500**, con il 68000, Agnus, Denise, Paula, due CIA 8520 e i due
  drive DF0: e DF1:, avviato sulla Kickstart e capace di leggere e scrivere un
  `.adf`. Ci gira sopra un sistema operativo vero: **AROS m68k** arriva alla sua
  schermata di avvio;
- il **PC 286** con scheda XT, il lettore di dischetti da 720 KB, un disco
  fisso da 20 MB, una **VGA** e una **Sound Blaster**. È l'unica macchina qui
  libera fino in fondo: il BIOS **GLaBIOS**, la ROM della scheda del disco
  **XTIDE**, il **VGABIOS** LGPL compilato qui per il 286, e sopra **FreeDOS**,
  che si accende dal dischetto o dal disco e arriva al suo prompt;
- il **PC 386** a 33 MHz con otto mega, VGA e mouse PS/2, acceso dal **BIOS di
  Bochs** — libero anche lui — sullo stesso disco con FreeDOS del 286. È la
  scheda del Pentium qui sotto con un processore di cinque anni prima, e il
  primo PC di questa collezione con il modo protetto in mano al software: c'è
  il 387, e FreeDOS gira anche in modo virtuale 8086, sotto JEMMEX;
- il **PC Pentium** del 1995 — modo protetto, paginazione, bus PCI, VGA — con
  sopra **SeaBIOS**, che arriva in fondo al POST e avvia **FreeDOS** dal disco
  IDE fino al prompt. È lo stesso file di disco che si accende sul 286, letto a
  sedici bit da un controllore diverso su porte diverse;
- lo **ZX Spectrum 48K**: uno Z80, una ULA e nient'altro. Si accende sul suo
  BASIC, carica le cassette rifacendo il suono che c'era sul nastro, e la
  macchina si batte da sola il `LOAD ""`.

Non è una simulazione dell'aspetto di quei computer: sono quei computer che
eseguono il loro firmware. Il firmware però non è incluso — è di chi lo ha
scritto — quindi al primo avvio la macchina te lo chiede e tu glielo trascini
sopra, una volta sola.

In fondo al menu c'è la voce **About**: una pagina in stile C64 con i crediti,
la licenza, e poi una sezione per macchina con quello che c'è dentro e quello
che manca ancora.

## Avvio

```sh
npm run fetch-roms   # le ROM libere e quelle che si possono scaricare
npm start            # http://localhost:8080
```

Il disco fisso del PC è già in cartella — `roms/pc/hdd.img`, venti mega con
FreeDOS installato sopra, l'unica immagine di disco che viaggia con alloldos — e
`npm run make-hdd` serve solo a rifarlo da capo. Accanto c'è
`roms/pc/vgabios.bin`, il BIOS della VGA del 286, che già compilato per quel
processore non si trova da nessuna parte: `npm run build-vgabios` lo rifà.

Nessuna dipendenza, nessun passo di build: sono moduli ES serviti così come
sono. `npm test` esegue otto prove a schermo spento: la prima accende il C64,
verifica che arrivi al prompt `READY.` e ci fa girare un programma; la seconda
preme i tasti attraverso lo stesso codice che usa il browser e rilegge dallo
schermo i caratteri arrivati davvero al BASIC; la terza registra un nastro e lo
fa ricaricare al KERNAL; la quarta prende l'Amiga a pezzi (vedi sotto); la
quinta monta un DOM finto e fa girare l'intera sessione del browser di tutte le
macchine, canvas e audio compresi; la sesta accende il PC, gli fa fare il
POST con il BIOS vero e ci avvia FreeDOS dal dischetto, dal disco fisso e da un
disco di un'altra misura montato da fuori; la
settima accende lo Spectrum, ci fa fare un conto in virgola mobile alla sua ROM
e gli fa caricare una cassetta; l'ottava prende il Pentium — il processore nei suoi
tre mondi, i chip della scheda madre uno per uno, il disco IDE registro per
registro — e poi ci accende sopra SeaBIOS, che arriva in fondo al POST e avvia
FreeDOS dal disco fisso: si batte `dir` sulla tastiera, ci si scrive sopra un
file e lo si ritrova dopo aver spento e riacceso. E dal dischetto, dove la prova
si ferma appena il kernel si è caricato per intero. Alla fine, sulla stessa
scheda, ci monta un 386 con il BIOS di Bochs e lo porta fino al prompt, contando
le istruzioni che un 386 non avrebbe saputo eseguire: devono essere zero.

Se in cartella c'è un `.tap`, l'ultima prova ci carica dentro anche quello e poi
**ci gioca**: tiene premuta una direzione e guarda dove finisce il personaggio.
Con `1994.tap` — che si guida con su e giù, su cammina a destra e giù a
sinistra — la prova è che la sua coordinata cala tenendo giù, risale tenendo su
e non si muove di un pixel se non premi niente. È tutta la catena in una riga
sola: l'evento del browser, la matrice, il joystick sulla porta 1, la lettura
che il gioco fa di `$dc01`, il pixel sullo schermo.

## Le ROM

Nessun firmware è incluso in questo progetto, e nessuno è coperto dalla sua
licenza. Ogni macchina se lo procura a modo suo, perché in modi diversi si può
fare onestamente.

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

**Il PC** è il caso fortunato: il suo firmware è software libero, tutto quanto.
`npm run fetch-roms` scarica tre cose in `roms/pc/`:

- `glabios.rom`, gli otto KB di **GLaBIOS 0.4.2** (GPLv3), l'unico BIOS PC
  libero e completo che esista. Fra le dieci varianti pubblicate serve il build
  per 8088 — un 286 esegue tutto quello che esegue un 8088, mentre i build "V20"
  usano le istruzioni in più del NEC V20, che il 286 non ha — nella versione
  Turbo, che è quella per i cloni generici;
- `xtide.bin`, la **XTIDE Universal BIOS** (GPLv2), che è la ROM della scheda
  del disco fisso: un BIOS XT non sa cosa sia un disco fisso;
- `fdboot.img`, il dischetto di avvio di **FreeDOS 1.3** da 720 KB, che il
  progetto pubblica solo dentro l'archivio dell'edizione a dischetti — lo script
  scarica quello e tira fuori l'immagine che serve;
- `keyb.zip` e `keyb_lay.zip`, i due pacchetti di FreeDOS con **KEYB** e le sue
  tastiere, che servono solo a `npm run make-hdd`: il disco che viaggia col
  repository li ha già sopra.

Sono tutti file liberi, e nessuno è nel repository. Due cose invece sì. Il
**disco fisso**: `roms/pc/hdd.img` c'è già, con FreeDOS installato sopra, e
`npm run make-hdd` serve solo a rifarlo. E il **BIOS della VGA**,
`roms/pc/vgabios.bin`: il VGABIOS LGPL che il progetto pubblica è compilato per
il 386 e su un 286 si pianta al primo salto, quindi questo è compilato qui dallo
stesso sorgente, per il 286 (vedi sotto). `npm run build-vgabios` lo rifà
identico byte per byte; servono gcc e i due pezzi di dev86 che il sorgente
vuole, `apt install bcc bin86`.

**Il Pentium** è il caso fortunato anche lui, con una differenza: il suo firmware
è libero ma viaggia dentro QEMU invece che su una pagina di download. SeaBIOS
(LGPLv3) e la sua SeaVGABIOS sono quello che accende ogni macchina virtuale di
QEMU, e i due file compilati stanno nel repository di QEMU:
[`bios.bin`](https://raw.githubusercontent.com/qemu/qemu/v9.0.0/pc-bios/bios.bin)
e [`vgabios.bin`](https://raw.githubusercontent.com/qemu/qemu/v9.0.0/pc-bios/vgabios.bin),
alla versione 9.0.0. `npm run fetch-roms` li scarica in `roms/pentium/`.

**Il 386** ha il firmware più comodo di tutti: il **BIOS di Bochs** e il
**VGABIOS LGPL**, entrambi LGPL, stanno già compilati nel repository di Bochs.
`npm run fetch-roms` prende quelli della versione 2.7 — sempre la stessa, così i
byte sono quelli provati — e li mette in `roms/pc386/` come `bochs-legacy.bin` e
`vgabios-lgpl.bin`. Il disco fisso è quello del 286.

**Lo ZX Spectrum** sta in mezzo fra i due casi. La sua ROM è di Amstrad, che
comprò Sinclair nel 1986 e che da allora ne permette la ridistribuzione insieme
agli emulatori: quindi si scarica, ma non è software libero. Viaggia dentro il
sorgente di [Fuse](https://fuse-emulator.sourceforge.net/), e
`npm run fetch-roms` scompatta l'archivio e ne tira fuori i sedici KB di
`roms/zx/48.rom`. Chi preferisce una ROM davvero libera può usare
[OpenSE BASIC](https://spectrumcomputing.co.uk/entry/27510/ZX-Spectrum/OpenSE_BASIC),
che è un rimpiazzo compatibile in GPL: si trascina sulla finestra al posto
dell'altra.

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

Un A500 PAL: 68000 a 7,09 MHz, Agnus, Denise e Paula, due CIA 8520 e due drive,
DF0: e DF1:. Trascinaci sopra una Kickstart e si accende; dagli poi un `.adf` e
premi **Reset**, e da lì in avanti è AmigaOS che fa il resto.

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

### Due drive

DF0: sta dentro la macchina, DF1: è il connettore dietro con un drive attaccato.
Sull'hardware sono la stessa cosa quasi in tutto: **un** filo per il motore,
**quattro** fili di stato (/RDY, /TK0, /WPRO, /CHNG) e **un** canale DMA in
Paula, per tutti e due. A distinguerli c'è solo la linea di selezione — /SEL0 sul
bit 3 della porta B del CIA-B, /SEL1 sul bit 4 — e la regola è che il drive non
selezionato lascia andare i fili, che le resistenze di pull-up tirano su. Da lì
viene tutto il resto: il motore si aggancia sul fronte in cui il drive viene
selezionato (e continua a girare anche dopo, che è come un filo solo fa girare
due motori), un passo muove la testina di chi è selezionato e nessun'altra, e la
DMA legge il disco di chi era selezionato quando è partita.

Il secondo disco di un gioco ci finisce da solo: quello che trascini sulla
finestra va nel primo drive libero, e due file insieme diventano disco uno e
disco due. Ogni drive ha la sua riga sotto lo schermo, con la sua spia, la sua
traccia e i suoi quattro bottoni.

La Kickstart il drive se lo trova da sola, senza che nessuno glielo dica: con un
disco in DF1: e DF0: vuoto, AROS accende il motore del secondo e gli legge la
traccia 0.

### Scrivere sui dischi

DF0: si scrive. Quando il gioco salva, la DMA butta fuori un'intera traccia di
MFM: l'emulatore la rilegge esattamente come farebbe la testina — sync,
intestazione, i due checksum — e i settori che tornano dicono da soli a quale
traccia e a quale posto appartengono, così finiscono nell'immagine `.adf` che sta
in memoria. Un settore con un checksum sbagliato viene buttato via invece che
riscritto sopra qualcosa di buono.

Quell'immagine sopravvive al **Reset** e al riavvio del gioco, ma non alla
chiusura della scheda: qui non c'è nessun posto dove posare un floppy. Quindi,
appena il drive smette di scrivere, il `.adf` aggiornato **viene scaricato da
solo** — la prossima volta ritrascinalo sulla finestra e i salvataggi sono lì.
C'è anche il bottone **Salva .adf** per farsene una copia quando si vuole, e
**Protetto** per chiudere la linguetta, che è l'unico modo di impedire a un gioco
di scrivere.

Un gioco che si formatta i dischi da sé, con un formato tutto suo invece di
quello di AmigaDOS, non ha dove andare in un `.adf`: la barra lo dice, e quel
salvataggio si perde.

### Un disco da provare

Un `.adf` distribuibile non si trova: i dischi dei giochi sono di chi li ha
fatti. Quindi qui il disco se lo formatta da sé:

```
npm run make-adf
```

sputa fuori `ciao.adf`, un floppy OFS — il filesystem che la Kickstart 1.3 monta
senza bisogno d'altro — con dentro `programs/ciao-amiga.bas`. Blocco di boot,
radice al blocco 880, tabella hash dei nomi, mappa dei blocchi liberi e somme di
controllo, tutto vero: si trascina sulla finestra e il drive ci legge il nome del
volume. Non si avvia, perché il codice di boot di AmigaOS è di Commodore, ed è un
disco dati come quelli che ci si formattava per i propri programmi — e senza
Workbench non c'è nessun AmigaBASIC che possa farlo girare. Il BASIC che *gira*
davvero, qui dentro, è quello del C64: sta nella sua ROM e parte da solo.

Serve però a una cosa precisa: `npm test` prende quel disco, gli riscrive sopra
il programma facendolo più lungo — una traccia intera attraverso la DMA, come
farebbe un salvataggio vero — e poi ritira fuori il file passando per la tabella
hash e la catena dei blocchi. Se il file che esce è quello nuovo e le somme di
controllo tornano ancora, allora salvare funziona davvero; altrimenti sono solo
settori che sono cambiati.

### Le collisioni (CLXDAT)

Denise conta da sé chi ha toccato chi, mentre serializza i pixel, e i giochi ci
leggono sopra: `CLXDAT` (`$dff00e`) dice in sedici bit quali sprite si sono
toccati fra loro, quali hanno toccato quale campo grafico, e se i due campi si
sono sovrapposti. Si legge **e si azzera**: quello che dice è quello che è
successo da quando l'hai letto l'ultima volta.

Chi decide cosa conta è `CLXCON` (`$dff098`), e ha due mezze parole:
**ENBP1-6** dice quali bitplane partecipano, **MVBP1-6** dice che valore devono
avere per contare come "c'è qualcosa qui". Playfield uno sono i piani dispari,
playfield due i pari. La riga che sorprende, e che sta scritta
nell'hardware manual, è questa: *un bitplane disabilitato non può impedire una
collisione*. Cioè se non abiliti niente, la collisione è continua — ed è il
motivo per cui una macchina appena accesa, che `CLXCON` non l'ha mai scritto,
segnala collisioni ovunque e sempre. Non è un difetto dell'emulatore: è la
ragione per cui i giochi la prima cosa che fanno è scriverci dentro quali piani
gli interessano (Menace abilitava solo il piano 5, quello degli alieni, per non
prendersi collisioni con lo sfondo).

Gli sprite entrano a coppie, perché il circuito ha quattro ingressi e non otto:
lo sprite pari della coppia conta sempre, il dispari solo se il suo bit **ENSP**
è acceso. Ed è la posizione a contare, non chi si vede: due sprite che si
sovrappongono collidono anche se uno dei due è nascosto dietro il campo grafico.

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

### Il joystick

Quasi ogni gioco Amiga si comanda col joystick nella **porta 2**, e il pulsante
*Joystick* nella barra ce ne mette uno: frecce e barra spazio. Va chiesto invece
di stare sempre lì perché quei tasti l'Amiga li vuole per sé — Prince of Persia,
per dirne uno, si gioca con le frecce sulla tastiera, e uno stick perennemente
inserito se le mangerebbe tutte.

Leggerlo è più strano di quanto sembri, perché la porta è nata per un mouse e
quello che restituisce sono due contatori in quadratura. Sinistra e destra sono
bit normali, il 9 e l'1. Su e giù no: escono dal bit sotto ciascuno dei due,
messo in XOR con lui. È il motivo per cui la routine dei comandi di ogni gioco
comincia con uno shift e uno XOR, e per cui `JOY1DAT` qui è costruito in modo da
sopravvivere a quel conto. Il fuoco non sta in quella parola: è il bit 7 della
porta A del CIA-A, attivo basso, il piedino accanto a quello del tasto sinistro
del mouse.

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

## PC 286

Non è un AT: è una **scheda XT con sopra un 286**, che è una macchina che nel
1988 si poteva davvero comprare, e che qui è una scelta obbligata — GLaBIOS è un
BIOS XT, e un BIOS AT libero non esiste. Il 286 è il set di istruzioni, che è
quello che il software controlla; il resto della scheda è quello che GLaBIOS sa
avviare.

È l'unica macchina di alloldos che è **libera fino in fondo**: BIOS libero
(GLaBIOS, GPLv3), ROM della scheda del disco libera (XTIDE Universal BIOS,
GPLv2), BIOS della VGA libero (il VGABIOS, LGPL), sistema operativo libero
(FreeDOS). Il firmware non è nel repository — non lo è per nessuna macchina,
con l'eccezione del BIOS della VGA, che si racconta sotto — ma **il disco fisso
sì**, ed è l'unica immagine che viaggia con alloldos: si può, perché quello che
c'è sopra è libero.

Ci si accende sopra **FreeDOS**, dal dischetto o dal disco fisso:

```
GLaBIOS [.] Reboot the Past
(C) 2022-26 640KB Released under GPLv3

Boot   [ COLD ]
RAM    [ 640 KB OK ]            Video  [ VGA ]
CPU    [ 8088 ]                 FPU    [ None ]
LPT    [ None ]                 COM    [ None ]
ROM    [ C800 ]                 Size   [ 12 KB ]
FDD    [ 1 ]

-=XTIDE Universal BIOS (XT)=- @ C800h
Master at 300h: alloldos XT-CF 20 MB

C:\>
```

`CPU [ 8088 ]` non è uno sbaglio: GLaBIOS distingue solo l'8088 dal NEC V20, e
chiama 8088 tutto il resto.

### Il lettore di dischetti

Un NEC **765** con un lettore da tre pollici e mezzo, il canale 2 del DMA e la
IRQ 6 — cioè esattamente il giro che fa un byte per andare dal disco alla
memoria senza passare dal processore. `npm run fetch-roms` scarica il dischetto
di avvio di **FreeDOS 1.3** da 720 KB in `roms/pc/fdboot.img`; qualunque altro
`.img` si trascina sulla finestra, e viene riconosciuto dalla sua lunghezza —
160, 180, 320, 360, 720 KB, 1,2 e 1,44 MB.

720 KB non è una scelta di comodo: un controllore XT sa fare una sola velocità
di trasferimento, 250 kbit/s, e le due misure grandi ne vogliono un'altra. Su
questa macchina, nel 1988, un 1,44 non si sarebbe letto.

Quello che il DOS scrive sul dischetto finisce nell'immagine in memoria, e
appena il lettore tace l'`.img` aggiornato viene scaricato: in una scheda del
browser non c'è nessuno scaffale dove posare un floppy.

### Il disco fisso

Venti mega, che nel 1988 erano tanti. La geometria è quella di un **Seagate
ST-225** — 615 cilindri, 4 testine, 17 settori — e la scheda è una **XT-CF**
all'indirizzo 300h: un adattatore fra il bus a otto bit e una scheda
CompactFlash, che elettricamente è un disco IDE.

Un BIOS XT non sa cosa sia un disco fisso: chi lo sa è la scheda, che se lo
porta dietro in una ROM di dodici KB a `C800`. Il POST passa in rassegna la
finestra delle schede a passi di due KB, trova la firma `55 AA`, controlla la
somma e salta dentro; da lì in poi l'INT 13h dei dischi fissi è roba della
scheda. La ROM è la [XTIDE Universal
BIOS](https://www.xtideuniversalbios.org/), GPLv2, e la scarica
`npm run fetch-roms`.

**Il disco arriva già pronto**: `roms/pc/hdd.img` è nel repository, la macchina
lo trova acceso e si avvia su `C:\>` senza dischetto — che è come si accendeva
un PC dal 1988 in poi, e come si accende questo sia in locale sia sulla pagina
pubblica.

Preparato però non da noi. Il disco si rifà con:

```sh
npm run make-hdd
```

che ci mette venti secondi e **non scrive un byte di filesystem**. Accende la
macchina emulata con il dischetto di FreeDOS dentro e ci batte sopra i comandi
che ci si batteva allora, uno per uno: `FDISK /AUTO` per la partizione,
`FDISK /MBR` per il codice che ci sta davanti, un riavvio perché il DOS se ne
accorga, `FORMAT C:`, `SYS C:`, e poi la copia dei programmi. La tabella delle
partizioni e la FAT le scrivono FDISK e FORMAT veri, girando sul 286: è l'unico
modo di essere sicuri che siano giuste. Le sole eccezioni sono i tre file della
tastiera — KEYB, KEYBOARD.SYS e KB16 — che non stanno su nessun dischetto e
batterli un byte per volta vorrebbe dire un'ora: lo script li scrive da sé con
`fat.js`, a DOS fermo, e poi riaccende la macchina, così la FAT il DOS se la
rilegge da capo. Ognuno porta la data che ha nel suo pacchetto, e il disco
rifatto resta identico byte per byte. L'immagine che sta nel repository è
uscita da lì, ed è verificabile: rifalla e viene **identica byte per byte** —
una macchina emulata non ha niente di casuale dentro, e un XT non ha nemmeno
un orologio da cui prendere l'ora.

Venti mega, di cui scritti settecento KB: il resto sono zeri, e git se li
comprime in quattrocento e rotti KB. Chi apre la pagina però se li scarica tutti
e venti, perché un `.img` non si comprime per strada.

Chi il pomeriggio del 1988 se lo vuole passare davvero può togliere il file:
senza `hdd.img` la macchina monta un disco **vuoto**, venti mega di zeri come si
comprava, da partizionare e formattare a mano. **Salva il disco fisso** riporta
via come file quello che c'è dentro adesso, e ritrascinandolo lo si rimette.

#### Cambiare il disco

Un'immagine di disco fisso si trascina sulla finestra come un dischetto, e va
nella scheda al posto di quella che c'era. Fra i due gesti però ci sono tre
differenze, e sono tutte e tre nel disco e non nel codice:

- **la misura**. Un dischetto è grande una delle sette misure che esistono, e si
  riconosce da quella; un disco è grande quanto è. Quello che entra ci entra
  intero — un'immagine da quaranta mega resta da quaranta mega — perché
  tagliarla per farla stare nei venti di prima vuol dire consegnare al DOS una
  FAT che punta a settori che non ci sono.
- **la geometria**. Un'immagine non dice da quanti cilindri e quante testine
  veniva, e sbagliare quel numero non dà un errore: dà un disco illeggibile, con
  la partizione al posto giusto e i settori chiesti nei posti sbagliati. Però la
  geometria è scritta dentro, di riflesso: ogni voce della tabella delle
  partizioni dice dove finisce **in due modi**, per numero progressivo di settore
  e per cilindro/testina/settore, e c'è una geometria sola che fa tornare i due
  conti — le testine sono quella dell'ultimo settore più una, i settori per
  traccia sono il numero dell'ultimo settore. È lo stesso conto che faceva ogni
  sistema operativo trovandosi un disco preparato su un'altra macchina. Se la
  tabella non c'è, o se non torna, si ricade sulle traduzioni che i BIOS
  tenevano in tabella, scegliendo la prima che faccia stare il disco nei 1024
  cilindri che il DOS sa contare.
- **l'accensione**. La geometria se l'è segnata il BIOS della scheda, e l'ha
  chiesta al POST: finché la macchina non riparte, il DOS continua a chiedere i
  settori del disco di prima. Quindi il disco nuovo si monta e la macchina si
  riaccende da sola — che è esattamente quello che si faceva a mano, spegnendo
  per cambiare la scheda CompactFlash.

E il disco che esce, se era stato scritto e non salvato, torna indietro come file
prima di uscire: nella scheda del browser non c'è nessun cassetto in cui posarlo.

La prova, in `pctest.mjs`, prende il disco del repository e lo mette in testa a
un'immagine da quaranta mega, come se fosse stata preparata su una macchina più
ricca: la scheda dice «alloldos XT-CF 40 MB», la geometria letta dalla tabella è
ancora 4 testine e 17 settori su 1204 cilindri, FreeDOS arriva a `C:\>` e vede
la sua partizione da venti mega con venti mega di spazio libero dietro.

### La tastiera

Una tastiera italiana e una americana sono lo stesso pezzo di ferro con dei
disegni diversi sopra: il tasto accanto alla P manda lo stesso numero, e
sull'una c'è stampata una «è», sull'altra una parentesi quadra. La macchina
riceve le **posizioni** dei tasti — il browser le dà a parte dai caratteri — e a
decidere che lettera sono è il DOS, che da solo parla americano.

La tendina **Tastiera** nella barra fa quello che si faceva allora: scrive
`keyb it` (o `gr`, `fr`, `uk`…) nell'`AUTOEXEC.BAT` del disco fisso, e
riaccende. KEYB è quello di FreeDOS, con le sue tastiere, e sta sul disco
insieme agli altri comandi. Le tastiere sono quattordici — americana, italiana,
inglese, tedesca, francese, spagnola, le due svizzere, belga, olandese, svedese,
finlandese, latinoamericana, brasiliana — cioè quelle che vanno d'accordo con la
codepage 437, le lettere che la CGA ha nella ROM. La scelta resta nel browser e
vale anche alla prossima visita; un disco trascinato da fuori tiene invece la
tastiera che ha, e la tendina dice quale. Il tasto in più delle tastiere
europee, quello con `<` e `>` accanto allo shift, arriva anche lui, e l'Alt di
destra arriva come **AltGr** — su Windows, senza il Ctrl finto che il sistema
gli manda davanti.

Sul 286 KEYB da solo non basta, e il perché sta nel BIOS. KEYB conta su due cose
che i BIOS AT del 1986 hanno e i BIOS XT no:

- l'**INT 16h con AH=05h**, «scrivi nel buffer della tastiera», con cui consegna
  ogni lettera che traduce. Senza, le lettere tradotte spariscono e le altre
  passano — un guasto che non dà nessun errore;
- l'**Alt di destra distinto da quello di sinistra**. L'AltGr arriva con il
  prefisso E0h, e un BIOS AT se ne accorge; GLaBIOS no, e per lui ogni Alt è
  quello di sinistra — KEYB guarda, vede un Alt normale, e la chiocciola non
  esce.

Allora si faceva così: un programmino residente che aggiunge quello che manca.
È `KB16.COM`, 212 byte scritti a mano in `scripts/kb16.mjs`, istruzione per
istruzione e solo con quelle dell'8086. Va nell'`AUTOEXEC.BAT` subito dopo
KEYB, perché deve vedere i tasti prima di lui; e se il BIOS la funzione 5 ce
l'ha già — il Pentium, che avvia lo stesso disco con SeaBIOS — se ne accorge e
se ne va senza restare in memoria. Aggiornare GLaBIOS non sarebbe bastato: la
0.8, ancora in prova, ha il supporto esteso, ma per farlo stare negli otto KB
della ROM toglie la ricerca delle ROM delle schede, cioè il disco fisso.

La prova, in `pctest.mjs` e in `pentiumtest.mjs`, sceglie l'italiana, accende,
e preme i tasti per posizione come li manda il browser: escono è ò à ù é, la
barra rovescia, l'apostrofo e il minore, e con AltGr le quadre, la chiocciola e
il cancelletto — sulle due macchine, dallo stesso disco.

### Portare dentro un file

Fra il computer di oggi e quello del 1988 non c'è nessun cavo. La macchina
emulata sa leggere settori da un disco, e basta: un file che arriva dal browser
non ha nessuna porta da cui entrare.

**Carica un file** — o il trascinamento sulla finestra, che è la stessa cosa —
lo mette dove il DOS lo troverà da sé: in `C:\SCARICATI` sul disco fisso, che è
la cartella che si sarebbe fatto chiunque avesse avuto un modem. Il nome si
accorcia a come lo vuole il DOS, otto più tre: `relazione finale.txt` diventa
`RELAZION.TXT`, esattamente come sarebbe successo allora copiandolo da un
dischetto formattato altrove.

**Se è uno zip, si svuota.** Nel 1989 arriva PKZIP, e per dieci anni è il modo
in cui il software viaggia: trovarsi l'archivio sul disco senza niente con cui
aprirlo sarebbe una beffa. `giochi vari.zip` finisce aperto in
`C:\SCARICATI\GIOCHIVA\`, con dentro le sue cartelle e i nomi accorciati; due
nomi lunghi diversi che si accorciano uguale non si mangiano, il secondo si
numera — `MANUAL~1.TXT` — come farà Windows dieci anni dopo per la stessa
ragione. La scompattazione la fa il browser: deflate è quello di gzip e delle
pagine web, e `DecompressionStream` ce l'ha già dentro. Nessuna libreria.

Poi la macchina **si riaccende**. Non è una scortesia dell'emulatore: il DOS si
tiene in memoria pezzi di FAT e di cartella, e uno che gli cambia il disco sotto
mentre gira è quello che i manuali dell'epoca dicevano di non fare mai.

E il disco è cambiato: **va salvato**, o chiudendo la scheda se ne va — la
pagina lo chiede prima di lasciar chiudere.

#### La regola che qui si rompe

Il disco fisso di alloldos è fatto quasi senza scrivere un byte di filesystem:
la tabella delle partizioni e la FAT le hanno scritte FDISK e FORMAT veri,
girando sul 286, e i soli file messi da noi sono i tre della tastiera. Qui
quella regola si rompe del tutto, perché non c'è alternativa: far fare il
lavoro al DOS vorrebbe dire battergli il file sulla tastiera un byte per volta
con DEBUG, che per un dischetto di roba vuol dire una giornata. La FAT la
scriviamo noi, in `fat.js`.

Ma il giudice resta FreeDOS. La prova scrive a macchina spenta, l'accende, e poi
non tocca più niente: è il DOS a fare `DIR`, a fare `TYPE`, a caricare e far
girare un programma uscito da uno zip, a scriverci accanto un file suo, e alla
fine a cancellare tutto quanto con `DELTREE`. Se il disco torna libero degli
stessi byte che aveva prima, ogni catena e ogni voce di cartella era al suo
posto — e a dirlo è lui, non noi.

### La VGA

Una VGA su una scheda XT non è un controsenso: nel 1988 le schede erano tutte
ISA a otto bit, e una VGA si infilava in un XT come in qualunque altra cosa. È
la stessa scheda del Pentium (`pentium/vga.js`), sul bus a otto bit invece che
a sedici. Con la VGA gli interruttori del video vanno a 00 — «c'è una scheda con
il suo BIOS, chiedi a lei» — e GLaBIOS cerca una ROM fra C000 e C800, la esegue
e le lascia l'INT 10h; poi le chiede chi è, con l'INT 10h/1Ah, e sullo schermo
del POST scrive quello che la scheda risponde.

Il BIOS della scheda è il **VGABIOS LGPL**, lo stesso del 386 — ma non lo stesso
file. Quello che il progetto pubblica, e quello che sta dentro Bochs dal 2008 in
poi, è compilato per il 386. Il sorgente è scritto per l'8086, e il Makefile lo
dice dappertutto; ma il compilatore, bcc, mette in testa al codice `use16 386`,
e da lì l'assemblatore si sente libero di usare i **salti condizionati lunghi**,
che sono arrivati col 386. Sono una sessantina, e il 286 si ferma al primo, a
`C000:70AA`, con un'interruzione 6 dopo l'altra: schermo nero. Tutte le versioni
pubblicate, dalla 0.6b alla 0.8a, si fermano sullo stesso salto.

`npm run build-vgabios` lo ricompila dallo stesso sorgente dicendo
all'assemblatore la verità — il processore è un 286 — e ogni salto lungo diventa
un salto corto rovesciato che ne scavalca uno lungo, com'erano fatti prima del
386. Le istruzioni a trentadue bit scritte a mano sono poche e stanno in due
posti: il salvataggio dello stato video, dove due `mov eax`/`stosd` diventano
parole da sedici bit, e il codice che parla col bus PCI e con le estensioni VBE,
che su una scheda ISA non c'entra e resta fuori. Quello che esce sono
trentadue KB, da C000 a C7FF — la ROM della scheda del disco resta a C800 —
identici a ogni compilazione, e viaggiano col repository perché non c'è nessun
altro posto da cui prenderli. La prova li accende contando le interruzioni 6:
zero.

I programmi scritti per la CGA la VGA li fa girare con gli indirizzi di quella:
nei modi 4 e 6 il registro 17h del CRTC fa del contatore dei righi il
tredicesimo bit di indirizzo, e le righe dispari stanno otto KB più in là delle
pari, com'erano sulla CGA. Nel modo 4 i due bit di ogni punto stanno in byte
pari e dispari su due piani diversi, e la scheda li rimette in fila. La prova
accende i due modi dal BIOS della scheda e guarda i punti delle prime due righe.

Senza `vgabios.bin` la macchina monta la CGA, com'era un XT prima del 1987. Il
BIOS della VGA si trascina sulla finestra come le altre ROM; quello per il 386
si riconosce dalla firma e viene rifiutato, invece di lasciare la macchina ferma.

La prova, in `pctest.mjs`, accende la macchina con la VGA fino a `C:\>` e poi fa
girare un programma DOS che chiede al BIOS della scheda il **modo 13h** — 320
per 200 a 256 colori, quello dei giochi — ci accende il primo punto bianco e
l'ultimo della riga rosso, aspetta un tasto e torna al testo. Per il modo 13h
la VGA del Pentium diceva 640 per 400: i punti a otto bit sono due battiti del
pennello, e ogni riga si disegna due volte. Adesso lo sa, e lo sa anche per il
Pentium e il 386.

### La Sound Blaster

Una **Sound Blaster 2.0** a 220h, IRQ 7, DMA 1: i ponticelli con cui usciva
dalla scatola, e quelli che dice la riga `SET BLASTER=A220 I7 D1 T3` che
`make-hdd` scrive nell'`AUTOEXEC.BAT`, come faceva il programma di
installazione della scheda. Non ha una ROM, e quindi c'è sempre: il BIOS non la
vede, e i programmi la vanno a cercare da soli.

Dentro sono due schede in una:

- l'**OPL2** (`opl2.js`), cioè lo Yamaha YM3812 della AdLib, alle porte della
  AdLib (388h) e alle sue (228h). Nove voci da due operatori, la **modulazione
  di frequenza**, le quattro forme d'onda, gli inviluppi, il tremolo e il
  vibrato, la batteria con il suo rumore, e i due contatori con cui ogni gioco
  scopriva se la scheda c'era. Le ampiezze stanno in logaritmo come nel chip,
  con le sue due tabelle — un quarto di sinusoide e un esponenziale — e il chip
  calcola 49 716 campioni al secondo, qui come allora;
- il **DSP** (`soundblaster.js`), il microcontrollore che la AdLib non aveva: il
  reset che risponde AAh, la versione 2.01, il convertitore pilotato a mano, e
  soprattutto i blocchi portati dal **canale 1 del DMA** — uno per volta o uno
  dietro l'altro — con la IRQ 7 alla fine di ognuno. Ci sono anche l'alta
  velocità, la registrazione, che registra silenzio perché un microfono non c'è,
  i blocchi di silenzio, e l'**ADPCM** di Creative: quattro, tre o due bit per
  campione invece di otto, con un passo che si allarga quando il suono cambia
  in fretta e si stringe quando sta fermo. Le tabelle sono quelle del DSP; sul
  dischetto di un gioco del 1991 erano la differenza fra avere le voci e non
  averle.

Il suono esce in campioni, alla velocità che vuole il browser, dallo stesso
worklet dello Spectrum. Nello stesso suono entra l'**altoparlante del PC**, e non
più come un oscillatore che segue il contatore: si segue il filo, il bit dei
dati della porta 61h in AND con l'uscita del contatore 2, intervallo per
intervallo. È così che si sentono anche i programmi che il bit lo muovono a mano
— le voci fatte con un bit solo, che l'oscillatore non poteva fare.

La prova, in `pctest.mjs`, guida la scheda dalle porte — il reset, la AdLib
trovata, un La a 440 Hz che si spegne quando si lascia il tasto, un blocco col
DMA che finisce con la sua interruzione, i blocchi in fila fermati da DAh — e
poi fa girare sotto DOS un programma di 493 byte che fa quello che fa ogni
gioco: mette il suo gestore sulla IRQ 7 e la apre sul PIC, riavvia il DSP,
programma il DMA sul suo buffer, fa suonare 256 byte e aspetta l'interruzione.
Scrive `SB OK`.

### Cosa c'è dentro

- l'**80286** in modo reale (`cpu286.js`), con i dettagli da cui un programma
  capisce di non essere su un 8086;
- la **mappa di memoria** del PC: 640 KB in fondo, le schede da A0000 a EFFFF,
  il BIOS negli ultimi otto KB;
- l'**8259**, i tre contatori dell'**8253**, l'**8255** con gli interruttori a
  slitta, l'**8237** del DMA con i registri di pagina e la giunzione a 64 KB che
  non riporta;
- il **765** e il suo lettore, la scheda **XT-CF** con il disco ATA;
- la **tastiera XT** con il filo di clock, dove tenerlo a terra un attimo vuol
  dire «ho preso il byte» e tenerlo venti millesimi vuol dire «riavviati»;
- la **VGA** con il suo BIOS, e la **CGA** quando il BIOS della VGA non c'è:
  testo a ottanta colonne con il disegno delle lettere preso dalla ROM del
  BIOS, cursore che lampeggia, e le due grafiche — 320×200 a quattro colori e
  640×200 in bianco e nero;
- la **Sound Blaster 2.0**: l'OPL2 e il DSP con il suo DMA, la sua IRQ e
  l'ADPCM;
- l'**altoparlante**: un bit e un contatore, che è tutto il suono che il PC ha
  avuto per dieci anni — seguito campione per campione;
- una **FAT16** che sa scrivere (`fat.js`) e un lettore di **zip** (`zip.js`),
  che è il solo modo che un file di oggi ha di entrare in un disco del 1988.

Manca la **MIDI** della Sound Blaster. Non per pigrizia: sulla scheda è una
porta seriale che manda le note a un sintetizzatore esterno, e per sentirla
servirebbe il sintetizzatore — uno strumento General MIDI intero, con i suoi
centoventotto strumenti campionati, che è un altro progetto. I comandi MIDI il
DSP li ascolta e non ne fa niente, come una scheda senza niente attaccato. E
manca il modo protetto, che il DOS non usa.

### Le tre cose che solo un BIOS vero ha trovato

Tutte le prove sintetiche passavano già:

- un **caricamento a un byte solo in un contatore del PIT azzera l'altra metà**;
  senza, il divisore del rinfresco della memoria si teneva una metà alta vecchia
  e girava mille volte più lento;
- il **rinvio dopo una `STI` deve scadere mentre il processore è fermo**, o
  `sti` seguito da `hlt` non si sveglia più — ed è esattamente come il BIOS
  aspetta il disco;
- la **tastiera si riavviava a ogni tasto**, perché confondeva i due usi del
  filo di clock. Siccome `AA` è anche il codice con cui si lascia andare lo
  shift sinistro, chi scriveva i due punti otteneva un punto e virgola.

### Le prove

`scripts/pctest.mjs`: prima il processore un'opcode per volta, poi i chip uno
per uno, poi la macchina intera. Le ultime quattro sezioni sono quelle che
contano — il POST di GLaBIOS, FreeDOS che parte dal dischetto e ci scrive sopra
un file, FreeDOS che parte dal disco fisso, ci scrive, e ritrova quello che ha
scritto dopo un riavvio, e FreeDOS che si ritrova sul disco una cartella scritta
da noi e ci fa dentro tutto quello che ci farebbe con una sua. I comandi vengono
battuti sulla tastiera attraverso lo stesso codice che usa il browser. In fondo,
la macchina si riaccende con la VGA e fa girare due programmi DOS messi sul
disco: uno chiede il modo 13h al BIOS della scheda, l'altro fa suonare un blocco
alla Sound Blaster e aspetta la sua interruzione.

## ZX Spectrum 48K

Uno Z80 a 3,5 MHz, sedici KB di ROM, quarantotto di RAM, e un solo chip fatto
fare apposta: la **ULA**, che fa il video, la tastiera, l'altoparlante, il
nastro e il bordo. Non c'è nient'altro dentro — nessun chip sonoro, nessuno
sprite, nessun controllore di interruzioni — e tutto quello che lo Spectrum fa
di bello lo fa il processore a mano, contando cicli.

La macchina si accende sul suo BASIC, e da lì si scrive come si scriveva:

```
PRINT 355/113
3.1415929
```

Quel numero non è un dettaglio da poco: lo calcola l'aritmetica in virgola
mobile a cinque byte che sta nella ROM, ed è il pezzo di codice più esigente
della macchina. Farlo tornare vuol dire aver preso bene mezzo processore.

### Lo schermo

256×192 pixel, e il modo in cui stanno in memoria è la cosa che tutti ricordano:
i righi non sono uno sotto l'altro. L'indirizzo si compone dai bit del rigo
rimescolati — due di terzo, tre di rigo dentro il carattere, tre di rigo di
caratteri — perché così l'incremento del contatore video costava meno porte
logiche. Il rigo 1 non sta sotto il rigo 0: sta 2048 byte più in là.

I colori sono altrove e sono pochi: 768 byte di attributi, uno per ogni
quadretto di otto per otto, con dentro due colori. Due colori per quadretto è la
ragione di tutte le macchie che hanno i giochi dello Spectrum quando due cose si
sovrappongono — il famoso *attribute clash*, che nessuno ha mai chiamato così
mentre ci giocava.

Il **bordo** invece cambia colore a metà quadro, e qui cambia davvero: i cambi
vengono registrati con il ciclo in cui sono avvenuti, ed è per quello che si
vedono le bande dei caricamenti.

### La tastiera

Quaranta tasti, e tutto il resto sono combinazioni. Il *symbol shift* (il tasto
rosso) dà i simboli, il *caps shift* dà maiuscole, frecce e DELETE — ed è per
questo che sulla tastiera dello Spectrum le frecce sono disegnate sui tasti 5,
6, 7 e 8. Qui i tasti del browser diventano le combinazioni giuste da soli: la
virgola è symbol shift più N, Backspace è caps shift più 0. Chi vuole i due
tasti veri ha **Maiusc** e **Ctrl**.

Ogni tasto ha cinque parole scritte sopra perché ogni comando del BASIC si batte
con una pressione sola: `P` è `PRINT`, `J` è `LOAD`. Chi ha imparato a
programmare su questa macchina non ha mai scritto per esteso la parola PRINT.

### Le cassette (`.tap`)

Un `.tap` non contiene il suono: contiene i byte. Quindi il suono viene
**rifatto** con i tempi esatti della ROM — tono di guida a 2168 cicli, due
impulsi di sincronismo, 855 cicli per uno zero e 1710 per un uno — e la ROM li
va a rimisurare contando cicli, come faceva con la cassetta vera. Nessuno qui
legge i byte del nastro: li legge lo Spectrum.

Trascinare un `.tap` sulla finestra accende la macchina, le fa battere
`LOAD ""` da sola e preme play. Mentre il nastro corre la macchina va a
ventiquattro quadri per volta: quattro minuti di caricamento erano il prezzo del
1982, ma non c'è ragione di rifarli pagare.

Ci sono anche le istantanee **`.sna`**, che non sono un programma ma una
macchina fotografata a metà lavoro: si rimette tutto dov'era e si riparte
dall'istruzione dopo. **Salva .sna** fa il contrario.

### Il suono e il joystick

L'altoparlante è **un bit**. Il suono qui è la storia di quel bit dentro il
quadro — presa così com'è, mediata sull'intervallo di ogni campione e mandata
alla scheda audio — e quindi funziona anche per chi quel bit lo muoveva a mano
per tirarci fuori più voci o un campionamento.

Il **joystick Kempston** va chiesto con il pulsante, perché i tasti che vuole
sono già tasti della macchina.

### Cosa manca

La **contesa della memoria** (sullo Spectrum la ULA e il processore si
contendono i primi 16 KB, e il processore aspetta), i `.tzx` e con loro i
caricatori turbo, il 128K con il suo chip sonoro AY, e la registrazione su
nastro: qui le cassette si leggono e non si scrivono.

## PC Pentium

La macchina del 1995, e la seconda di questa collezione che gira su **firmware
libero fino in fondo**. Si accende dal menu di boot come le altre: il POST arriva
in fondo e sopra ci si avvia FreeDOS, dal disco fisso o dal dischetto, fino al
prompt. La pagina è la stessa del 386 — la scheda madre è la stessa — con la
tastiera, il mouse PS/2, la Sound Blaster, i dischi da trascinare e la tendina
delle tastiere.

Fra lei e il 286 di sopra ci sono sette anni e due cose che cambiano tutto:

- **la misura.** Registri e indirizzi lunghi trentadue bit, e la fine del
  mestiere di spezzare la memoria in blocchi da 64 KB. Trentadue mega invece di
  uno, indirizzati tutti di seguito.
- **il processore che si difende.** C'è un modo protetto vero, con una tabella di
  descrittori che dice dove comincia e dove finisce ogni segmento e chi ha il
  diritto di toccarlo, e c'è la **paginazione**, che mette fra l'indirizzo che il
  programma scrive e il byte che esiste una traduzione fatta a tabelle. Da lì
  viene tutto quello che un sistema operativo moderno sa fare: la memoria
  virtuale, i processi che non si pestano, il file che si comporta come se fosse
  in memoria.

### Il firmware, che di nuovo è libero

Per una macchina del 1995 GLaBIOS non basta — è un BIOS XT, e qui ci vogliono il
PCI, il modo protetto, i dischi grandi — ma il firmware libero che lo fa esiste:
**SeaBIOS**, LGPLv3, scritto da zero, ed è quello che accende ogni macchina
virtuale di QEMU da quindici anni. Con dentro la sua **SeaVGABIOS**, che è la ROM
della scheda video: un pezzo a parte, perché su una macchina vera stava in una
ROM sulla scheda.

Il progetto pubblica i sorgenti e non i binari; i binari compilati stanno nel
repository di QEMU, che se li porta dietro, e da lì si prendono con due link
diretti: [`bios.bin`](https://raw.githubusercontent.com/qemu/qemu/v9.0.0/pc-bios/bios.bin),
centoventotto KB, e [`vgabios.bin`](https://raw.githubusercontent.com/qemu/qemu/v9.0.0/pc-bios/vgabios.bin),
la variante ISA. Sempre la versione 9.0.0 — SeaBIOS 1.16.3 — e
`npm run fetch-roms` li mette in `roms/pentium/`.

### Due chip invece di venti

Su una scheda madre del 1995 i chip logici non si vedono più: ce ne sono due, e
dentro ci sono tutti quelli di prima.

Il **ponte nord** — un Intel 82441FX, il "Natoma" — sta fra il processore, la
memoria e il bus PCI, e decide chi risponde a ogni indirizzo. La cosa più
interessante che fa sono i **PAM**: sette byte nello spazio di configurazione che
decidono, per ogni pezzo da sedici KB fra C0000 e FFFFF, se lì risponda la ROM o
la RAM. È il pezzo di silicio che permette a un BIOS di copiare sé stesso in
memoria e poi continuare a eseguirsi da lì — la ROM è lenta, la RAM no — e da
quello "shadowing" veniva buona parte della differenza di velocità fra due PC
identici. È anche la prima cosa che SeaBIOS va a cercare all'accensione, e senza
non parte.

Il **ponte sud** — un PIIX3 — è letteralmente un PC del 1984 dentro un chip: le
due catene di interruzioni, i tre contatori, il DMA, l'orologio, i dischi IDE. Con
gli stessi indirizzi di sempre: l'8259 risponde ancora alla porta 20h e il
contatore ancora alla 40h, nel 1995 come nel 1981. Il PC non ha mai buttato
niente.

Sopra c'è un **bus PCI**, che è il momento in cui le schede smettono di essere
ponticelli: ogni scheda ha duecentocinquantasei byte in cui dichiara chi è e
quali finestre di indirizzi vorrebbe, e il firmware le trova chiedendo invece di
saperlo. Ci si arriva da due porte, CF8h e CFCh, che sono l'ultima cosa in tutto
il PCI a essere ancora fatta come nel 1981.

### Come una macchina emulata si presenta

C'è un pezzo di questa macchina che non esisteva nel 1995, e vale la pena dire
perché c'è. Su un PC vero il BIOS e la scheda madre sono la stessa cosa: chi ha
scritto il firmware sapeva quanti banchi di memoria c'erano e dove. Su una
macchina emulata no — il firmware è uno e le macchine sono mille — e allora serve
un posto dove l'una possa raccontarsi all'altro. In QEMU quel posto si chiama
**fw_cfg**, e sono due porte: nella 510h si scrive cosa si vuole sapere, dalla
511h si leggono i byte della risposta.

La prima voce è una parola d'ordine, `QEMU`, e senza quella il firmware lascia
perdere il canale. Dirla non è una bugia: questa macchina non finge di essere
QEMU, si presenta per quello che è — una macchina emulata che parla il protocollo
che quel firmware conosce. Lo stesso vale per i due numeri di sottosistema del
ponte nord, `1af4:1100`: sono la riga in cui la scheda madre dichiara di non
essere una scheda madre vera.

Da quel canale passa anche la ROM della scheda video, che su questa macchina non
sta dentro una scheda: la scheda madre la passa al BIOS come un file di nome
`vgaroms/vgabios.bin`, il BIOS la copia a C0000 e la esegue. È esattamente quello
che fa QEMU con una VGA ISA.

### La VGA

L'ultima scheda video che tutti hanno avuto uguale. Dal 1987 al 1995 ogni PC ne
ha avuta una, e ogni scheda uscita dopo comincia comportandosi come questa,
perché è così che si accende il DOS.

La parte strana è la memoria. La VGA ha 256 KB ma la finestra che il processore
vede è di 64, perché la memoria è divisa in **quattro piani paralleli**: a ogni
indirizzo ci sono quattro byte, uno per piano, e ogni piano tiene un bit del
colore di ogni punto. Un byte scritto una volta accende otto punti. È il modo con
cui una scheda del 1987 riusciva a riempire uno schermo a sedici colori con un
bus a sedici bit — e il motivo per cui i giochi in modo 12h erano così difficili
da scrivere. Fra il processore e i piani c'è una macchineria di maschere, latch e
funzioni logiche con quattro modi di scrittura, e c'è tutta.

Il modo testo usa la stessa memoria in un modo diverso ancora: il piano 0 tiene i
caratteri, il piano 1 gli attributi, e il piano 2 il **disegno delle lettere** —
che quindi non è in una ROM ma in RAM, ed è per questo che sul DOS si potevano
ridefinire i caratteri.

### I dischi

Il nome lo dice tutto: **IDE**, *Integrated Drive Electronics*. Prima, su un PC,
il controllore era una scheda e il disco era un motore con dei piatti: la scheda
sapeva com'erano fatti i piatti, e cambiare disco voleva dire cambiare scheda.
Nel 1986 a qualcuno viene in mente di prendere la scheda e avvitarla *sopra* il
disco, lasciando sul bus solo i registri. Da quel momento il disco è una scatola
nera che parla un protocollo, e la "scheda" sulla scheda madre non deve sapere
niente di niente — nel 1995 non è più una scheda, è mezzo chip del ponte sud.

È lo stesso protocollo della scheda XT-CF del 286 di sopra, perché è lo stesso
protocollo: cinque registri per dire quanti settori e dove, uno per il comando, e
i byte che passano dalla porta dei dati mentre il bit DRQ è alto. Le differenze
sono due, e sono quelle che fanno di questa la macchina di dieci anni dopo:

- **i dati passano a sedici bit.** Sul bus a otto bit dell'XT il disco parlava un
  byte per volta; qui la porta dei dati è larga una parola, e un settore sono 256
  letture invece di 512. È l'unica porta di tutta la macchina che è larga davvero:
  tutte le altre, a leggerle a sedici bit, si leggono due volte a otto;
- **c'è l'indirizzamento lineare.** Cilindro/testina/settore nel 1986
  corrispondeva ancora a com'erano fatti i piatti, nel 1995 non più: i dischi
  hanno tracce con un numero variabile di settori, e la geometria che raccontano è
  una bugia gentile. L'LBA — il settore contato dall'inizio — è la verità, e a
  tradurre fra le due è il disco, che è tutto il punto dell'IDE.

Il resto è il pezzo di architettura più longevo che il PC abbia: le porte 1F0h e
170h, i due canali con due dischi ciascuno, il "master" e lo "slave" scelti da un
bit. I due dischi di un canale non sono due dispositivi su un bus: condividono i
registri, e risponde quello selezionato. È per questo che su un cavo IDE il disco
lento rallentava anche quello veloce. Trent'anni e tre generazioni di cavi dopo,
un disco SATA si presenta ancora con IDENTIFY DEVICE.

Accanto c'è il **lettore di dischetti**, ed è lo stesso NEC 765 del 286 — stesso
chip, stesso codice, stesso DMA: nel 1995 è ancora quello, dentro il ponte sud
invece che su una scheda. Le due schede si dividono perfino un indirizzo: la
porta 3F7h ha il bit 7 del lettore di dischetti e gli altri sette del disco fisso,
che è il genere di cosa che succede quando gli indirizzi finiscono.

Una cosa che il firmware vero insegna e i manuali dicono a mezza voce: il byte
del setup che dice **che lettore è montato** conta più del dischetto che c'è
dentro. Un lettore da 1,44 e un dischetto da 720 KB hanno geometrie diverse, e se
il byte dice la prima mentre dentro c'è il secondo il settore di avvio si legge —
è il primo della prima traccia, e lì le due geometrie coincidono — e tutto il
resto no. Quindi questa macchina dichiara il lettore che serve al dischetto che
c'è, e quando non c'è nessun dischetto dichiara di non avere il lettore: che è
vero, e che risparmia al firmware cinque secondi passati a interrogare un lettore
vuoto.

### Dove si è arrivati

`npm test` accende la macchina con SeaBIOS dentro e guarda cosa succede. Il
firmware, che di questo emulatore non sa niente:

- si racconta dalla porta di servizio (`SeaBIOS (version 1.16.2-debian…)`), che è
  una porta che gli emulatori mettono a disposizione e che lui usa se la trova;
- passa al modo protetto, trova il ponte nord sul PCI, apre i PAM, **si copia in
  RAM e continua a girare da lì**, e poi richiude la porta dietro di sé perché
  nessuno ci scriva sopra;
- legge dall'orologio quanta memoria c'è e si sposta in cima ai trentadue mega;
- si fa passare la ROM della scheda video dal canale di configurazione, la
  esegue, e quella mette la VGA nel modo testo a 80 colonne — e da quel momento
  c'è uno schermo su cui leggere;
- ci scrive chi ha acceso la macchina, e poi prova ad avviare qualcosa.

E lì trova qualcosa. Legge il primo settore del disco IDE, ci salta dentro, e da
quel momento non è più lui a guidare: è **FreeDOS**, che carica il suo kernel un
settore per volta attraverso gli stessi registri e arriva al suo prompt. Da lì la
prova è quella di una macchina: si batte `dir c:\` sulla tastiera — che vuol dire
un codice per volta dall'8042, con la sua interruzione ogni volta — si scrive un
file, si spegne e si riaccende, e il file è ancora dov'era.

Il disco è **lo stesso file** che il 286 di sopra avvia dalla sua scheda XT-CF.
Che la stessa immagine si accenda su due macchine con dieci anni, due processori
e due controllori diversi in mezzo non è un caso: è quello che vuol dire che un
disco è un disco.

E l'altra strada: senza disco fisso e con un dischetto nel lettore, il firmware
prova prima quello — come si accendeva un PC, che chi voleva partire da un altro
sistema lo infilava in A: — e il kernel di FreeDOS si carica da lì, novanta
settori su cinque tracce con due cambi di testina, portati dal NEC 765 attraverso
il DMA.

Una cosa che solo il firmware vero ha trovato: **`mov %ss,%edi` con gli operandi a
trentadue bit azzera i sedici bit alti**. Sul 386 erano indefiniti, dal Pentium
sono zero, e il software ci conta — il modo in cui si passa da uno stack a
segmenti a uno stack piatto è esattamente `mov %ss,%edi`, `shl $4,%edi`,
`add %edi,%esp`. Con i sedici bit alti sporchi lo stack finisce a quattro giga da
dove doveva, e la macchina muore mezzo secondo dopo in un posto che non ha niente
a che fare con l'errore.

### Cosa manca

La **velocità**: la macchina gira, ma gira a una frazione dei sessantasei
megahertz che dichiara, e per farci sopra qualcosa di più di un prompt del DOS
quella frazione andrà alzata. La virgola mobile, il cambio di task e il modo
virtuale 8086 invece ci sono: sono gli stessi del 386 qui sotto, perché il
motore è lo stesso, e sono raccontati lì — e sul Pentium CPUID dichiara il
coprocessore, che per la prima volta sta dentro il processore.

## PC 386

La macchina del 1990, e la prima di questa collezione con il modo protetto in
mano al software che ci gira sopra: è il processore su cui è nato Windows 3.1, e
su cui i DOS extender hanno cominciato a usare la memoria sopra il primo mega.
Un **386DX a 33 MHz**, **otto mega** di memoria, una **VGA**, un **mouse PS/2**,
un lettore da 1,44 e un disco IDE — che è lo stesso file con FreeDOS del 286.

La scheda è quella del Pentium di sopra, e non è un modo di dire: è lo stesso
codice, con un altro processore e un altro BIOS. Un anacronismo, dichiarato — un
386 non ha mai visto un i440FX — ma innocuo, perché i chip che il DOS tocca sono
gli stessi dal 1984, con gli stessi indirizzi.

### Un 386 è un Pentium a cui manca qualcosa

Il processore è lo stesso motore del Pentium, che sa fare anche i due di prima
spegnendo quello che non avevano. Un 386 non è un Pentium lento: è un Pentium
che **non risponde a CPUID** — sul 386 è un opcode non valido, e parte
l'eccezione 6 — e che non ha le istruzioni arrivate dopo: BSWAP, CMPXCHG e XADD
del 486, RDTSC e CMPXCHG8B del Pentium. In EFLAGS il bit AC ricade quando lo si
accende, che è il test con cui tutti, Windows compreso, distinguevano un 386 da
un 486; e in CR0 all'accensione non ci sono i bit della cache, che il 386 non
aveva.

Per il 386 il motore ha imparato anche quello che mancava al Pentium: il
**cambio di anello**. Un programma all'anello 3 che chiama il sistema — con
un'interruzione o con un CALL lontano attraverso una **porta di chiamata** — non
può usare il suo stack: il processore prende quello scritto nel **TSS**, ci
impila sopra lo stack di prima e ricopia i parametri che la porta dice, perché
il sistema non deve fidarsi della memoria del programma. Al ritorno, i registri
di segmento che puntavano alla memoria del sistema si svuotano. È il giro che
fa Windows 3.1 in modo standard ogni volta che un programma chiede qualcosa.

### Il BIOS di Bochs

SeaBIOS su un 386 non parte: usa BSWAP, un'istruzione del 486, senza chiedere
prima che processore c'è. Il BIOS libero per un 386 è quello di
**[Bochs](https://bochs.sourceforge.io/)**, scritto nel 2002 per l'emulatore
omonimo e nella sua versione «legacy» tutto a sedici bit: sessantaquattro KB,
senza la parte a trentadue bit che fa domande a CPUID. Accanto c'è il
**[VGABIOS LGPL](https://www.nongnu.org/vgabios/)**, nato insieme a lui, che la
macchina affaccia a C0000 — dove il BIOS cerca la ROM della scheda video, come
su una scheda madre vera.

È un BIOS diverso da SeaBIOS, e ha trovato nella scheda tre cose che SeaBIOS
non aveva mai chiesto:

- **non manda mai un SEEK al lettore di dischetti.** Chiede di leggere il
  cilindro che vuole e si aspetta che la testina ci vada da sola, cosa che il
  765 del 1981 non sapeva fare e l'82077 dei chipset degli anni Novanta sì. Il
  controllore di questa scheda adesso lo fa, quello del 286 no;
- **si fida delle parole 4 e 5 di IDENTIFY DEVICE**, i byte di una traccia e di
  un settore, che la norma ha poi dichiarato superate e che i dischi dell'epoca
  riempivano comunque. Con uno zero lì leggeva blocchi da zero parole;
- **fa il reset del canale IDE come dice la norma**: tira su il bit, aspetta di
  vedere il disco occupato, e solo allora lo rimette giù. Un disco che non si
  dichiarava occupato durante il reset lo lasciava ad aspettare.

E una la macchina l'ha dovuta imparare per conto suo: il **lettore di dischetti
c'è sempre**. Sulla scheda del Pentium il setup lo dichiara solo se c'è un
dischetto, per risparmiare al firmware cinque secondi; ma il DOS conta i lettori
una volta sola, all'accensione, e su un 386 del 1990 il lettore era avvitato nel
case. Senza, un dischetto infilato dopo non avrebbe avuto nessun A: in cui
comparire.

### Il filo del cambio disco

Una cosa che vale per tutte e due le schede, e che è venuta fuori qui perché qui
per la prima volta i dischetti si cambiano a macchina accesa. La porta 3F7h ha un
bit che dice se il dischetto è stato cambiato, e non vuol dire «c'è o non c'è»:
è un filo che si alza quando lo sportello si apre e si abbassa solo quando la
testina fa un passo con un dischetto dentro. È così che il DOS sa di dover
buttare la FAT che teneva in memoria. Se il filo seguisse solo la presenza, un
dischetto cambiato con un altro senza passare dal vuoto — che è quello che fa
chi installa da sei dischetti — resterebbe per il DOS il dischetto di prima.

### Nel browser

La pagina è quella del 286, con due cose in più. Il **mouse**: un clic sullo
schermo cattura il puntatore — Esc lo libera — e da lì ogni movimento diventa un
pacchetto di tre byte dall'8042, com'era un mouse PS/2, che sa dire solo di
quanto si è spostato. E lo **schermo che cambia misura**: la canvas segue la VGA,
720×400 in modo testo e quello che serve nei modi grafici. Il resto è uguale: i
dischetti e i dischi fissi si trascinano sulla finestra, i file sciolti e gli zip
finiscono su C:, e la tastiera si sceglie dalla barra con la stessa riga di KEYB
nell'AUTOEXEC.BAT.

### Il 387

Fino al 486 la virgola mobile era un chip a parte, in uno zoccolo vuoto sulla
scheda madre che si riempiva pagando. Qui lo zoccolo è pieno: il 387
(`pentium/fpu.js`) si prende tutte le istruzioni da D8h a DFh — il processore
gli calcola solo l'indirizzo dell'operando — e le esegue sulla sua **pila di
otto registri**, il modo delle calcolatrici HP. Ci sono l'aritmetica, i
confronti che accendono i codici di condizione, le trascendenti (seni, coseni,
tangenti, logaritmi, esponenziali), gli interi da sedici a sessantaquattro bit,
il BCD a diciotto cifre, e il formato a **ottanta bit** scritto in memoria byte
per byte come lo scrive il chip, con l'uno davanti alla mantissa scritto invece
che sottinteso. Dentro i numeri sono double di JavaScript — undici bit in meno
del chip, che nessun programma del 1990 notava — e fuori sono quelli veri.

Con EM acceso in CR0 il coprocessore sparisce e le sue istruzioni diventano
un'eccezione, e con TS la prima istruzione di un task nuovo lo dice al sistema
operativo: sono i due modi in cui un sistema si mette in mezzo, per emulare un
387 che non c'è o per salvare quello di un altro programma solo quando serve.
Sul Pentium il coprocessore è dentro il chip, e adesso CPUID lo dichiara.

### Il modo virtuale 8086 e i task

La cosa per cui il 386 è diventato il processore di Windows: **un programma del
DOS dentro il modo protetto**. Con il bit VM acceso in EFLAGS i segmenti tornano
quelli del modo reale — il selettore per sedici — e il programma crede di avere
la macchina tutta per sé; ma è all'anello 3, sotto la paginazione, e ogni volta
che fa qualcosa di delicato il processore lo ferma e lo dice a chi sorveglia.
Un'interruzione lo porta all'anello 0 salvando anche i suoi quattro segmenti di
dati, sopra tutto il resto; IRETD con VM acceso lo rimette dov'era. Le
istruzioni che toccano le interruzioni — CLI, STI, PUSHF, POPF, INT, IRET —
passano solo se IOPL è 3, e le porte le decide la **mappa dei permessi** in
fondo al TSS, un bit per porta.

La prova è quella vera: **JEMMEX**, il gestore di memoria di FreeDOS, caricato
dal `CONFIG.SYS` del 386. Accende il modo protetto e la paginazione, rimette il
DOS a girare in modo virtuale sotto di sé, e gli dà in cambio la memoria sopra il
primo mega come memoria espansa. Il prompt arriva, `EMSSTAT` vede i sette mega,
`DIR` legge il disco — e ogni interruzione del DOS, nel frattempo, è passata
dall'anello 0 e tornata indietro.

Due cose le ha trovate JEMMEX, e nessuna prova scritta a mano:

- **le letture della IDT, della GDT e del TSS sono sempre accessi di sistema.**
  Il processore le fa per conto suo, anche nel mezzo di un programma
  all'anello 3; contarle con i diritti del programma voleva dire un page fault
  su una pagina del sistema a ogni interruzione, e poi un double fault. E la
  memoria delle traduzioni adesso si ricorda i diritti, non solo l'indirizzo;
- **`pop dword [esp+4]` conta l'indirizzo dopo aver tolto il valore.** È la
  regola del manuale, e JEMM ci costruisce sopra il modo in cui si sposta
  l'indirizzo di ritorno; contandolo prima, il `ret` subito dopo tornava in
  mezzo a una tabella delle pagine.

Accanto c'è il **cambio di task**: JMP o CALL a un TSS o a una porta di task, le
porte di task nella IDT, IRET con NT acceso che torna al task di prima. Tutto lo
stato del programma finisce nel suo TSS e quello dell'altro si carica dal suo —
registri, segmenti, tabella locale, pagine — con i bit "occupato" e il
collegamento al task che ha chiamato.

### Il suono

La **Sound Blaster** del 286, la stessa: il bus ISA c'è anche su questa scheda,
dietro al ponte sud, e le porte, la IRQ 7 e il canale 1 del DMA sono gli stessi
— è per questo che la riga `BLASTER` dello stesso disco va bene su tutte e due.
Nello stesso suono entra l'altoparlante, e la pagina ha il suo pulsante per
l'audio.

### Windows 3.1

Il motivo per cui questa macchina esiste. I dischetti non viaggiano con
alloldos — sono di Microsoft — ma chi li ha li trascina sulla finestra uno alla
volta, come si infilavano allora: `A:`, `SETUP`, e la parte in modo testo copia
i file del primo dischetto e chiede il secondo; poi Setup accende Windows in
**modo standard** — il DOS extender, il modo protetto a sedici bit — e il resto
dell'installazione è già Windows, a 640 per 480.

Arrivarci ha voluto dire trovare tre guasti del processore, e tutti e tre li ha
trovati Setup, nessuno una prova scritta a mano:

- **dopo STI le interruzioni aspettano un'istruzione, e una sola.** Il BIOS di
  Bochs aspetta un tasto con `sti` e un salto indietro al `cli`, e la sua
  finestra è tutta in quel salto; chiusa un'istruzione più in là, la tastiera
  non entrava mai, e Setup restava fermo al primo Invio;
- **CMP non scrive.** Il DOS extender confronta una tabella che tiene dentro il
  suo segmento di codice, e in modo protetto un segmento di codice si legge ma
  non si scrive: la CMP che riscriveva il risultato era un #GP, e Windows si
  fermava con *Fault in MS-DOS Extender*;
- **LAR è una domanda.** Windows passa in rassegna i selettori con LAR per
  sapere quali esistono, e a un selettore fuori dalla tabella il processore
  risponde spegnendo ZF, non con un'eccezione. Lo stesso per LSL, VERR e VERW,
  che adesso controllano anche i privilegi e il tipo come il chip.

### Cosa manca

La velocità: il 386 dichiara trentatré megahertz e ne fa una frazione, e
Windows se ne accorge. E la prova dell'installazione arriva solo fino a Windows
che si accende e disegna il suo Setup grafico: il resto — il nome, i dischetti
dal terzo al sesto, il primo avvio — vuole qualcuno che risponda ai dialoghi, e
non è ancora provato.

## Schermo intero

Il pulsante **Schermo intero** nella barra — e sul C64 anche un doppio clic
sull'immagine. Sull'Amiga no, e per un motivo: lì il doppio clic è della
macchina, apre i cassetti del Workbench e fa partire i giochi, e non può
buttarti fuori dallo schermo intero mentre giochi.

A schermo intero ci va la macchina intera, ma **la barra si toglie di mezzo**:
scivola sotto il bordo, il quadro si prende tutta l'altezza mantenendo le
proporzioni dei pixel PAL, e i comandi tornano quando servono. Tornano in tre
modi, tutti senza doverli sapere:

- appena entri, la barra si fa vedere un paio di secondi e poi se ne va — così
  sai che c'è ancora, e dov'è;
- quando porti il puntatore in fondo allo schermo, e sparisce quando lo togli;
- sull'Amiga, appena il mouse smette di essere catturato: cioè premendo **Esc**,
  che è la stessa cosa che si preme per riprendersi il puntatore.

Si esce col pulsante, che nel frattempo è diventato **Finestra**, o come si esce
da qualsiasi schermo intero. Comunque tu esca, l'etichetta del pulsante lo sa:
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
  denise.js           bitplane, sprite, priorità, HAM, EHB, collisioni, pixel
  paula.js            interrupt di tutta la macchina, e quattro voci in DMA
  cia.js              8520: timer, TOD a 24 bit, tastiera seriale, overlay
  disk.js             DF0: e DF1:, e l'unico canale DMA che li legge
  adf.js              da immagine .adf a flusso MFM, checksum compresi
  keyboard.js         tastiera posizionale e contatori del mouse
  roms.js             dove trovare la Kickstart
  index.js            la sessione: canvas, audio, dischi, mouse, comandi
src/systems/pc/       il PC 286
  cpu286.js           l'80286 in modo reale, con le istruzioni del 186
  machine.js          la scheda: mappa di memoria, porte, e il tempo che passa
  pic.js              8259: chi parla e quando
  pit.js              8253: il tic a 18,2 Hz, il rinfresco e l'altoparlante
  ppi.js              8255: tastiera, interruttori a slitta, altoparlante
  dma.js              8237: quattro canali, pagine, e il rinfresco della RAM
  fdc.js              il NEC 765 e il lettore di dischetti
  ata.js              la scheda XT-CF, il disco, e la geometria letta da dentro
  cga.js              la scheda video: testo e le due grafiche
  soundblaster.js     la Sound Blaster 2.0: il DSP, il suo DMA e la sua IRQ
  opl2.js             lo Yamaha YM3812: nove voci in modulazione di frequenza
  keyboard.js         la tastiera XT, con il suo filo di clock
  scancodes.js        da tasto del browser a numero di tasto sulla matrice
  media.js            i dischi: dove trovarli e come riconoscerli
  roms.js             dove trovare GLaBIOS e la ROM della scheda del disco
  index.js            la sessione: canvas, audio, dischi, tastiera, comandi
src/systems/zx/       lo ZX Spectrum 48K
  cpuz80.js           lo Z80: prefissi, indici, blocchi, e le non documentate
  machine.js          16 KB di ROM, 48 di RAM, e un quadro da 69888 cicli
  ula.js              video, tastiera, bordo, altoparlante: un chip solo
  tape.js             il .tap rifatto in impulsi, con i tempi della ROM
  snapshot.js         le istantanee .sna, lette e scritte
  keyboard.js         dai tasti del browser a quaranta tasti di gomma
  audio.js            il bit dell'altoparlante trasformato in campioni
  roms.js             dove trovare i sedici KB della ROM
  index.js            la sessione: canvas, audio, cassette, tastiera, comandi
src/systems/pentium/  il PC del 1995
  cpu586.js           il Pentium: real mode, modo protetto, paginazione, CPUID
  machine.js          la scheda madre: la mappa, i chip, il tempo, il riavvio
  pci.js              il bus PCI e lo spazio di configurazione
  i440fx.js           il ponte nord con i PAM, e il PIIX3 con l'IDE
  cmos.js             l'MC146818: l'ora e i byte che si ricordano
  kbc.js              l'8042: tastiera, mouse, cancello A20, reset
  vga.js              la VGA: quattro piani, modo testo e grafica
  fwcfg.js            il canale da cui il firmware chiede com'è la macchina
  ide.js              i due canali IDE: i registri, l'LBA, e i settori a parole
  roms.js             dove trovare SeaBIOS e la sua ROM video
  fpu.js              il 387: la pila di otto registri e gli ottanta bit
  session.js          la pagina della scheda: canvas, dischi, tastiera, mouse, suono
  index.js            il Pentium su quella pagina
src/systems/pc386/    il PC 386, sulla scheda del Pentium
  roms.js             dove trovare il BIOS di Bochs e il VGABIOS LGPL
  index.js            il 386 sulla stessa pagina
```

Le macchine sono costruite allo stesso modo: la CPU esegue i cicli di una
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
come una partizione che GRUB elenca e non sa leggere — ce n'è già una in
attesa di qualcuno che la scriva.

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

Un'eccezione c'è, ed è il disco fisso del PC. `roms/pc/hdd.img` contiene
**FreeDOS 1.3** — kernel, `COMMAND.COM` e i programmi in `C:\FDOS\BIN`, KEYB e
le sue tastiere compresi — che è software libero sotto **GNU GPL versione 2**,
ridistribuito qui in forma binaria insieme al resto. I sorgenti stanno dove sta
il resto di FreeDOS, nel
[repository dei pacchetti](https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.3/base/):
ogni pacchetto si porta dietro il proprio, dentro `SOURCE/` — KEYB in `keyb`,
le tastiere in `keyb_lay`. Accanto a loro c'è `KB16.COM`, che invece è di
alloldos, sotto la stessa GPLv3 del resto: il suo sorgente è
`scripts/kb16.mjs`. Il disco lo si rifà dal dischetto ufficiale e da quei due
pacchetti con `npm run make-hdd`.

L'altra eccezione è il BIOS della VGA del 286. `roms/pc/vgabios.bin` è il
**VGABIOS** di Bochs e dei suoi autori, software libero sotto **GNU LGPL**,
compilato dal sorgente della versione 0.8a
([download.savannah.gnu.org/releases/vgabios](https://download.savannah.gnu.org/releases/vgabios/vgabios-0.8a.tgz))
per il 286 invece che per il 386. Le modifiche sono tre, e stanno tutte in
`scripts/build-vgabios.mjs`, che scarica quel sorgente, le applica e lo
compila: i vettori delle due tabelle dei caratteri copiati a sedici bit invece
che a trentadue, la lettura dei registri PCI messa sotto la stessa condizione
del codice VBE che la usa, e l'assemblatore a cui si dice che il processore è
un 286.

Scritto da Daniele Corte e Claude Code. Il codice sta su
[github.com/danielecorte/alloldos](https://github.com/danielecorte/alloldos).
