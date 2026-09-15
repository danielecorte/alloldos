// Il PC 286 come lo vede alloldos: accendilo, mettigli la sua immagine su una
// canvas, dagli la tastiera, e lasciagli infilare dentro i dischi.

import { PC, FPS } from './machine.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './cga.js';
import { AudioOutput } from '../zx/audio.js';
import { SCANCODES } from './scancodes.js';
import {
  loadBIOS,
  loadCardROM,
  loadVideoROM,
  acceptROMFile,
  MissingBIOSError,
  BIOS_SPEC,
  CARD_SPEC,
  CARD_ROM_BASE,
  VIDEO_SPEC,
  VIDEO_ROM_BASE,
  VIDEO_DOWNLOAD_URL,
  GLABIOS_URL,
  GLABIOS_SOURCE_URL,
  XTIDE_URL,
  XTIDE_SOURCE_URL,
} from './roms.js';
import {
  loadFloppy,
  loadHardDisk,
  hardDiskFrom,
  storeFloppy,
  classifyImage,
  FREEDOS_SPEC,
} from './media.js';
import { isZip, readZip } from './zip.js';
import { formatOf } from './fdc.js';
import {
  LAYOUTS,
  DEFAULT_LAYOUT,
  layoutNamed,
  layoutOf,
  setLayout,
  preferredLayout,
  storePreferredLayout,
} from './layouts.js';
import {
  loadIntoDisk,
  NoFilesystemError,
  FullDiskError,
  FullDirectoryError,
  UnreadableZipError,
} from './files.js';

const MAX_CATCHUP_FRAMES = 4; // non si recupera più di tanto dopo una pausa

/**
 * Quanto deve stare fermo il lettore prima che il dischetto scritto torni
 * indietro come file. Qui non c'è nessuno scaffale dove posarlo: quello che la
 * macchina scrive resta nell'immagine in memoria, che sopravvive a un reset e
 * muore con la scheda del browser.
 */
const SAVE_QUIET_MS = 1500;

/** La striscia in fondo che richiama la barra, e quanto resta in vista da sé. */
const CONTROLS_EDGE = 60;
const CONTROLS_FLASH = 2500;

class PCSession {
  constructor(container, options) {
    this.container = container;
    this.onExit = options.onExit;
    this.machine = null;
    /** Il suono: la Sound Blaster e l'altoparlante, in campioni. */
    this.sound = null;
    this.running = false;
    this.paused = false;
    this.rafHandle = 0;
    this.lastTime = 0;
    this.frameDebt = 0;
    this.floppyName = '';
    this.diskName = '';
    this.seenFloppyWrites = 0;
    this.savedFloppyWrites = 0;
    this.savedDiskWrites = 0;
    this.quietAt = 0;
    /** I dischi arrivati prima che ci fosse una macchina in cui metterli. */
    this.pending = [];
    this.build();
  }

  // --------------------------------------------------------------------- DOM

  build() {
    this.root = element('div', 'pc');
    this.root.tabIndex = 0;

    const stage = element('div', 'pc__stage');
    this.canvas = element('canvas', 'pc__canvas');
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.resizeImage(SCREEN_WIDTH, SCREEN_HEIGHT);
    stage.append(this.canvas);

    this.overlay = element('div', 'pc__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'pc__bar');
    this.status = element('span', 'pc__status');
    this.bar.append(
      this.button('Carica un file', () => this.pickFile()),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.layoutPicker(),
      this.button('Salva il dischetto', () => this.saveFloppy()),
      this.button('Salva il disco fisso', () => this.saveHardDisk()),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    // Le due unità, con la loro spia: su una macchina vera è tutto quello che
    // si vede di un disco mentre lavora, e serve a sapere se sta lavorando.
    this.drives = element('div', 'pc__drives');
    this.floppyRow = this.driveRow('A:', 'dischetto vuoto');
    this.diskRow = this.driveRow('C:', 'disco fisso, 20 MB');
    this.drives.append(this.floppyRow.row, this.diskRow.row);

    this.fileInput = element('input', 'pc__file');
    this.fileInput.type = 'file';
    // Nessun filtro: un dischetto, una ROM, e tutto il resto, che finisce sul
    // disco fisso. Il nome non conta, si guarda cosa c'è dentro.
    this.fileInput.multiple = true;
    this.fileInput.addEventListener('change', () => {
      this.acceptFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });

    this.controls = element('div', 'pc__controls');
    this.controls.append(this.bar, this.drives);

    this.root.append(stage, this.controls, this.fileInput);
    this.container.append(this.root);

    this.bindEvents();
  }

  /**
   * La canvas prende la misura del quadro: 640 per 200 con la CGA, 720 per
   * 400 con la VGA in modo testo, 320 per 200 nel modo dei giochi. Lo
   * schermo è sempre un 4:3, e a stirare i punti ci pensa il foglio di stile.
   */
  resizeImage(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.image = this.context.createImageData(width, height);
    this.imageWords = new Uint32Array(this.image.data.buffer);
  }

  driveRow(name, label) {
    const row = element('div', 'pc__drive');
    const light = element('span', 'pc__light');
    const title = element('span', 'pc__drive-name');
    title.textContent = name;
    const text = element('span', 'pc__drive-label');
    text.textContent = label;
    row.append(light, title, text);
    return { row, light, text };
  }

  /**
   * La tastiera che si ha sotto le dita. La scelta non traduce niente qui
   * dentro: finisce nell'AUTOEXEC.BAT, dove la legge KEYB all'accensione.
   */
  layoutPicker() {
    this.layoutSelect = element('select', 'pc__select');
    this.layoutSelect.tabIndex = -1;
    this.layoutSelect.title = 'La tastiera che hai: la carica KEYB, all\'accensione';
    for (const { id, label, name } of LAYOUTS) {
      const option = element('option');
      option.value = id;
      option.textContent = `Tastiera ${label} (${name})`;
      this.layoutSelect.append(option);
    }
    this.layoutSelect.value = preferredLayout();
    this.layoutSelect.addEventListener('change', () => {
      this.chooseLayout(this.layoutSelect.value);
      this.root.focus(); // la tastiera torna alla macchina
    });
    return this.layoutSelect;
  }

  button(label, action) {
    const node = element('button', 'pc__button');
    node.type = 'button';
    node.tabIndex = -1;
    node.textContent = label;
    node.addEventListener('click', (event) => {
      event.preventDefault();
      action();
      this.root.focus(); // la tastiera resta puntata sulla macchina
    });
    return node;
  }

  bindEvents() {
    this.listeners = [
      [window, 'keydown', (event) => this.onKeyDown(event)],
      [window, 'keyup', (event) => this.onKeyUp(event)],
      [window, 'blur', () => this.machine?.keyboard.releaseAll()],
      [window, 'beforeunload', (event) => this.warnUnsaved(event)],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('pc--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.root, 'pointerdown', () => this.startAudio()],
      [this.canvas, 'dblclick', () => this.toggleFullscreen()],
      [this.root, 'mousemove', (event) => this.onPointerHover(event)],
      [document, 'fullscreenchange', () => this.onFullscreenChange()],
      [document, 'webkitfullscreenchange', () => this.onFullscreenChange()],
    ];
    for (const [target, type, handler] of this.listeners) {
      target.addEventListener(type, handler);
    }
  }

  // ------------------------------------------------------------------- boot

  async start() {
    this.setStatus('Caricamento del BIOS…');
    let bios;
    try {
      bios = await loadBIOS();
    } catch (error) {
      if (error instanceof MissingBIOSError) {
        this.showROMPrompt();
        return;
      }
      throw error;
    }

    this.bios = bios; // se la scheda del disco arriva dopo, la macchina si rifà
    const [card, videoROM, floppy, disk] = await Promise.all([
      loadCardROM(),
      loadVideoROM(),
      loadFloppy(),
      loadHardDisk(),
    ]);
    this.card = card;
    this.videoROM = videoROM;
    // La tastiera scelta l'ultima volta va nell'AUTOEXEC prima di accendere,
    // così la macchina parte già con quella. Non conta come una scrittura da
    // salvare: è la scelta di chi usa la pagina, e si riscrive a ogni visita.
    setLayout(disk.data, preferredLayout());

    try {
      this.sound = new AudioOutput();
    } catch {
      this.sound = null; // un browser senza audio: la macchina va lo stesso
    }

    this.machine = this.buildMachine(disk);
    if (floppy) this.insertFloppy(floppy, 'FreeDOS');
    this.savedDiskWrites = 0;
    await this.mountPending();

    this.overlay.replaceChildren();
    this.root.focus();
    this.updateDrives();
    this.setStatus('Accensione…');
    if (!card) this.showCardPrompt();

    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
  }

  /**
   * La macchina con le schede che ci sono: la VGA se c'è il suo BIOS, se no la
   * CGA, e la scheda del disco se c'è la sua ROM. La Sound Blaster non ha ROM, e
   * c'è sempre; le si dice solo a che velocità vuole i campioni chi ascolta.
   *
   * @param {?object} disk
   */
  buildMachine(disk) {
    const cards = [];
    if (this.card) cards.push({ base: CARD_ROM_BASE, bytes: this.card });
    if (this.videoROM) cards.push({ base: VIDEO_ROM_BASE, bytes: this.videoROM });
    const machine = new PC(this.bios, { disk, cards, vga: Boolean(this.videoROM) });
    if (this.sound) machine.sound.setSampleRate(this.sound.sampleRate);
    return machine;
  }

  /**
   * Quello che si vede arrivando sulla pagina senza le ROM, che è il caso
   * normale: nessun firmware viaggia con questo sito. Per fortuna qui, a
   * differenza del C64 e dell'Amiga, tutto quello che serve è libero e si
   * scarica — e quindi la pagina può dire esattamente dove.
   */
  showROMPrompt() {
    const panel = element('div', 'pc__panel');
    panel.innerHTML = `
      <h2>Trascina qui il BIOS</h2>
      <p>alloldos non imita un PC: ne esegue il firmware. La differenza è che
      questa macchina, unica delle tre, ha un firmware <b>libero</b> — nessuno
      deve andare a cercare una ROM di IBM. Servono otto KB di
      <a href="${GLABIOS_URL}" target="_blank" rel="noopener noreferrer">GLaBIOS</a>,
      un BIOS PC scritto da zero in GPL che gira anche sulle macchine vere:
      <b>trascina il file sulla finestra</b> e resta salvato in questo browser.</p>
      <ul>
        <li><a href="${GLABIOS_SOURCE_URL}" target="_blank" rel="noopener noreferrer">${BIOS_SPEC.file}</a>
        — il BIOS di sistema (${BIOS_SPEC.size} byte), obbligatorio</li>
        <li><a href="${XTIDE_SOURCE_URL}" target="_blank" rel="noopener noreferrer">${CARD_SPEC.file}</a>
        — la <a href="${XTIDE_URL}" target="_blank" rel="noopener noreferrer">XTIDE Universal BIOS</a>,
        cioè la ROM della scheda del disco fisso: senza non c'è nessun C:, e il
        DOS sta lì sopra — quindi serve anche questa</li>
        <li><a href="${VIDEO_DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">${VIDEO_SPEC.file}</a>
        — il ${VIDEO_SPEC.label} compilato per il 286, la ROM della scheda
        <b>VGA</b>: senza, la macchina monta una CGA, che il BIOS di sistema sa
        accendere da solo</li>
        <li>un dischetto avviabile, se ti va:
        <a href="${FREEDOS_SPEC.source}" target="_blank" rel="noopener noreferrer">lo zip di FreeDOS</a>
        si trascina qui così com'è, e la macchina ci trova dentro il dischetto
        da 720 KB — ma non serve per accendere, perché il DOS sta già sul disco
        fisso</li>
        <li>e un'<b>immagine di disco fisso</b>, se ne hai una: va nella scheda
        al posto di quella che c'è, grande quanto è, con la geometria letta
        dalla sua tabella delle partizioni</li>
      </ul>
    `;

    const pick = element('button', 'pc__button');
    pick.type = 'button';
    pick.textContent = 'Scegli i file…';
    pick.addEventListener('click', () => this.pickFile());
    panel.append(pick);

    const notes = element('div', 'pc__panel-note');
    notes.innerHTML = `
      <p>I file si riconoscono dal contenuto, quindi il nome non conta. Se hai
      clonato il repository basta <code>npm run fetch-roms</code>. Il disco
      fisso invece viaggia con alloldos: venti mega con FreeDOS già installato
      sopra — installato dalla macchina stessa, con FDISK e FORMAT veri — e la
      macchina si accende lì, su <code>C:\></code>.</p>
      <p>Niente di tutto questo esce dal tuo browser: alloldos non ha un server
      a cui mandarlo.</p>
    `;
    panel.append(notes);

    this.overlay.replaceChildren(panel);
    this.setStatus('Serve il BIOS — trascinalo sulla finestra');
  }

  /**
   * Il BIOS c'è, la macchina è accesa, e la scheda del disco no. Prima era una
   * mancanza da poco — si partiva dal dischetto — e bastava scriverlo nella
   * barra in fondo, che è il posto dove non si guarda. Da quando il DOS sta sul
   * disco fisso è invece la differenza fra una macchina e un cartello che dice
   * che non c'è niente da cui partire, e quindi lo si chiede in faccia, come si
   * chiede il BIOS. Chiesto, non preteso: si può sempre andare avanti senza, e
   * accendere un PC senza disco fisso nel 1988 era la normalità.
   */
  showCardPrompt() {
    const panel = element('div', 'pc__panel');
    panel.innerHTML = `
      <h2>Manca la scheda del disco fisso</h2>
      <p>Il BIOS c'è, e la macchina è accesa. Ma un BIOS XT non sa cosa sia un
      disco fisso — nel 1981 il disco fisso non c'era — e chi lo sa è la
      <b>scheda</b>, che se lo porta dietro in una ROM da dodici KB. Senza
      quella non esiste nessun <code>C:</code>, e su <code>C:</code> c'è il DOS:
      venti mega con FreeDOS già installato sopra, che alloldos si porta dietro
      e che sono l'unico modo che questa macchina ha di arrivare a un prompt
      senza un dischetto.</p>
      <ul>
        <li><a href="${XTIDE_SOURCE_URL}" target="_blank" rel="noopener noreferrer">${CARD_SPEC.file}</a>
        — la <a href="${XTIDE_URL}" target="_blank" rel="noopener noreferrer">XTIDE Universal BIOS</a>
        (GPLv2), dieci KB: <b>trascinala sulla finestra</b> come hai fatto col
        BIOS, e resta salvata in questo browser</li>
      </ul>
    `;

    const pick = element('button', 'pc__button');
    pick.type = 'button';
    pick.textContent = 'Scegli il file…';
    pick.addEventListener('click', () => this.pickFile());

    const skip = element('button', 'pc__button');
    skip.type = 'button';
    skip.textContent = 'Accendi lo stesso';
    skip.addEventListener('click', () => {
      this.overlay.replaceChildren();
      this.root.focus();
      this.setStatus('Senza disco fisso: da qui si parte solo con un dischetto in A:');
    });
    panel.append(pick, skip);

    const note = element('div', 'pc__panel-note');
    note.innerHTML = `
      <p>Non serve ricaricare niente: appena arriva, la macchina si rifà da
      capo e riparte — una ROM di scheda si aggancia solo all'accensione.</p>
    `;
    panel.append(note);

    this.overlay.replaceChildren(panel);
    this.setStatus(`Manca ${CARD_SPEC.file}: senza, niente C: — e il DOS sta lì`);
  }

  // ------------------------------------------------------------------- loop

  tick(time) {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame((next) => this.tick(next));

    const elapsed = Math.min(time - this.lastTime, 250);
    this.lastTime = time;
    if (this.paused) return;

    this.frameDebt += (elapsed / 1000) * FPS;
    const frames = Math.min(Math.floor(this.frameDebt), MAX_CATCHUP_FRAMES);
    this.frameDebt -= frames;
    if (frames === 0) return;

    for (let i = 0; i < frames; i++) this.machine.runFrame();

    this.playSound();
    this.present();
    this.updateDrives();
    this.offerModifiedFloppy();
  }

  /**
   * I campioni che la Sound Blaster ha fatto in questi quadri, verso il
   * worklet. Si prendono sempre, anche quando non si mandano: se il browser è
   * già avanti di un decimo di secondo quelli in più si buttano, perché un
   * suono in ritardo è peggio di un suono con un buco.
   */
  playSound() {
    const samples = this.machine.sound.takeSamples();
    if (!this.sound?.node) return;
    if (this.sound.available > this.sound.sampleRate * 0.1) return;
    this.sound.push(samples);
  }

  present() {
    const video = this.machine.video;
    const pixels = video.render();
    const width = video.renderWidth ?? SCREEN_WIDTH;
    const height = video.renderHeight ?? SCREEN_HEIGHT;
    if (width !== this.canvas.width || height !== this.canvas.height) this.resizeImage(width, height);
    if (pixels.length === this.imageWords.length) this.imageWords.set(pixels);
    this.context.putImageData(this.image, 0, 0);
  }

  // ------------------------------------------------------------------ dischi

  updateDrives() {
    if (!this.machine) return;
    const floppy = this.machine.fdc.drives[0];
    this.floppyRow.light.classList.toggle('pc__light--on', this.machine.fdc.motorOn);
    this.floppyRow.text.textContent = floppy.medium
      ? `${this.floppyName || 'dischetto'} — ${floppy.format.label}` +
        (floppy.writeProtected ? ', protetto' : '')
      : 'vuoto';

    const disk = this.machine.hdc.disk;
    const busy = disk && disk.writes !== this.lastDiskWrites;
    this.lastDiskWrites = disk?.writes ?? 0;
    this.diskRow.light.classList.toggle('pc__light--on', Boolean(busy));
    this.diskRow.text.textContent = disk
      ? `${megabytes(disk)} MB${this.diskName ? ` — ${this.diskName}` : ''}${
          disk.writes ? ` — ${disk.writes} settori scritti` : ''
        }`
      : 'nessuna scheda';
  }

  insertFloppy(bytes, name) {
    const format = formatOf(bytes);
    if (!format) {
      this.setStatus('Non è un\'immagine di dischetto che questo lettore sappia leggere');
      return false;
    }
    this.machine.fdc.drives[0].insert(bytes);
    this.floppyName = name.replace(/\.(img|ima)$/i, '');
    this.seenFloppyWrites = 0;
    this.savedFloppyWrites = 0;
    this.quietAt = 0;
    this.updateDrives();
    this.setStatus(`${this.floppyName} in A: (${format.label}) — Reset per avviarlo`);
    return true;
  }

  /**
   * Un'immagine di disco fisso che arriva da fuori, infilata nella scheda al
   * posto di quella che c'era. Sul dischetto è un gesto da un secondo; qui è
   * il gesto di spegnere, cambiare la scheda CompactFlash e riaccendere, e
   * costa le tre cose che lo distinguono dall'infilare un dischetto:
   *
   *  - la geometria. Un dischetto si riconosce dalla lunghezza e basta; un
   *    disco no, e quella sbagliata non dà un errore, dà un disco illeggibile.
   *    Si va a leggerla dentro la tabella delle partizioni.
   *  - la misura. Il disco che entra è grande quanto è grande, e non si taglia
   *    per farlo entrare nei venti mega di prima.
   *  - l'accensione. Chi si è segnato la geometria è il BIOS della scheda, e
   *    l'ha chiesta al POST: finché la macchina non riparte, il DOS continua a
   *    chiedere i settori del disco di prima.
   *
   * E prima di tutto questo, quello che c'era e non è stato salvato torna
   * indietro come file: un disco che esce dalla scheda non ha nessun posto in
   * cui aspettare.
   *
   * @param {Uint8Array} bytes
   * @param {string} name
   * @returns {boolean}
   */
  mountHardDisk(bytes, name) {
    const disk = hardDiskFrom(bytes);
    if (disk.sectorCount < 2) {
      this.setStatus('Quell\'immagine è troppo corta per essere un disco');
      return false;
    }

    const leaving = this.machine.hdc.disk;
    const rescued = leaving && leaving.writes !== this.savedDiskWrites ? this.saveHardDisk() : '';

    this.machine.hdc.attach(disk);
    this.diskName = name.replace(/\.(img|ima|hdd|dsk|raw)$/i, '');
    this.savedDiskWrites = 0;
    this.lastDiskWrites = 0;
    // Un disco che arriva da fuori ha la sua tastiera, e non gliela si cambia
    // senza che nessuno l'abbia chiesto: la tendina dice quella che ha lui.
    const layout = layoutOf(disk.data);
    if (layoutNamed(layout)) this.layoutSelect.value = layout;
    // Il POST da capo, che è l'unico momento in cui la ROM della scheda va a
    // chiedere al disco chi è: senza, C: resterebbe quello di prima.
    this.machine.reset();
    this.updateDrives();

    const g = disk.geometry;
    const where = this.machine.fdc.drives[0].medium
      ? 'ma in A: c\'è ancora un dischetto, e la macchina parte da quello'
      : 'la macchina riparte da lì';
    this.setStatus(
      [
        `${this.diskName || 'disco'} in C: — ${megabytes(disk)} MB,` +
          ` ${g.cylinders}/${g.heads}/${g.sectors}, ${where}`,
        this.card ? '' : `senza ${CARD_SPEC.file} però il DOS non lo vedrà`,
        rescued,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    return true;
  }

  /**
   * Il dischetto scritto torna indietro come file, quando il lettore è stato
   * fermo abbastanza a lungo da far pensare che il salvataggio sia finito.
   */
  offerModifiedFloppy() {
    const drive = this.machine.fdc.drives[0];
    if (!drive.medium) return;
    if (drive.writes !== this.seenFloppyWrites) {
      this.seenFloppyWrites = drive.writes;
      this.quietAt = performance.now() + SAVE_QUIET_MS;
      return;
    }
    if (!this.quietAt || performance.now() < this.quietAt) return;
    this.quietAt = 0;
    this.saveFloppy(true);
  }

  saveFloppy(automatic = false) {
    const drive = this.machine?.fdc.drives[0];
    if (!drive?.medium) {
      this.setStatus('Non c\'è nessun dischetto in A:');
      return;
    }
    if (automatic && drive.writes === this.savedFloppyWrites) return;
    const name = `${this.floppyName || 'dischetto'} ${timestamp()}.img`;
    download(this.root, name, drive.medium);
    this.savedFloppyWrites = drive.writes;
    storeFloppy(drive.medium);
    this.setStatus(
      automatic
        ? `A: è stato scritto: scaricato «${name}» — ritrascinalo qui la prossima volta`
        : `Scaricato «${name}»`,
    );
  }

  /**
   * Il disco fisso sono venti mega, e non ci stanno nel deposito del browser:
   * se lo si vuole conservare bisogna portarselo via come file, e rimetterlo
   * dentro trascinandolo la volta dopo.
   */
  saveHardDisk() {
    const disk = this.machine?.hdc.disk;
    if (!disk) {
      this.setStatus('Non c\'è nessuna scheda con un disco');
      return '';
    }
    const name = `${this.diskName || 'disco fisso'} ${timestamp()}.img`;
    download(this.root, name, disk.data);
    this.savedDiskWrites = disk.writes;
    const said = `Scaricato «${name}» — ${megabytes(disk)} MB, rimettilo qui la prossima volta`;
    this.setStatus(said);
    return said;
  }

  /** Andarsene con un disco scritto e non salvato vuol dire perderlo. */
  warnUnsaved(event) {
    const disk = this.machine?.hdc.disk;
    const floppy = this.machine?.fdc.drives[0];
    const unsaved =
      (disk && disk.writes !== this.savedDiskWrites) ||
      (floppy?.medium && floppy.writes !== this.savedFloppyWrites);
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '';
  }

  // ---------------------------------------------------------------- comandi

  resetMachine() {
    this.machine.reset();
    this.setStatus('Reset');
  }

  /**
   * Un'altra tastiera: la riga di KEYB nell'AUTOEXEC.BAT cambia, e la macchina
   * si riaccende, perché l'AUTOEXEC il DOS lo legge una volta sola. È quello
   * che si faceva allora, con EDIT e poi Ctrl-Alt-Canc.
   *
   * @param {string} id
   */
  chooseLayout(id) {
    const layout = layoutNamed(id);
    if (!layout) return;
    storePreferredLayout(id);
    const disk = this.machine?.hdc.disk;
    if (!disk) {
      this.setStatus(`Tastiera ${layout.name}: la carica KEYB, che sta sul disco fisso — e qui non c'è`);
      return;
    }
    const result = setLayout(disk.data, id);
    if (result.missing === 'filesystem') {
      this.setStatus('Su C: non c\'è nessun filesystem: KEYB, che sceglie la tastiera, non ha dove stare');
      return;
    }
    if (result.missing === 'keyb') {
      this.setStatus('Su questo disco non c\'è KEYB: resta la tastiera americana, quella del BIOS');
      return;
    }
    if (!result.changed) {
      this.setStatus(`Tastiera ${layout.name}: è già quella`);
      return;
    }
    this.machine.reset();
    this.setStatus(
      id === DEFAULT_LAYOUT
        ? 'Tastiera americana: KEYB tolto dall\'AUTOEXEC.BAT — riaccensione'
        : `Tastiera ${layout.name}: KEYB ${id.toUpperCase()} nell'AUTOEXEC.BAT — riaccensione`,
    );
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? 'Riprendi' : 'Pausa';
    this.setStatus(this.paused ? 'In pausa' : 'In esecuzione');
  }

  toggleMute() {
    if (!this.sound) {
      this.setStatus('Questo browser non ha voluto darci l\'audio');
      return;
    }
    const muted = !this.sound.muted;
    this.sound.setMuted(muted);
    this.muteButton.textContent = muted ? 'Audio off' : 'Audio on';
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  // ------------------------------------------------------------- file e ROM

  pickFile() {
    this.fileInput.click();
  }

  onDragOver(event) {
    event.preventDefault();
    this.root.classList.add('pc--dropping');
  }

  onDrop(event) {
    event.preventDefault();
    this.root.classList.remove('pc--dropping');
    this.acceptFiles([...(event.dataTransfer?.files ?? [])]);
  }

  /**
   * Quello che qualcuno ha lasciato cadere sulla finestra, tutto insieme.
   *
   * Si guardano prima le ROM e poi i dischi, e non nell'ordine in cui il
   * browser consegna i file: chi trascina il BIOS e il dischetto in un colpo
   * solo si aspetta che la macchina si accenda con dentro il dischetto, non
   * che il secondo file sparisca perché il primo ha già acceso tutto. E un
   * dischetto arrivato prima del BIOS non si butta: si mette da parte, e ci
   * si torna appena c'è un lettore in cui infilarlo.
   */
  async acceptFiles(files) {
    let bios = false;
    let card = false;
    let video = false;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Lo zip dell'edizione a dischetti di FreeDOS, che è la sola forma in cui
      // il progetto lo pubblica: dentro c'è il dischetto da 720 KB, e si infila
      // quello invece di copiare lo zip sul disco fisso.
      if (isZip(bytes)) {
        const wanted = FREEDOS_SPEC.member.toUpperCase();
        const entry = (await readZip(bytes).catch(() => [])).find(({ path }) => path.toUpperCase() === wanted);
        if (entry) {
          this.pending.push({ bytes: entry.bytes, name: 'FreeDOS', kind: 'floppy' });
          continue;
        }
      }
      const image = classifyImage(bytes);
      if (image) {
        this.pending.push({ bytes, name: file.name, ...image });
        continue;
      }
      const kind = acceptROMFile(bytes);
      if (kind === 'bios') {
        bios = true;
        continue;
      }
      if (kind === 'card') {
        card = true;
        continue;
      }
      if (kind === 'video') {
        video = true;
        continue;
      }
      if (kind === 'video386') {
        // Il VGABIOS come lo pubblica il progetto: si presenta come una ROM
        // video, ma è codice da 386 e il 286 si fermerebbe al primo salto.
        this.setStatus(`«${file.name}» è il VGABIOS compilato per il 386: su questo processore non parte — serve ${VIDEO_SPEC.file}, compilato per il 286`);
        continue;
      }
      // Non è una ROM e non è un disco: allora è roba da mettere dentro la
      // macchina, e la macchina ha un posto dove metterla.
      this.pending.push({ bytes, name: file.name, kind: 'file' });
    }

    if (bios && !this.machine) {
      this.setStatus('BIOS salvato — accensione…');
      this.overlay.replaceChildren();
      await this.start();
      return;
    }
    if ((card || video) && this.machine) await this.mountCardROM();
    await this.mountPending();
  }

  /**
   * La ROM di una scheda arrivata a macchina accesa — quella del disco o
   * quella della VGA. Su una macchina vera si spegne, si infila la scheda
   * nello zoccolo e si riaccende: una ROM di espansione la si aggancia solo al
   * POST, e a metà strada non serve a niente. Qui è la stessa cosa, e costa
   * quanto un'accensione — il disco resta quello di prima, con sopra quello
   * che ci fosse, e il dischetto resta nel lettore.
   *
   * @returns {Promise<boolean>}
   */
  async mountCardROM() {
    const [card, videoROM] = await Promise.all([loadCardROM(), loadVideoROM()]);
    const newCard = card && !this.card;
    const newVideo = videoROM && !this.videoROM;
    if (!newCard && !newVideo) return false;
    this.card = card;
    this.videoROM = videoROM;
    const floppy = this.machine.fdc.drives[0].medium;
    this.machine = this.buildMachine(this.machine.hdc.disk);
    if (floppy) this.machine.fdc.drives[0].insert(floppy);
    this.overlay.replaceChildren();
    this.root.focus();
    this.updateDrives();
    this.setStatus(
      newCard
        ? 'Scheda del disco fisso montata — la macchina riparte, e adesso C: c\'è'
        : 'Scheda VGA montata al posto della CGA — la macchina riparte',
    );
    return true;
  }

  /**
   * I dischi messi da parte finiscono dentro la macchina appena ce n'è una.
   * Finché non c'è, restano dove sono: il BIOS può sempre arrivare dopo.
   */
  async mountPending() {
    if (!this.machine) {
      if (this.pending.length) {
        this.setStatus('Prima serve il BIOS: quello che hai trascinato aspetta qui');
      }
      return;
    }
    const loose = [];
    for (const { bytes, name, kind } of this.pending.splice(0)) {
      if (kind === 'floppy') {
        if (this.insertFloppy(bytes, name)) storeFloppy(bytes);
        continue;
      }
      if (kind === 'file') {
        loose.push({ bytes, name });
        continue;
      }
      this.mountHardDisk(bytes, name);
    }
    if (loose.length) await this.loadFiles(loose);
  }

  /**
   * I file che non sono né ROM né dischi finiscono sul disco fisso, in
   * `C:\SCARICATI` — e se sono zip ci finiscono aperti, in una cartella che
   * si chiama come l'archivio. Poi la macchina si riaccende, perché il DOS la
   * FAT se l'è letta all'avvio e non ha nessuna intenzione di rileggerla.
   *
   * @param {{bytes:Uint8Array, name:string}[]} files
   */
  async loadFiles(files) {
    const disk = this.machine.hdc.disk;
    if (!disk) {
      this.setStatus('Non c\'è nessun disco fisso su cui metterlo');
      return;
    }

    const done = [];
    const failed = [];
    for (const { bytes, name } of files) {
      try {
        const written = await loadIntoDisk(disk, name, bytes);
        done.push(
          written.zip
            ? `«${name}» aperto in ${written.folder} (${written.names.length} file)`
            : `«${name}» copiato in ${written.folder}\\${written.names[0]}`,
        );
      } catch (error) {
        failed.push(`«${name}»: ${explain(error)}`);
      }
    }

    if (!done.length) {
      this.setStatus(failed.join(' · '));
      return;
    }
    this.updateDrives();
    this.machine.reset();
    this.setStatus(
      [`${done.join(' · ')} — riaccensione, perché il DOS lo veda`, ...failed].join(' · '),
    );
  }

  // -------------------------------------------------------------- schermo intero

  get fullscreenElement() {
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  get isFullscreen() {
    return this.fullscreenElement === this.root;
  }

  showControls(hideAfter = 0) {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.add('pc--controls-shown');
    if (!hideAfter) return;
    this.controlsTimer = setTimeout(() => this.hideControls(), hideAfter);
    this.controlsTimer?.unref?.();
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.remove('pc--controls-shown');
  }

  onPointerHover(event) {
    if (!this.isFullscreen) return;
    const height = window.innerHeight ?? 0;
    if (height && event.clientY >= height - CONTROLS_EDGE) this.showControls();
    else if (!this.controlsTimer) this.hideControls();
  }

  toggleFullscreen() {
    if (this.fullscreenElement) {
      const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
      Promise.resolve(exit?.call(document)).catch(() => {});
      return;
    }
    const request = this.root.requestFullscreen ?? this.root.webkitRequestFullscreen;
    if (!request) {
      this.setStatus('Questo browser non sa mettere una pagina a schermo intero');
      return;
    }
    Promise.resolve(request.call(this.root)).catch(() =>
      this.setStatus('Schermo intero rifiutato dal browser'),
    );
  }

  onFullscreenChange() {
    const full = this.isFullscreen;
    this.fullscreenButton.textContent = full ? 'Finestra' : 'Schermo intero';
    this.root.classList.toggle('pc--fullscreen', full);
    if (full) this.showControls(CONTROLS_FLASH);
    else this.hideControls();
    this.root.focus();
  }

  // --------------------------------------------------------------- tastiera

  onKeyDown(event) {
    if (!this.machine || event.metaKey) return;
    if (event.code === 'F9') {
      event.preventDefault();
      this.resetMachine();
      return;
    }
    if (event.code === 'F11') {
      event.preventDefault();
      this.pickFile();
      return;
    }
    const code = SCANCODES[event.code];
    if (code === undefined) return;
    event.preventDefault();
    this.startAudio();
    // Windows, quando si preme AltGr, manda prima un Ctrl di sinistra che
    // nessuno ha premuto, nello stesso istante. Arrivato fin qui diventerebbe
    // un Ctrl-AltGr, che per KEYB non è la stessa cosa: lo si lascia andare.
    if (
      event.code === 'AltRight' &&
      this.controlAt &&
      event.timeStamp - this.controlAt < 50 &&
      event.getModifierState?.('AltGraph')
    ) {
      this.machine.keyboard.release(SCANCODES.ControlLeft);
    }
    this.controlAt = event.code === 'ControlLeft' ? event.timeStamp : 0;
    this.machine.keyboard.press(code);
  }

  onKeyUp(event) {
    if (!this.machine) return;
    const code = SCANCODES[event.code];
    if (code === undefined) return;
    event.preventDefault();
    this.machine.keyboard.release(code);
  }

  /** L'audio si accende al primo gesto, che è quello che vogliono i browser. */
  startAudio() {
    Promise.resolve(this.sound?.start()).catch(() => {});
  }

  // ------------------------------------------------------------------ chiusura

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.controlsTimer);
    for (const [target, type, handler] of this.listeners ?? []) {
      target.removeEventListener(type, handler);
    }
    this.sound?.close();
    this.root.remove();
  }
}

/**
 * Perché un file non è entrato, detto a chi l'ha trascinato e non a chi ha
 * scritto il codice.
 */
function explain(error) {
  if (error instanceof NoFilesystemError) {
    return 'su C: non c\'è nessun filesystem — prima FDISK e FORMAT C:';
  }
  if (error instanceof FullDiskError) {
    const mega = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `sul disco non c'è più posto: ne servono ${mega(error.needed)} e ne restano ${mega(error.free)}`;
  }
  if (error instanceof FullDirectoryError) return 'la cartella principale del disco è piena';
  if (error instanceof UnreadableZipError) return error.message;
  return error.message;
}

/** La misura di un disco come la direbbe chi l'ha comprato: in mega, tonda. */
function megabytes(disk) {
  return (disk.data.length / 1024 / 1024).toFixed(0);
}

/** Quando è successo, per dare un nome a un file di cui se ne avranno tanti. */
function timestamp() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}.${two(now.getMinutes())}`
  );
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function download(root, filename, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = element('a', 'pc__download');
  link.href = url;
  link.download = filename;
  root.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Accende la macchina dentro `container`.
 * @returns {Promise<{dispose():void}>}
 */
export async function boot(container, options) {
  const session = new PCSession(container, options);
  await session.start();
  return session;
}
