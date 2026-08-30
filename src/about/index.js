// The about page.
//
// It boots the same way a machine does — one `boot(container, { onExit })`
// export, one `dispose()` — because from the boot menu's point of view that is
// exactly what it is: a partition you can select, that happens to contain a
// page instead of a computer.
//
// The page is laid out the way the project is: the credits first, and then one
// section per machine, each one saying where its firmware comes from, what has
// been built, and what has not been built yet.

import { ROM_SPECS, romDownloadLink } from '../systems/c64/roms.js';
import { AMIGA_FOREVER_URL, AROS_URL } from '../systems/amiga/roms.js';
import { GLABIOS_URL } from '../systems/pc/roms.js';

const SOURCE_URL = 'https://github.com/danielecorte/alloldos';

class AboutPage {
  constructor(container, { onExit }) {
    this.container = container;
    this.onExit = onExit;
    this.build();
  }

  build() {
    this.root = element('div', 'about');
    this.root.tabIndex = 0;

    const screen = element('div', 'about__screen');
    screen.innerHTML = `
      <pre class="about__banner">    **** ALLOLDOS ****

 </pre>

      <p>Un raccoglitore di vecchi sistemi operativi emulati, che gira
      interamente dentro il browser. Si parte da una schermata di avvio in stile
      GRUB: scegli la macchina con le frecce, premi Invio, e quella macchina si
      accende. Non è una simulazione dell'aspetto di quei computer: sono quei
      computer che eseguono il loro firmware, dal silicio in su.</p>

      <p class="about__note">Il firmware non è incluso: è di chi lo ha scritto,
      e va portato da te. Ogni macchina qui sotto dice dove prendere il suo.</p>

      ${this.credits()}
      ${this.commodore64()}
      ${this.amiga500()}

      <pre class="about__ready">READY.
<span class="about__cursor">&nbsp;</span></pre>
    `;

    this.exitButton = element('button', 'about__button');
    this.exitButton.type = 'button';
    this.exitButton.textContent = 'Torna al menu di avvio';
    this.exitButton.addEventListener('click', () => this.onExit());

    const footer = element('div', 'about__footer');
    footer.append(this.exitButton);
    const hint = element('span', 'about__hint');
    hint.textContent = 'oppure premi Invio o Esc';
    footer.append(hint);

    this.root.append(screen, footer);
    this.container.append(this.root);

    this.keyHandler = (event) => this.onKeyDown(event);
    window.addEventListener('keydown', this.keyHandler);
    this.root.focus();
  }

  // ------------------------------------------------------------- crediti

  credits() {
    return `
      <h2 class="about__section">Crediti</h2>

      <h3 class="about__heading">Fatto da</h3>
      <p><b>Daniele Corte</b> e <b>Claude Code</b>, a quattro mani.</p>

      <h3 class="about__heading">Licenza</h3>
      <p>alloldos è <b>software libero</b>, sotto <b>GNU General Public License
      versione 3</b>. Puoi usarlo, studiarlo, modificarlo e ridistribuirlo — a
      patto che chi lo riceve da te si ritrovi con le stesse libertà. Il testo
      completo è nel file <code>LICENSE</code> del repository.</p>
      <p class="about__note">Le ROM delle macchine emulate non sono incluse in
      questo progetto e non sono coperte da questa licenza: restano di
      Commodore/Cloanto, che ne è la proprietaria.</p>

      <h3 class="about__heading">Sorgenti</h3>
      <p>Il codice è pubblico:<br>
      <a class="about__link" href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">${SOURCE_URL.replace('https://', '')}</a></p>
    `;
  }

  // --------------------------------------------------------- commodore 64

  commodore64() {
    return `
      <h2 class="about__section">Commodore 64</h2>
      <p>Un C64 PAL emulato dal silicio in su, avviato sul KERNAL e sul BASIC V2
      originali.</p>

      <h3 class="about__heading">Dove trovare le ROM</h3>
      <p>Quel firmware è proprietà Commodore/Cloanto e non può essere
      distribuito con questa pagina, quindi al primo avvio la macchina te lo
      chiede. Sono tre file, 20 KB in tutto, e vengono dalla distribuzione di
      <a class="about__link" href="https://vice-emu.sourceforge.io/" target="_blank" rel="noopener noreferrer">VICE</a>:</p>
      <ul class="about__list">
        ${ROM_SPECS.map((spec) => `<li>${romDownloadLink(spec)}</li>`).join('\n        ')}
      </ul>
      <p>Scaricali e <b>trascinali tutti e tre sulla finestra</b>. Il nome non
      conta: vengono riconosciuti dal contenuto, quindi vanno bene così come
      sono. Se hai già VICE installato non serve scaricare niente — stanno nella
      sua cartella <code>C64</code>.</p>
      <p class="about__note">Restano nel tuo browser e non vanno da nessuna
      parte: alloldos non ha un server a cui mandarli. Vanno rimessi se cambi
      browser o cancelli i dati del sito. Chi vuole una licenza esplicita sul
      firmware può prendere <i>C64 Forever</i> di Cloanto.</p>

      <h3 class="about__heading">Cosa è stato fatto</h3>
      <ul class="about__list">
        <li>Il <b>6510</b> per intero.</li>
        <li>Il <b>VIC-II</b> una riga di raster alla volta: testo, multicolor,
        bitmap, sprite, badline e interrupt di raster.</li>
        <li>Due <b>CIA 6526</b>: timer, orologio, tastiera, joystick, /FLAG.</li>
        <li>Il <b>SID 6581</b> a tre voci, con ADSR vero.</li>
        <li>Il <b>registratore 1530</b>. Un <code>.tap</code> non viene
        interpretato ma <b>risuonato</b>, impulso per impulso, sul piedino /FLAG:
        per questo funzionano anche i turbo loader — nessuno qui capisce il
        formato del nastro, quindi non c'è niente da capire di sbagliato.</li>
        <li>I file <b>.bas</b> tokenizzati esattamente come li tokenizzerebbe la
        ROM, e riscritti indietro in testo.</li>
        <li><b>Tastiera simbolica</b> — il carattere che digiti è il carattere
        che arriva al C64 — e <b>joystick</b> su entrambe le porte, con la
        macchina che guarda quale porta il gioco interroga e te lo dice.</li>
        <li><b>Schermo intero</b>, e una diagnostica che mostra in diretta in
        quale cella della matrice finisce ogni tasto.</li>
        <li>Una <b>suite di prove</b> che accende la macchina, ci batte i tasti,
        registra un nastro e glielo fa rileggere, e infine <b>gioca davvero</b> a
        un gioco: tiene premuta una direzione e controlla dove finisce il
        personaggio.</li>
      </ul>

      <h3 class="about__heading">Cosa manca</h3>
      <ul class="about__list">
        <li>Il drive <b>1541</b> e le immagini <code>.d64</code>.</li>
        <li>Il filtro del SID fatto per bene: oggi è un'approssimazione.</li>
        <li>Salvataggio e ripristino dello stato della macchina.</li>
      </ul>
    `;
  }

  // ----------------------------------------------------------- amiga 500

  amiga500() {
    return `
      <h2 class="about__section">Amiga 500</h2>
      <p>Un A500 PAL: 68000, Agnus, Denise e Paula, due CIA 8520 e il drive
      DF0:. Multitasking preemptivo nel 1987, su una macchina che costava come
      una televisione.</p>
      <p>La memoria è quella di un A500 cresciuto bene: 1 MB di Chip RAM come
      l'Agnus 8372A dell'A500+, i 512 KB della scheda A501 sotto lo sportello, e
      8 MB di Fast RAM su una scheda Zorro II che si presenta da sola in
      autoconfig. Non è la macchina uscita dal negozio nel 1987, ed è voluto:
      AROS è un sistema operativo molto più grande della Kickstart per cui questi
      programmi sono stati scritti, e senza spazio dove starsene si siede
      esattamente dove il programma vuole mettere lo schermo.</p>
      <p>Non è una macchina che <i>dovrebbe</i> funzionare: ci gira sopra un
      sistema operativo vero. Con la Kickstart libera di AROS la macchina si
      accende, monta exec, graphics, intuition e dos, apre uno schermo a 640×512
      interlacciato e arriva alla sua schermata di avvio, con il puntatore del
      mouse che si muove.</p>

      <h3 class="about__heading">Dove trovare la Kickstart</h3>
      <p>Qui il firmware non è un aiuto all'avvio: <b>è il sistema operativo</b>.
      Dentro la Kickstart ci stanno <b>exec</b>, <b>graphics</b>,
      <b>intuition</b> e <b>dos</b> — tutto AmigaOS tranne quello che sta sul
      disco. Serve un file da <b>256 KB</b> (Kickstart 1.2 o 1.3) oppure da
      <b>512 KB</b> (2.0 e successive), da trascinare sulla finestra.</p>
      <p>A differenza delle ROM del C64 non c'è un VICE da cui scaricarla: la
      Kickstart è di Cloanto, e nessuna copia gratuita in giro è una copia
      legale. Due strade oneste:</p>
      <ul class="about__list">
        <li><a class="about__link" href="${AMIGA_FOREVER_URL}" target="_blank" rel="noopener noreferrer">Amiga
        Forever</a> di Cloanto, che è la licenza ufficiale delle ROM;</li>
        <li>la Kickstart libera di
        <a class="about__link" href="${AROS_URL}" target="_blank" rel="noopener noreferrer">AROS</a>,
        che è software libero, si scarica e si avvia davvero.</li>
      </ul>
      <p class="about__note">Le ROM cifrate di Cloanto (quelle che iniziano con
      <code>AMIROMTYPE1</code>) non vanno bene così come sono: serve la versione
      in chiaro. Anche questa resta nel tuo browser e non va da nessuna parte.</p>

      <h3 class="about__heading">Cosa è stato fatto</h3>
      <ul class="about__list">
        <li>Il <b>68000</b> per intero: modo utente e supervisore, i due stack,
        le eccezioni vere — errore di indirizzo, violazione di privilegio, TRAP,
        interrupt autovettorizzati.</li>
        <li><b>Agnus</b>: il conteggio del pennello, la DMA di bitplane e
        sprite, e il <b>copper</b> — che aspetta il pennello e scrive nei
        registri mentre lo schermo si sta disegnando. Le sue MOVE cadono nel
        punto esatto della riga in cui il copper le esegue, non all'inizio.</li>
        <li>Il <b>blitter</b>: quattro canali, i 256 minterm, il barrel shifter,
        l'area fill e il tracciamento di linee con Bresenham.</li>
        <li><b>Denise</b>: da uno a sei bitplane, lores e hires, dual playfield,
        <b>HAM</b> ed <b>extra half brite</b>, gli otto sprite con le priorità
        di BPLCON2, e la finestra di visualizzazione.</li>
        <li><b>Paula</b>: gli interrupt di tutta la macchina, e quattro canali
        audio in DMA — 0 e 3 a sinistra, 1 e 2 a destra, come l'originale.</li>
        <li>Le <b>collisioni</b> in hardware: CLXDAT dice chi ha toccato chi,
        con le regole di CLXCON — quali bitplane contano e con che valore, e
        quali sprite dispari partecipano. Un piano disabilitato non può
        impedire una collisione, che è perché una macchina che non ha mai
        scritto CLXCON collide di continuo.</li>
        <li>Due <b>CIA 8520</b>: timer, i contatori a 24 bit agganciati al
        quadro e alla riga, la tastiera seriale, la linea di overlay della ROM.</li>
        <li>I due <b>drive</b>, <b>DF0:</b> e <b>DF1:</b>: motore, testina,
        passi, linguetta di protezione, e una sola linea di selezione a decidere
        chi risponde — che è il motivo per cui quattro fili di stato bastano per
        tutti. Un <code>.adf</code> non viene letto a settori ma <b>riscritto in
        MFM</b> — intestazioni, checksum, sync e gap — e dato alla DMA come
        flusso grezzo, perché è così che trackdisk.device se lo aspetta.</li>
        <li>La <b>scrittura</b>: la traccia che esce viene riletta come la
        leggerebbe la testina, e i settori tornano nell'immagine. Appena il
        drive tace, l'<code>.adf</code> aggiornato viene scaricato: qui non c'è
        nessuno scaffale dove posare un floppy.</li>
        <li><b>Mouse</b> con il puntatore agganciato alla finestra: l'Amiga non
        sa dove sia il mouse, conta solo di quanto è girata la pallina.</li>
        <li><b>Joystick</b> nella porta 2, su richiesta, con frecce e spazio. La
        porta è nata per un mouse, quindi su e giù non sono bit: escono da uno
        XOR fra bit vicini, ed è per quello che ogni gioco li legge con uno
        shift.</li>
        <li>L'<b>interlace</b>: ogni riga di quadro ha due righe di immagine, e
        i due semiquadri finiscono su quelle alterne. Senza, uno schermo a
        640×512 viene fuori schiacciato a metà altezza.</li>
      </ul>

      <h3 class="about__heading">Le due cose che solo un sistema vero ha trovato</h3>
      <p>Tutte le prove sintetiche passavano già. Queste due no, e non si vedono
      finché non provi a far girare del software che non sapeva di te:</p>
      <ul class="about__list">
        <li>Un <b>timer del CIA in one-shot parte quando gli scrivi il byte
        alto</b>: è una riga sola nel foglio dati del 6526, e AmigaOS ci
        costruisce sopra l'handshake della tastiera. Senza, la macchina si
        inchioda a metà avvio con tutte le task in attesa e nessuna pronta. È lo
        stesso chip del C64, quindi la correzione è andata anche lì.</li>
        <li>Il <b>fetch dei bitplane si conta a blocchi di otto color clock,
        arrotondando per eccesso</b>. Troncarlo fa pescare a ogni riga due byte
        più indietro della riga sopra: il Workbench resta perfettamente
        leggibile, ma in diagonale.</li>
      </ul>

      <h3 class="about__heading">Cosa manca</h3>
      <ul class="about__list">
        <li>I <b>blit non istantanei</b>: qui finiscono tutti in un colpo. Chi
        aspetta BBUSY o l'interrupt non se ne accorge, chi conta i cicli sì.</li>
        <li>Le <b>porte pot</b>, che leggono i potenziometri dei paddle.</li>
        <li>L'hard disk, e le macchine NTSC: questa è PAL e basta.</li>
      </ul>

      <h2 class="about__section">PC 286</h2>
      <p>La macchina in costruzione, e l'unica qui il cui firmware è software
      libero. Non è un AT: è una <b>scheda XT con sopra un 286</b> — una
      macchina che nel 1988 si poteva davvero comprare, e che qui è una scelta
      obbligata. <a class="about__link" href="${GLABIOS_URL}" target="_blank" rel="noopener noreferrer">GLaBIOS</a>
      è l'unico BIOS per PC libero e completo che esista, ed è un BIOS XT; un
      BIOS AT libero non c'è. Il 286 è il set di istruzioni, che è quello che il
      software guarda; la scheda intorno è quella che il BIOS sa avviare.</p>
      <p>Dal menu non si accende ancora, ma il BIOS ci gira sopra e arriva in
      fondo al suo POST: conta i 640 KB uno per uno, riconosce la scheda video
      dagli interruttori a slitta, controlla che il DMA stia rinfrescando la
      memoria, e alla fine chiede un tasto. L'unico guaio che trova è il
      controllore del disco, che è il pezzo dopo.</p>

      <h3 class="about__heading">Cosa è stato fatto</h3>
      <ul class="about__list">
        <li>L'<b>80286</b> in modo reale, con i dettagli da cui un programma
        capisce di non essere su un 8086: i quattro bit alti di FLAGS spenti, i
        contatori di scorrimento mascherati a cinque bit, e le istruzioni del
        186 — PUSHA, ENTER, BOUND, IMUL con immediato.</li>
        <li>La <b>mappa di memoria</b> del PC, che è rimasta la stessa per
        quarant'anni: 640 KB in fondo, le schede da A0000 a EFFFF, il BIOS in
        cima.</li>
        <li>L'<b>8259</b> delle interruzioni, i tre contatori dell'<b>8253</b> —
        il tic a 18,2 Hz, il rinfresco della memoria e l'altoparlante — e
        l'<b>8255</b> con la tastiera e gli interruttori a slitta.</li>
        <li>L'<b>8237</b> del DMA, con i registri di pagina e la giunzione a
        64 KB che non riporta, e il conteggio del rinfresco che gira davvero.</li>
        <li>La <b>tastiera XT</b> con il suo filo di clock, e la metà testo
        della scheda video — memoria a B800 e il registro di stato che segue il
        pennello, che è quello che il BIOS aspetta prima di ogni carattere.</li>
      </ul>

      <h3 class="about__heading">Cosa manca</h3>
      <ul class="about__list">
        <li>Il <b>controllore del disco</b>, che è quello che porterà su
        <b>FreeDOS</b>.</li>
        <li>La <b>VGA</b> con il suo BIOS di scheda, e quindi il video sullo
        schermo: per ora il testo si legge solo dalle prove.</li>
        <li>Il <b>suono</b>, e il modo protetto — che il DOS non usa, e che
        Windows 3 e i DOS extender sono un altro progetto.</li>
      </ul>
    `;
  }

  onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    this.onExit();
  }

  dispose() {
    window.removeEventListener('keydown', this.keyHandler);
    this.root.remove();
  }
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * The same contract as a machine: take the container, come back with something
 * that knows how to clean up after itself.
 * @returns {Promise<{dispose():void}>}
 */
export async function boot(container, { onExit }) {
  return new AboutPage(container, { onExit });
}
