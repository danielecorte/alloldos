// Il PC 386 come lo vede alloldos: accenderlo, mettergli la sua immagine su una
// canvas, dargli tastiera e mouse, e lasciargli infilare dentro i dischi.
//
// La scheda è quella del Pentium qui accanto — i chip sono gli stessi, con gli
// stessi indirizzi, dal 1984 in poi — con sopra un 386 a trentatré milioni di
// cicli e otto mega di memoria, e il BIOS di Bochs al posto di SeaBIOS, perché
// SeaBIOS su un 386 non parte. È la macchina su cui è uscito Windows 3.1.

import { Pentium, FPS } from '../pentium/machine.js';
import { SCANCODES, scanBytes } from '../pc/scancodes.js';
import { loadHardDisk, hardDiskFrom, classifyImage } from '../pc/media.js';
import { formatOf } from '../pc/fdc.js';
import {
  loadIntoDisk,
  NoFilesystemError,
  FullDiskError,
  FullDirectoryError,
  UnreadableZipError,
} from '../pc/files.js';
import {
  LAYOUTS,
  DEFAULT_LAYOUT,
  layoutNamed,
  layoutOf,
  setLayout,
  preferredLayout,
  storePreferredLayout,
} from '../pc/layouts.js';
import {
  loadBIOS,
  loadVideoROM,
  acceptROMFile,
  MissingBIOSError,
  BIOS_SPEC,
  VIDEO_SPEC,
  VIDEO_ROM_BASE,
  BOCHS_URL,
  VGABIOS_URL,
  BOCHS_RELEASE_URL,
} from './roms.js';

/** Il 386DX a trentatré megahertz, e la memoria di una macchina da lavoro del 1990. */
export const CLOCK = 33000000;
export const RAM = 8 * 1024 * 1024;

const MAX_CATCHUP_FRAMES = 4;

/** La striscia in fondo che richiama la barra, e quanto resta in vista da sé. */
const CONTROLS_EDGE = 60;
const CONTROLS_FLASH = 2500;

/**
 * Accende la macchina con i suoi pezzi. È una funzione a parte perché la usano
 * sia la pagina sia le prove: il 386 è la scheda del Pentium con un altro
 * processore, un altro BIOS e la ROM video affacciata dove la cerca un BIOS di
 * allora.
 *
 * @param {Uint8Array} bios
 * @param {object} [options]
 * @param {?Uint8Array} [options.video]
 * @param {?object} [options.disk]
 * @param {?Uint8Array} [options.floppy]
 */
export function build386(bios, { video = null, disk = null, floppy = null } = {}) {
  const machine = new Pentium(bios, {
    model: 386,
    clock: CLOCK,
    ram: RAM,
    cards: video ? [{ base: VIDEO_ROM_BASE, bytes: video }] : [],
    disk,
    floppy,
  });
  declareFloppyDrive(machine);
  return machine;
}

/**
 * Il lettore da 1,44 MB c'è sempre, anche vuoto: sulla scheda del Pentium la
 * macchina dichiara il lettore solo se c'è un dischetto, per risparmiare a
 * SeaBIOS cinque secondi, ma su un 386 del 1990 il lettore era avvitato nel
 * case. E il DOS conta i lettori una volta sola, all'accensione: se non ci
 * fosse, un dischetto infilato dopo non avrebbe nessun A: in cui comparire.
 */
function declareFloppyDrive(machine) {
  if ((machine.cmos.bytes[0x10] & 0xf0) === 0) machine.cmos.bytes[0x10] = 0x40;
  machine.cmos.bytes[0x14] |= 0x01;
}

class PC386Session {
  constructor(container, options) {
    this.container = container;
    this.onExit = options.onExit;
    this.machine = null;
    this.running = false;
    this.paused = false;
    this.rafHandle = 0;
    this.lastTime = 0;
    this.frameDebt = 0;
    this.floppyName = '';
    this.diskName = '';
    this.savedDiskWrites = 0;
    this.savedFloppyWrites = 0;
    /** Il mouse: quanto si è mosso dall'ultimo pacchetto, e i tasti. */
    this.mouse = { dx: 0, dy: 0, buttons: 0, sent: 0 };
    this.pending = [];
    this.build();
  }

  // --------------------------------------------------------------------- DOM

  build() {
    this.root = element('div', 'pc');
    this.root.tabIndex = 0;

    const stage = element('div', 'pc__stage');
    this.canvas = element('canvas', 'pc__canvas');
    this.canvas.width = 720;
    this.canvas.height = 400;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.resizeImage(720, 400);
    stage.append(this.canvas);

    this.overlay = element('div', 'pc__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'pc__bar');
    this.status = element('span', 'pc__status');
    this.bar.append(
      this.button('Carica un file', () => this.pickFile()),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.layoutPicker(),
      this.button('Togli il dischetto', () => this.ejectFloppy()),
      this.button('Salva il dischetto', () => this.saveFloppy()),
      this.button('Salva il disco fisso', () => this.saveHardDisk()),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    this.drives = element('div', 'pc__drives');
    this.floppyRow = this.driveRow('A:', 'vuoto');
    this.diskRow = this.driveRow('C:', 'disco fisso');
    this.drives.append(this.floppyRow.row, this.diskRow.row);

    this.fileInput = element('input', 'pc__file');
    this.fileInput.type = 'file';
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

  button(label, action) {
    const node = element('button', 'pc__button');
    node.type = 'button';
    node.tabIndex = -1;
    node.textContent = label;
    node.addEventListener('click', (event) => {
      event.preventDefault();
      action();
      this.root.focus();
    });
    return node;
  }

  /** La tastiera che si ha sotto le dita: la scelta finisce nell'AUTOEXEC.BAT. */
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
      this.root.focus();
    });
    return this.layoutSelect;
  }

  bindEvents() {
    this.listeners = [
      [window, 'keydown', (event) => this.onKeyDown(event)],
      [window, 'keyup', (event) => this.onKeyUp(event)],
      [window, 'blur', () => this.releaseKeys()],
      [window, 'beforeunload', (event) => this.warnUnsaved(event)],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('pc--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.canvas, 'click', () => this.capturePointer()],
      [this.canvas, 'dblclick', () => this.toggleFullscreen()],
      [document, 'mousemove', (event) => this.onMouseMove(event)],
      [document, 'mousedown', (event) => this.onMouseButton(event, true)],
      [document, 'mouseup', (event) => this.onMouseButton(event, false)],
      [document, 'pointerlockchange', () => this.onPointerLockChange()],
      [this.root, 'mousemove', (event) => this.onPointerHover(event)],
      [document, 'fullscreenchange', () => this.onFullscreenChange()],
      [document, 'webkitfullscreenchange', () => this.onFullscreenChange()],
    ];
    for (const [target, type, handler] of this.listeners) target.addEventListener(type, handler);
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
    this.bios = bios;
    const [video, disk] = await Promise.all([loadVideoROM(), loadHardDisk()]);
    this.video = video;
    setLayout(disk.data, preferredLayout());
    this.machine = build386(bios, { video, disk });
    this.savedDiskWrites = 0;
    await this.mountPending();

    this.overlay.replaceChildren();
    this.root.focus();
    this.updateDrives();
    this.setStatus(video ? 'Accensione…' : `Manca ${VIDEO_SPEC.file}: la macchina parte, ma non ha niente su cui scrivere`);
    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
  }

  showROMPrompt() {
    const panel = element('div', 'pc__panel');
    panel.innerHTML = `
      <h2>Trascina qui il BIOS di Bochs</h2>
      <p>alloldos non imita un PC: ne esegue il firmware. Per un 386 il BIOS
      libero è quello di <a href="${BOCHS_URL}" target="_blank" rel="noopener noreferrer">Bochs</a>
      (LGPL), nella versione «legacy», tutta a sedici bit: SeaBIOS, quello del
      Pentium, su un 386 non parte. Servono due file, e stanno già compilati
      <a href="${BOCHS_RELEASE_URL}" target="_blank" rel="noopener noreferrer">nel repository di Bochs</a>:
      <b>trascinali sulla finestra</b> e restano salvati in questo browser.</p>
      <ul>
        <li><code>BIOS-bochs-legacy</code> — il BIOS di sistema, 64 KB, obbligatorio</li>
        <li><code>VGABIOS-lgpl-latest</code> — il
        <a href="${VGABIOS_URL}" target="_blank" rel="noopener noreferrer">VGABIOS LGPL</a>,
        il BIOS della scheda video: senza la macchina parte ma lo schermo resta nero</li>
      </ul>
    `;
    const pick = element('button', 'pc__button');
    pick.type = 'button';
    pick.textContent = 'Scegli i file…';
    pick.addEventListener('click', () => this.pickFile());
    panel.append(pick);
    const note = element('div', 'pc__panel-note');
    note.innerHTML = `<p>I file si riconoscono dal contenuto, quindi il nome non conta. Se
      hai clonato il repository basta <code>npm run fetch-roms</code>. Il disco fisso
      con FreeDOS è lo stesso del 286, e viaggia con alloldos.</p>`;
    panel.append(note);
    this.overlay.replaceChildren(panel);
    this.setStatus(`Serve ${BIOS_SPEC.label} — trascinalo sulla finestra`);
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
    for (let i = 0; i < frames; i++) {
      this.sendMouse();
      this.machine.runFrame();
    }
    this.present();
    this.updateDrives();
  }

  present() {
    const video = this.machine.video;
    const pixels = video.render();
    const width = video.renderWidth ?? video.width;
    const height = video.renderHeight ?? video.height;
    if (width !== this.canvas.width || height !== this.canvas.height) this.resizeImage(width, height);
    if (pixels.length === this.imageWords.length) this.imageWords.set(pixels);
    this.context.putImageData(this.image, 0, 0);
  }

  // ------------------------------------------------------------------ dischi

  updateDrives() {
    if (!this.machine) return;
    const drive = this.machine.floppy.drives[0];
    this.floppyRow.light.classList.toggle('pc__light--on', this.machine.floppy.motorOn);
    this.floppyRow.text.textContent = drive.medium
      ? `${this.floppyName || 'dischetto'} — ${drive.format.label}`
      : 'vuoto';
    const disk = this.machine.disks.channels[0].drives[0]?.disk;
    const busy = disk && disk.writes !== this.lastDiskWrites;
    this.lastDiskWrites = disk?.writes ?? 0;
    this.diskRow.light.classList.toggle('pc__light--on', Boolean(busy));
    this.diskRow.text.textContent = disk
      ? `${megabytes(disk)} MB${this.diskName ? ` — ${this.diskName}` : ''}${disk.writes ? ` — ${disk.writes} settori scritti` : ''}`
      : 'nessun disco';
  }

  get hardDisk() {
    return this.machine?.disks.channels[0].drives[0]?.disk ?? null;
  }

  insertFloppy(bytes, name) {
    const format = formatOf(bytes);
    if (!format) {
      this.setStatus('Non è un\'immagine di dischetto che questo lettore sappia leggere');
      return false;
    }
    this.machine.insertFloppy(bytes);
    declareFloppyDrive(this.machine);
    this.floppyName = name.replace(/\.(img|ima)$/i, '');
    this.savedFloppyWrites = 0;
    this.updateDrives();
    this.setStatus(`${this.floppyName} in A: (${format.label})`);
    return true;
  }

  ejectFloppy() {
    const drive = this.machine?.floppy.drives[0];
    if (!drive?.medium) {
      this.setStatus('Non c\'è nessun dischetto in A:');
      return;
    }
    if (drive.writes !== this.savedFloppyWrites) this.saveFloppy();
    drive.eject();
    this.floppyName = '';
    this.updateDrives();
    this.setStatus('A: vuoto');
  }

  saveFloppy() {
    const drive = this.machine?.floppy.drives[0];
    if (!drive?.medium) {
      this.setStatus('Non c\'è nessun dischetto in A:');
      return;
    }
    const name = `${this.floppyName || 'dischetto'} ${timestamp()}.img`;
    download(this.root, name, drive.medium);
    this.savedFloppyWrites = drive.writes;
    this.setStatus(`Scaricato «${name}»`);
  }

  saveHardDisk() {
    const disk = this.hardDisk;
    if (!disk) {
      this.setStatus('Non c\'è nessun disco fisso');
      return '';
    }
    const name = `${this.diskName || 'disco fisso 386'} ${timestamp()}.img`;
    download(this.root, name, disk.data);
    this.savedDiskWrites = disk.writes;
    const said = `Scaricato «${name}» — ${megabytes(disk)} MB, rimettilo qui la prossima volta`;
    this.setStatus(said);
    return said;
  }

  mountHardDisk(bytes, name) {
    const disk = hardDiskFrom(bytes);
    if (disk.sectorCount < 2) {
      this.setStatus('Quell\'immagine è troppo corta per essere un disco');
      return false;
    }
    const leaving = this.hardDisk;
    const rescued = leaving && leaving.writes !== this.savedDiskWrites ? this.saveHardDisk() : '';
    this.machine.disks.channels[0].attach(0, disk);
    this.diskName = name.replace(/\.(img|ima|hdd|dsk|raw)$/i, '');
    this.savedDiskWrites = 0;
    const layout = layoutOf(disk.data);
    if (layoutNamed(layout)) this.layoutSelect.value = layout;
    // Il BIOS guarda i dischi all'accensione, e solo allora.
    this.machine.reset();
    this.updateDrives();
    this.setStatus([`${this.diskName || 'disco'} in C: — ${megabytes(disk)} MB, la macchina riparte`, rescued].filter(Boolean).join(' · '));
    return true;
  }

  warnUnsaved(event) {
    const disk = this.hardDisk;
    const floppy = this.machine?.floppy.drives[0];
    const unsaved =
      (disk && disk.writes !== this.savedDiskWrites) || (floppy?.medium && floppy.writes !== this.savedFloppyWrites);
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '';
  }

  // ---------------------------------------------------------------- comandi

  resetMachine() {
    this.machine?.reset();
    this.setStatus('Reset');
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? 'Riprendi' : 'Pausa';
    this.setStatus(this.paused ? 'In pausa' : 'In esecuzione');
  }

  chooseLayout(id) {
    const layout = layoutNamed(id);
    if (!layout) return;
    storePreferredLayout(id);
    const disk = this.hardDisk;
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
   * Quello che è arrivato sulla finestra: prima le ROM, poi i dischi, poi il
   * resto, che finisce sul disco fisso — come sul 286.
   */
  async acceptFiles(files) {
    let bios = false;
    let video = false;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = classifyImage(bytes);
      if (image) {
        this.pending.push({ bytes, name: file.name, ...image });
        continue;
      }
      const kind = acceptROMFile(bytes);
      if (kind === 'bios') bios = true;
      else if (kind === 'video') video = true;
      else this.pending.push({ bytes, name: file.name, kind: 'file' });
    }
    if ((bios || video) && !this.machine) {
      if (!bios && video) this.setStatus('VGABIOS salvato — adesso serve il BIOS di sistema');
      else {
        this.overlay.replaceChildren();
        await this.start();
      }
      return;
    }
    if (video && this.machine) {
      this.video = await loadVideoROM();
      const disk = this.hardDisk;
      const floppy = this.machine.floppy.drives[0].medium;
      this.machine = build386(this.bios, { video: this.video, disk, floppy });
      this.setStatus('VGABIOS montato — la macchina riparte');
    }
    await this.mountPending();
  }

  async mountPending() {
    if (!this.machine) {
      if (this.pending.length) this.setStatus('Prima serve il BIOS: quello che hai trascinato aspetta qui');
      return;
    }
    const loose = [];
    for (const { bytes, name, kind } of this.pending.splice(0)) {
      if (kind === 'floppy') this.insertFloppy(bytes, name);
      else if (kind === 'file') loose.push({ bytes, name });
      else this.mountHardDisk(bytes, name);
    }
    if (loose.length) await this.loadFiles(loose);
  }

  async loadFiles(files) {
    const disk = this.hardDisk;
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
    this.setStatus([`${done.join(' · ')} — riaccensione, perché il DOS lo veda`, ...failed].join(' · '));
  }

  // --------------------------------------------------------------- tastiera

  keyDown(code) {
    this.down ??= new Set();
    this.down.add(code);
    for (const byte of scanBytes(code, false)) this.machine.kbc.fromKeyboard(byte);
  }

  keyUp(code) {
    this.down?.delete(code);
    for (const byte of scanBytes(code, true)) this.machine.kbc.fromKeyboard(byte);
  }

  /** La finestra ha perso il fuoco: i rilasci non arriveranno, li si manda adesso. */
  releaseKeys() {
    for (const code of this.down ?? []) {
      for (const byte of scanBytes(code, true)) this.machine?.kbc.fromKeyboard(byte);
    }
    this.down?.clear();
  }

  onKeyDown(event) {
    if (!this.machine || event.metaKey) return;
    if (event.code === 'F11') {
      event.preventDefault();
      this.pickFile();
      return;
    }
    const code = SCANCODES[event.code];
    if (code === undefined) return;
    event.preventDefault();
    if (event.repeat && this.down?.has(code)) {
      // La tastiera di un AT ripete da sé il codice di pressione, e il browser
      // lo fa per lei: si passa la ripetizione così com'è.
      for (const byte of scanBytes(code, false)) this.machine.kbc.fromKeyboard(byte);
      return;
    }
    // Il Ctrl finto che Windows manda davanti ad AltGr: vedi la pagina del 286.
    if (
      event.code === 'AltRight' &&
      this.controlAt &&
      event.timeStamp - this.controlAt < 50 &&
      event.getModifierState?.('AltGraph') &&
      this.down?.has(SCANCODES.ControlLeft)
    ) {
      this.keyUp(SCANCODES.ControlLeft);
    }
    this.controlAt = event.code === 'ControlLeft' ? event.timeStamp : 0;
    this.keyDown(code);
  }

  onKeyUp(event) {
    if (!this.machine) return;
    const code = SCANCODES[event.code];
    if (code === undefined || !this.down?.has(code)) return;
    event.preventDefault();
    this.keyUp(code);
  }

  // ------------------------------------------------------------------ mouse

  /**
   * Il mouse del browser diventa un mouse PS/2: si cattura il puntatore con un
   * clic sullo schermo — il browser lo libera con Esc — e da lì in poi ogni
   * movimento è uno spostamento relativo, che è l'unica cosa che un mouse di
   * allora sapesse dire.
   */
  capturePointer() {
    if (!this.machine || document.pointerLockElement === this.canvas) return;
    this.audio?.start?.();
    const request = this.canvas.requestPointerLock;
    if (!request) return;
    Promise.resolve(request.call(this.canvas)).catch(() => {});
  }

  get pointerCaptured() {
    return document.pointerLockElement === this.canvas;
  }

  onPointerLockChange() {
    this.setStatus(
      this.pointerCaptured ? 'Mouse catturato — Esc per liberarlo' : 'Mouse libero — clic sullo schermo per catturarlo',
    );
    if (!this.pointerCaptured) this.mouse.buttons = 0;
  }

  onMouseMove(event) {
    if (!this.pointerCaptured) return;
    this.mouse.dx += event.movementX ?? 0;
    this.mouse.dy += event.movementY ?? 0;
  }

  onMouseButton(event, down) {
    if (!this.pointerCaptured) return;
    const bit = event.button === 0 ? 1 : event.button === 2 ? 2 : event.button === 1 ? 4 : 0;
    if (!bit) return;
    event.preventDefault();
    this.mouse.buttons = down ? this.mouse.buttons | bit : this.mouse.buttons & ~bit;
  }

  /** Un pacchetto per fotogramma al massimo, con tutto il movimento accumulato. */
  sendMouse() {
    const m = this.mouse;
    if (!m.dx && !m.dy && m.buttons === m.sent) return;
    const kbc = this.machine.kbc;
    if (kbc.mouseBacklog > 6) return; // il driver non ha ancora letto il pacchetto di prima
    const dx = Math.max(-255, Math.min(255, m.dx));
    const dy = Math.max(-255, Math.min(255, m.dy));
    if (kbc.mouseMoved(dx, -dy, m.buttons)) {
      m.dx -= dx;
      m.dy -= dy;
      m.sent = m.buttons;
    } else {
      m.dx = 0;
      m.dy = 0;
    }
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
    if (!this.isFullscreen || this.pointerCaptured) return;
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
    Promise.resolve(request.call(this.root)).catch(() => this.setStatus('Schermo intero rifiutato dal browser'));
  }

  onFullscreenChange() {
    const full = this.isFullscreen;
    this.fullscreenButton.textContent = full ? 'Finestra' : 'Schermo intero';
    this.root.classList.toggle('pc--fullscreen', full);
    if (full) this.showControls(CONTROLS_FLASH);
    else this.hideControls();
    this.root.focus();
  }

  // ------------------------------------------------------------------ chiusura

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.controlsTimer);
    if (this.pointerCaptured) document.exitPointerLock?.();
    for (const [target, type, handler] of this.listeners ?? []) target.removeEventListener(type, handler);
    this.root.remove();
  }
}

function explain(error) {
  if (error instanceof NoFilesystemError) return 'su C: non c\'è nessun filesystem — prima FDISK e FORMAT C:';
  if (error instanceof FullDiskError) {
    const mega = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `sul disco non c'è più posto: ne servono ${mega(error.needed)} e ne restano ${mega(error.free)}`;
  }
  if (error instanceof FullDirectoryError) return 'la cartella principale del disco è piena';
  if (error instanceof UnreadableZipError) return error.message;
  return error.message;
}

function megabytes(disk) {
  return (disk.data.length / 1024 / 1024).toFixed(0);
}

function timestamp() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
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
  const session = new PC386Session(container, options);
  await session.start();
  return session;
}
