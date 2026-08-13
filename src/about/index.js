// The about page.
//
// It boots the same way a machine does — one `boot(container, { onExit })`
// export, one `dispose()` — because from the boot menu's point of view that is
// exactly what it is: a partition you can select, that happens to contain a
// page instead of a computer.

import { ROM_SPECS, romDownloadLink } from '../systems/c64/roms.js';

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

      <h2 class="about__heading">Cos'è</h2>
      <p>Un raccoglitore di vecchi sistemi operativi emulati, che gira
      interamente dentro il browser. Si parte da una schermata di avvio in stile
      GRUB: scegli la macchina con le frecce, premi Invio, e quella macchina si
      accende. La prima è il Commodore 64, emulato dal silicio in su e avviato
      sul KERNAL e sul BASIC V2 originali. Non è una simulazione dell'aspetto di
      un C64: è un C64 che esegue il suo firmware.</p>

      <h2 class="about__heading">Dove trovare le ROM</h2>
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

      <h2 class="about__heading">Cosa è stato fatto</h2>
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

      <h2 class="about__heading">Sviluppi futuri</h2>
      <ul class="about__list">
        <li>Le altre macchine già elencate nel menu di avvio: ZX Spectrum,
        Apple II, MS-DOS, Amiga. Compaiono come partizioni che il bootloader
        vede e non sa ancora leggere.</li>
        <li>Il drive <b>1541</b> e le immagini <code>.d64</code>.</li>
        <li>Salvataggio e ripristino dello stato della macchina.</li>
        <li>Il filtro del SID fatto per bene: oggi è un'approssimazione.</li>
        <li>Joypad USB con la Gamepad API, e comandi a sfioramento per il
        telefono.</li>
      </ul>

      <h2 class="about__heading">Licenza</h2>
      <p>alloldos è <b>software libero</b>, sotto <b>GNU General Public License
      versione 3</b>. Puoi usarlo, studiarlo, modificarlo e ridistribuirlo — a
      patto che chi lo riceve da te si ritrovi con le stesse libertà. Il testo
      completo è nel file <code>LICENSE</code> del repository.</p>
      <p class="about__note">Le ROM del Commodore 64 (KERNAL, BASIC e generatore
      di caratteri) sono proprietà Commodore/Cloanto: non sono incluse in questo
      progetto e non sono coperte da questa licenza.</p>

      <h2 class="about__heading">Fatto da</h2>
      <p><b>Daniele Corte</b> e <b>Claude Code</b>, a quattro mani.</p>

      <h2 class="about__heading">Sorgenti</h2>
      <p>Il codice è pubblico:<br>
      <a class="about__link" href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">${SOURCE_URL.replace('https://', '')}</a></p>

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
