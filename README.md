# AllOldOs

**→ [danielecorte.github.io/alloldos](https://danielecorte.github.io/alloldos/)**

Un raccoglitore di vecchi sistemi operativi emulati, che gira interamente dentro
il browser. Si parte da una schermata di boot in stile GRUB: scegli la macchina
con le frecce, premi Invio, e quella macchina si accende.

Ce ne sono quattro che partono davvero:

- il **Commodore 64**, emulato dal silicio in su — 6510, VIC-II, due CIA e il
  SID — e avviato sul KERNAL e sul BASIC V2 originali;
- l'**Amiga 500**, con il 68000, Agnus, Denise, Paula, due CIA 8520 e i due
  drive DF0: e DF1:, avviato sulla Kickstart e capace di leggere e scrivere un
  `.adf`. Ci gira sopra un sistema operativo vero: **AROS m68k** arriva alla sua
  schermata di avvio;
- il **PC 286** con scheda XT, il lettore di dischetti da 720 KB e un disco
  fisso da 20 MB. È l'unica macchina qui libera fino in fondo: il BIOS
  **GLaBIOS**, la ROM della scheda del disco **XTIDE**, e sopra **FreeDOS**,
  che si accende dal dischetto o dal disco e arriva al suo prompt;
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
npm run make-hdd     # il disco fisso del PC, con FreeDOS installato sopra
npm start            # http://localhost:8080
```

Nessuna dipendenza, nessun passo di build: sono moduli ES serviti così come
sono. `npm test` esegue sette prove a schermo spento: la prima accende il C64,
verifica che arrivi al prompt `READY.` e ci fa girare un programma; la seconda
preme i tasti attraverso lo stesso codice che usa il browser e rilegge dallo
schermo i caratteri arrivati davvero al BASIC; la terza registra un nastro e lo
fa ricaricare al KERNAL; la quarta prende l'Amiga a pezzi (vedi sotto); la
quinta monta un DOM finto e fa girare l'intera sessione del browser di tutte e
tre le macchine, canvas e audio compresi; la sesta accende il PC, gli fa fare il
POST con il BIOS vero e ci avvia FreeDOS dal dischetto e dal disco fisso; la
settima accende lo Spectrum, ci fa fare un conto in virgola mobile alla sua ROM
e gli fa caricare una cassetta.

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
  scarica quello e tira fuori l'immagine che serve.

Poi `npm run make-hdd` prepara un disco fisso da venti mega con FreeDOS
installato sopra. Sono tutti file liberi, e nessuno è nel repository.

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
GPLv2), sistema operativo libero (FreeDOS). Niente di tutto questo è nel
repository — nessun firmware lo è — ma tutto si scarica con un comando.

Ci si accende sopra **FreeDOS**, dal dischetto o dal disco fisso:

```
GLaBIOS [.] Reboot the Past
(C) 2022-26 640KB Released under GPLv3

Boot   [ COLD ]
RAM    [ 640 KB OK ]            Video  [ CGA ]
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

Il disco si prepara con:

```sh
npm run make-hdd
```

che ci mette venti secondi e **non scrive un byte di filesystem**. Accende la
macchina emulata con il dischetto di FreeDOS dentro e ci batte sopra i comandi
che ci si batteva allora, uno per uno: `FDISK /AUTO` per la partizione,
`FDISK /MBR` per il codice che ci sta davanti, un riavvio perché il DOS se ne
accorga, `FORMAT C:`, `SYS C:`, e poi la copia dei programmi. La tabella delle
partizioni e la FAT le scrivono FDISK e FORMAT veri, girando sul 286: è l'unico
modo di essere sicuri che siano giuste.

Il disco finito sta in `roms/pc/hdd.img` e non è nel repository. Dalla pagina
pubblica si parte con un disco **vuoto** — venti mega di zeri, come si comprava
— e lo si può partizionare e formattare a mano, che è esattamente il pomeriggio
che ci passava chiunque nel 1988. **Salva il disco fisso** se lo riporta via
come file, e ritrascinandolo lo si rimette dentro.

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
- la **CGA**: testo a ottanta colonne con il disegno delle lettere preso dalla
  ROM del BIOS, cursore che lampeggia, e le due grafiche — 320×200 a quattro
  colori e 640×200 in bianco e nero;
- l'**altoparlante**: un bit e un contatore, che è tutto il suono che il PC ha
  avuto per dieci anni.

Manca la **VGA** con il suo BIOS di scheda, il suono campionato — quello che
pilota il bit dell'altoparlante a mano invece di lasciar fare al contatore — e
il modo protetto, che il DOS non usa.

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
per uno, poi la macchina intera. Le ultime tre sezioni sono quelle che contano —
il POST di GLaBIOS, FreeDOS che parte dal dischetto e ci scrive sopra un file, e
FreeDOS che parte dal disco fisso, ci scrive, e ritrova quello che ha scritto
dopo un riavvio. I comandi vengono battuti sulla tastiera attraverso lo stesso
codice che usa il browser.

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
  ata.js              la scheda XT-CF e i venti mega di disco fisso
  cga.js              la scheda video: testo e le due grafiche
  keyboard.js         la tastiera XT, con il suo filo di clock
  scancodes.js        da tasto del browser a numero di tasto sulla matrice
  speaker.js          l'altoparlante: un bit e un contatore
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

Scritto da Daniele Corte e Claude Code. Il codice sta su
[github.com/danielecorte/alloldos](https://github.com/danielecorte/alloldos).
