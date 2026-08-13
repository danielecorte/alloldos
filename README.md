# AllOldOs

**→ [danielecorte.github.io/alloldos](https://danielecorte.github.io/alloldos/)**

Un raccoglitore di vecchi sistemi operativi emulati, che gira interamente dentro
il browser. Si parte da una schermata di boot in stile GRUB: scegli la macchina
con le frecce, premi Invio, e quella macchina si accende.

Al primo avvio la pagina chiede le tre ROM del C64: sono proprietà
Commodore/Cloanto e non possono essere distribuite, quindi si trascinano sulla
finestra una volta sola e restano salvate in quel browser. Chi ha
[VICE](https://vice-emu.sourceforge.io/) le ha già in casa; chi clona questo
repository le prende con `npm run fetch-roms`.

La prima disponibile è il **Commodore 64**, emulato dal silicio in su — 6510,
VIC-II, due CIA e il SID — e avviato sul KERNAL e sul BASIC V2 originali. Non è
una simulazione dell'aspetto di un C64: è un C64 che esegue il suo firmware.

In fondo al menu c'è la voce **About**: una pagina in stile C64 con licenza,
crediti, quello che c'è dentro e quello che manca ancora.

## Avvio

```sh
npm run fetch-roms   # scarica KERNAL, BASIC e il generatore di caratteri
npm start            # http://localhost:8080
```

Nessuna dipendenza, nessun passo di build: sono moduli ES serviti così come
sono. `npm test` esegue quattro prove a schermo spento: la prima accende la
macchina, verifica che arrivi al prompt `READY.` e ci fa girare un programma; la
seconda preme i tasti attraverso lo stesso codice che usa il browser e rilegge
dallo schermo i caratteri arrivati davvero al BASIC; la terza registra un nastro
e lo fa ricaricare al KERNAL; la quarta monta un DOM finto e fa girare l'intera
sessione del browser, canvas e audio compresi.

Se in cartella c'è un `.tap`, l'ultima prova ci carica dentro anche quello e poi
**ci gioca**: tiene premuta una direzione e guarda dove finisce il personaggio.
Con `1994.tap` — che si guida con su e giù, su cammina a destra e giù a
sinistra — la prova è che la sua coordinata cala tenendo giù, risale tenendo su
e non si muove di un pixel se non premi niente. È tutta la catena in una riga
sola: l'evento del browser, la matrice, il joystick sulla porta 1, la lettura
che il gioco fa di `$dc01`, il pixel sullo schermo.

### Le ROM

Il firmware del C64 è proprietà Commodore/Cloanto e non viene distribuito con
questo progetto. `npm run fetch-roms` lo scarica dalla distribuzione di VICE
nella cartella `roms/c64/`. In alternativa puoi trascinare i tre file
(`kernal.bin`, `basic.bin`, `chargen.bin`) sulla finestra dell'emulatore:
vengono riconosciuti dal contenuto e restano salvati in quel browser.

## Far girare un file `.bas`

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

## Le cassette (`.tap`)

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

### Come è stato ricavato il formato

Non da una tabella. Il registratore emulato sa anche registrare, quindi al C64
emulato è stato fatto scrivere un nastro con la sua `SAVE`, e la forma d'onda è
stata misurata: ogni impulso è fatto di due semionde uguali da 184, 256 o 344
cicli, il leader è di `$6A00` impulsi, e fra le due copie di ogni blocco c'è uno
stacco di 80 impulsi corti. `npm test` chiude il cerchio: fa registrare un
nastro alla macchina e glielo ridà da leggere.

In `programs/` ci sono quattro esempi da provare subito, incluso l'immortale
labirinto di una riga sola.

### Estensioni del formato `.bas`

Il testo è quello che scriveresti sul C64, con due comodità in più:

- le maiuscole non contano, `print` e `PRINT` sono la stessa cosa;
- i caratteri di controllo si scrivono per nome: `{clr}`, `{home}`, `{down}`,
  `{rvs on}`, `{cyan}`, e anche `{5 right}` o `{$93}` per un byte qualsiasi.

## Tasti

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

## Schermo intero

Il pulsante **Schermo intero** nella barra, o un doppio clic sull'immagine. A
schermo intero ci va la macchina intera, barra compresa: i pulsanti, il
contatore del nastro e la riga di stato restano dove sono, e il quadro si
prende tutta l'altezza rimasta mantenendo le proporzioni dei pixel PAL. Si esce
col pulsante, che nel frattempo è diventato **Finestra**, o come si esce da
qualsiasi schermo intero. Comunque tu esca, l'etichetta del pulsante lo sa:
segue il browser, non i nostri clic.

## Il joystick

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

`Ctrl+V` incolla del testo battendolo nella macchina un tasto alla volta.

Il tasto Commodore sta su Alt e non su Ctrl di proposito: `Ctrl`+lettera è una
scorciatoia del browser, e la finestra se ne va prima che arrivi il `keyup` —
il tasto resterebbe premuto e da lì in poi uscirebbe tutt'altro. Per la stessa
ragione lo stato di Shift e Commodore viene ricostruito dai flag di ogni
evento, così un `keyup` perso si ripara da solo al tasto successivo.

Se qualcosa non torna, **Diagnostica tasti** nella barra in basso mostra in
diretta l'evento ricevuto e la cella della matrice in cui viene tradotto.

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
```

Il VIC-II disegna una riga di raster alla volta: la CPU esegue i cicli di una
riga, poi la riga viene disegnata. Non è esatto al singolo ciclo, ma le badline,
i contatori di riga e gli interrupt di raster ci sono, che è quello che serve
agli split di schermo e allo scrolling. Il frame è quello PAL: 312 righe da 63
cicli, 50,125 Hz.

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
come una partizione che GRUB elenca e non sa leggere — ce ne sono già quattro in
attesa di qualcuno che le scriva.

Non serve che sia una macchina: la voce **About** in fondo al menu è una pagina
in stile C64 con licenza, crediti e sviluppi futuri, e si avvia esattamente
attraverso questo contratto. Una voce può anche descriversi con le proprie
righe invece che con cpu/memoria/note, passando `details: [[etichetta, valore]]`.

## Licenza

alloldos è software libero, sotto **GNU General Public License versione 3** —
il testo completo è in [`LICENSE`](LICENSE). Puoi usarlo, studiarlo,
modificarlo e ridistribuirlo, a patto che chi lo riceve da te si ritrovi con le
stesse libertà.

Le ROM del Commodore 64 (KERNAL, BASIC, generatore di caratteri) sono proprietà
Commodore/Cloanto: non sono incluse in questo progetto e non sono coperte da
questa licenza.

Scritto da Daniele Corte e Claude Code. Il codice sta su
[github.com/danielecorte/alloldos](https://github.com/danielecorte/alloldos).
