// The Amiga 500 as alloldos sees it: boot it, put its picture on a canvas, give
// it the keyboard and the mouse, and let disks be dropped onto it.

import { Amiga, FPS } from './machine.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './denise.js';
import { AudioOutput } from './audio.js';
import {
  loadKickstart,
  loadExtendedROM,
  acceptROMFile,
  romVersion,
  isEncryptedROM,
  MissingKickstartError,
  AMIGA_FOREVER_URL,
  AROS_URL,
} from './roms.js';
import { checkADF, ADFFormatError, volumeName, isBootable } from './adf.js';

const MAX_CATCHUP_FRAMES = 4; // never try to make up more than this after a stall

/**
 * How long the drive has to stay quiet before a written disk is handed back.
 *
 * There is nowhere here to put a disk down. Everything the machine writes goes
 * into the image in memory, which survives a reset and a reboot of the game,
 * and vanishes with the tab — so the moment the writing stops, the .adf comes
 * back out as a file. Waiting is what keeps one save from becoming six
 * downloads: a game writing its high scores touches several tracks in a row,
 * and they are all one save.
 */
const SAVE_QUIET_MS = 1500;

/**
 * La striscia in fondo allo schermo che richiama la barra dei comandi, e quanto
 * la barra resta in vista quando si mostra da sé. Sessanta pixel sono un bordo
 * che si trova senza cercarlo e che non si attraversa per sbaglio.
 */
const CONTROLS_EDGE = 60;
const CONTROLS_FLASH = 2500;

class AmigaSession {
  constructor(container, options) {
    this.container = container;
    this.onExit = options.onExit;
    this.machine = null;
    this.audio = null;
    this.running = false;
    this.paused = false;
    this.rafHandle = 0;
    this.lastTime = 0;
    this.frameDebt = 0;
    this.mouseRemainder = { x: 0, y: 0 };

    // Writes to each disk, counted three ways: what the drive has done, what
    // has already gone back to the user as a file, and when it last moved.
    this.seenWrites = [0, 0];
    this.savedWrites = [0, 0];
    this.seenForeignWrites = [0, 0];
    this.quietAt = [0, 0];
    this.pickTarget = 0;
    this.build();
  }

  // --------------------------------------------------------------------- DOM

  build() {
    this.root = element('div', 'amiga');
    this.root.tabIndex = 0;

    const stage = element('div', 'amiga__stage');
    this.canvas = element('canvas', 'amiga__canvas');
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.image = this.context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.imageWords = new Uint32Array(this.image.data.buffer);
    stage.append(this.canvas);

    this.overlay = element('div', 'amiga__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'amiga__bar');
    this.status = element('span', 'amiga__status');
    this.bar.append(
      this.button('Inserisci un disco .adf', () => this.pickFile(0)),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.joystickButton = this.button('Joystick: no', () => this.toggleJoystick())),
      (this.mouseButton = this.button('Cattura il mouse', () => this.captureMouse())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    // One row per drive. The light and the track number are the only two things
    // a real machine tells you about a floppy, and the rest of the row is what
    // you can do to it: put one in, take it out, keep a copy, close the tab.
    this.driveRows = [this.buildDriveRow(0), this.buildDriveRow(1)];

    this.fileInput = element('input', 'amiga__file');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.adf,.rom,.bin';
    this.fileInput.multiple = true;
    this.fileInput.addEventListener('change', () => {
      this.acceptFiles([...this.fileInput.files], this.pickTarget);
      this.fileInput.value = '';
    });

    // Barra e cassetti stanno insieme, perché a schermo intero escono di scena
    // insieme: quello che si guarda è la macchina, non i suoi pulsanti.
    this.controls = element('div', 'amiga__controls');
    this.controls.append(this.bar, ...this.driveRows.map((row) => row.row));

    this.root.append(stage, this.controls, this.fileInput);
    this.container.append(this.root);

    this.bindEvents();
  }

  /** A drive, as a row of the bar under the picture. */
  buildDriveRow(unit) {
    const row = element('div', 'amiga__drive');
    const label = element('span', 'amiga__drive-label');
    const buttons = element('div', 'amiga__drive-buttons');
    const protect = this.button('Protetto: no', () => this.toggleWriteProtect(unit), 'amiga__button--small');
    buttons.append(
      this.button('Inserisci…', () => this.pickFile(unit), 'amiga__button--small'),
      this.button('Espelli', () => this.ejectDisk(unit), 'amiga__button--small'),
      this.button('Salva .adf', () => this.saveDisk(unit), 'amiga__button--small'),
      protect,
    );
    row.append(label, buttons);
    return { row, label, protect };
  }

  button(label, action, extra = '') {
    const node = element('button', `amiga__button${extra ? ` ${extra}` : ''}`);
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

  bindEvents() {
    this.listeners = [
      [window, 'keydown', (event) => this.onKeyDown(event)],
      [window, 'keyup', (event) => this.onKeyUp(event)],
      [window, 'blur', () => this.machine?.keyboard.releaseAll()],
      [window, 'beforeunload', (event) => this.warnUnsaved(event)],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('amiga--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.root, 'pointerdown', () => this.audio?.start()],
      [this.canvas, 'mousedown', (event) => this.onMouseButton(event, true)],
      [this.canvas, 'mouseup', (event) => this.onMouseButton(event, false)],
      [this.canvas, 'mousemove', (event) => this.onMouseMove(event)],
      [this.canvas, 'contextmenu', (event) => event.preventDefault()],
      [this.root, 'mousemove', (event) => this.onPointerHover(event)],
      [document, 'pointerlockchange', () => this.onPointerLockChange()],
      [document, 'fullscreenchange', () => this.onFullscreenChange()],
      [document, 'webkitfullscreenchange', () => this.onFullscreenChange()],
    ];
    for (const [target, type, handler] of this.listeners) {
      target.addEventListener(type, handler);
    }
  }

  // ------------------------------------------------------------------- boot

  async start() {
    this.setStatus('Caricamento della Kickstart…');
    let rom;
    try {
      rom = await loadKickstart();
    } catch (error) {
      if (error instanceof MissingKickstartError) {
        this.showROMPrompt();
        return;
      }
      throw error;
    }

    // The second ROM socket, which only AROS fills: its Kickstart half holds
    // the kernel and the rest of the operating system lives in here.
    const extended = await loadExtendedROM();

    // A browser that will not give us an audio context is still a browser that
    // can show an Amiga: the machine runs, silently, rather than not at all.
    try {
      this.audio = new AudioOutput();
    } catch {
      this.audio = null;
    }
    this.machine = new Amiga(rom, this.audio?.sampleRate ?? 44100, extended);
    this.overlay.replaceChildren();
    this.root.focus();

    const version = romVersion(rom);
    this.setStatus(
      version
        ? `Kickstart ${version.name} (${version.version}.${version.revision}) — accensione…`
        : 'Accensione…',
    );

    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
  }

  /**
   * What a visitor without a Kickstart lands on — which, on a public page, is
   * everybody. The C64 can point at VICE for its ROMs; there is no equivalent
   * for the Amiga, so this says plainly where the legal copy is sold and where
   * the free replacement lives, and nothing in between.
   */
  showROMPrompt(problem = '') {
    const panel = element('div', 'amiga__panel');
    panel.innerHTML = `
      <h2>Trascina qui la ROM Kickstart</h2>
      <p>Un Amiga senza Kickstart non è un Amiga a cui manca il firmware: è un
      computer senza sistema operativo. In quella ROM ci stanno <b>exec</b>,
      <b>graphics</b>, <b>intuition</b> e <b>dos</b> — tutto AmigaOS tranne il
      disco. Serve un file da <b>256 KB</b> (Kickstart 1.2 o 1.3) o da
      <b>512 KB</b> (2.0 e successive): <b>trascinalo sulla finestra</b>, o
      scegli il file qui sotto. Resta salvato in questo browser.</p>
      ${problem ? `<p><strong>${problem}</strong></p>` : ''}
      <p>La Kickstart è di Cloanto e non si può distribuire: non c'è un
      equivalente di VICE da cui scaricarla. Due strade oneste:</p>
      <ul>
        <li>comprare <a href="${AMIGA_FOREVER_URL}" target="_blank" rel="noopener noreferrer">Amiga
        Forever</a>, che è la licenza ufficiale delle ROM;</li>
        <li>oppure usare la Kickstart libera di
        <a href="${AROS_URL}" target="_blank" rel="noopener noreferrer">AROS</a>,
        che è software libero e si avvia davvero.</li>
      </ul>
    `;

    const pick = element('button', 'amiga__button');
    pick.type = 'button';
    pick.textContent = 'Scegli il file…';
    pick.addEventListener('click', () => this.pickFile(0));
    panel.append(pick);

    const notes = element('div', 'amiga__panel-note');
    notes.innerHTML = `
      <p>Se hai clonato il repository puoi anche metterla in
      <code>roms/amiga/kickstart.rom</code>. La Kickstart di AROS è divisa in
      due: l'altra metà va trascinata anche lei, o messa in
      <code>roms/amiga/extended.rom</code>.</p>
      <p>Non lascia il tuo browser: alloldos non ha un server a cui mandarla.</p>
    `;
    panel.append(notes);

    this.overlay.replaceChildren(panel);
    this.setStatus('Serve la Kickstart — trascinala sulla finestra');
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

    this.pumpAudio();
    this.present();
    this.updateDrives();
    for (const unit of [0, 1]) this.offerModifiedDisk(unit);
    this.checkForCrash();
  }

  present() {
    this.imageWords.set(this.machine.denise.framebuffer);
    this.context.putImageData(this.image, 0, 0);
  }

  pumpAudio() {
    const samples = this.machine.paula.drain(this.machine.paula.pendingSamples);
    if (!this.audio || this.audio.available > this.audio.sampleRate * 0.12) return;
    this.audio.push(samples);
    this.audio.available += samples.length >> 1;
  }

  /**
   * A 68000 that double-faults gives up and waits for someone to press reset.
   * Say so rather than leaving a frozen picture with no explanation.
   */
  checkForCrash() {
    if (!this.machine.cpu.halted || this.reportedCrash) return;
    this.reportedCrash = true;
    this.setStatus('CPU ferma: doppio bus error — Reset per ripartire');
  }

  /** The drive lights, and where each head is, while anything is going on. */
  updateDrives() {
    for (const unit of [0, 1]) {
      const drive = this.machine.drives[unit];
      const row = this.driveRows[unit];
      const on = drive.motor && drive.selected;
      row.protect.textContent = drive.writeProtected ? 'Protetto: sì' : 'Protetto: no';
      row.label.textContent = drive.inserted
        ? `${on ? '●' : '○'} ${drive.title}  ${drive.label || drive.name}  ` +
          `traccia ${String(drive.cylinder).padStart(2, '0')}/${drive.head}` +
          `${drive.bootable ? '' : '  (non avviabile)'}` +
          `${drive.modified ? '  ✎ scritto' : ''}`
        : `○ ${drive.title}  vuoto`;
    }
  }

  /**
   * Hands back a disk the machine has written to, once it has stopped writing.
   *
   * Called every frame for every drive, so all it usually does is notice that
   * nothing has happened. When something has, it waits for the drive to go
   * quiet and then downloads the whole .adf — with the writes in it — because a
   * browser tab is not a shelf and the image in memory is gone with the tab.
   */
  offerModifiedDisk(unit) {
    const drive = this.machine.drives[unit];

    if (drive.foreignWrites !== this.seenForeignWrites[unit]) {
      this.seenForeignWrites[unit] = drive.foreignWrites;
      this.setStatus(
        `${drive.title} si scrive da sé, in un formato che non è quello di ` +
          'AmigaDOS: in un .adf non ci sta, e quel salvataggio va perso',
      );
    }

    if (drive.writeCount !== this.seenWrites[unit]) {
      this.seenWrites[unit] = drive.writeCount;
      this.quietAt[unit] = performance.now() + SAVE_QUIET_MS;
      return;
    }
    if (!this.quietAt[unit] || performance.now() < this.quietAt[unit]) return;
    this.quietAt[unit] = 0;
    this.saveDisk(unit, true);
  }

  /**
   * The disk in a drive, as a file. Automatic after a write, and on the button
   * for anyone who wants a copy of where they are.
   */
  saveDisk(unit, automatic = false) {
    const drive = this.machine?.drives[unit];
    if (!drive?.inserted) {
      this.setStatus(`Non c'è nessun disco in ${drive?.title ?? 'DF0:'}`);
      return;
    }
    if (automatic && drive.writeCount === this.savedWrites[unit]) return;

    const name = `${drive.name || drive.label || 'disco'} ${timestamp()}.adf`;
    const url = URL.createObjectURL(new Blob([drive.image], { type: 'application/octet-stream' }));
    const link = element('a', 'amiga__download');
    link.href = url;
    link.download = name;
    this.root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    this.savedWrites[unit] = drive.writeCount;
    this.setStatus(
      automatic
        ? `${drive.title} è stato scritto: scaricato «${name}» — ritrascinalo qui la prossima volta`
        : `Scaricato «${name}»`,
    );
  }

  /** The write-protect tab, which on a real disk is a hole with a slider. */
  toggleWriteProtect(unit) {
    const drive = this.machine?.drives[unit];
    if (!drive?.inserted) {
      this.setStatus(`Non c'è nessun disco in ${drive?.title ?? 'DF0:'}`);
      return;
    }
    drive.writeProtected = !drive.writeProtected;
    this.updateDrives();
    this.setStatus(
      drive.writeProtected
        ? `${drive.title} protetto: nessuno può scriverci`
        : `${drive.title} si può scrivere`,
    );
  }

  /** Leaving with a written disk that has not been downloaded loses it. */
  warnUnsaved(event) {
    const unsaved = (this.machine?.drives ?? []).some(
      (drive, unit) => drive.inserted && drive.writeCount !== this.savedWrites[unit],
    );
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '';
  }

  // ---------------------------------------------------------------- controls

  resetMachine() {
    this.machine.reset();
    this.reportedCrash = false;
    this.setStatus('Reset');
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? 'Riprendi' : 'Pausa';
    this.setStatus(this.paused ? 'In pausa' : 'In esecuzione');
  }

  /**
   * Plugs a joystick into the game port, or takes it out again.
   *
   * It has to be asked for, because the keys it needs are keys the Amiga wants
   * too: Prince of Persia is played on the cursor keys, and a stick left
   * plugged in would eat every one of them.
   */
  toggleJoystick() {
    if (!this.machine) {
      this.setStatus('Prima serve la Kickstart');
      return;
    }
    const keyboard = this.machine.keyboard;
    keyboard.setJoystick(!keyboard.arrowsAreJoystick);
    this.joystickButton.textContent = keyboard.arrowsAreJoystick
      ? 'Joystick: porta 2'
      : 'Joystick: no';
    this.setStatus(
      keyboard.arrowsAreJoystick
        ? 'Frecce e spazio = joystick nella porta 2'
        : 'Frecce e spazio = tasti dell\'Amiga',
    );
  }

  toggleMute() {
    if (!this.audio) {
      this.setStatus('Questo browser non ha voluto darci l\'audio');
      return;
    }
    const muted = !this.audio.muted;
    this.audio.setMuted(muted);
    this.muteButton.textContent = muted ? 'Audio off' : 'Audio on';
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  // ------------------------------------------------------------------ mouse

  /**
   * The Amiga has no idea where its mouse is — it only counts how far the ball
   * turned — so the host pointer has to be locked to the picture, or the two
   * would disagree the moment one of them hit an edge.
   */
  captureMouse() {
    const request = this.canvas.requestPointerLock;
    if (!request) {
      this.setStatus('Questo browser non sa bloccare il puntatore');
      return;
    }
    Promise.resolve(request.call(this.canvas)).catch(() => {});
  }

  get pointerLocked() {
    return document.pointerLockElement === this.canvas;
  }

  onPointerLockChange() {
    const locked = this.pointerLocked;
    this.mouseButton.textContent = locked ? 'Rilascia il mouse' : 'Cattura il mouse';
    if (locked) {
      this.setStatus('Mouse catturato — premi Esc per riprenderlo');
      if (this.isFullscreen) this.hideControls();
      return;
    }
    // Il mouse è tornato a chi lo muove: se siamo a schermo intero è quasi
    // sempre perché si voleva qualcosa dalla barra.
    if (this.isFullscreen) this.showControls(CONTROLS_FLASH);
  }

  onMouseMove(event) {
    if (!this.machine) return;
    const scale = SCREEN_WIDTH / (this.canvas.clientWidth || SCREEN_WIDTH);
    // Two hires pixels to one lores one, which is what the counters count.
    const dx = this.mouseRemainder.x + ((event.movementX ?? 0) * scale) / 2;
    const dy = this.mouseRemainder.y + (event.movementY ?? 0) * (SCREEN_HEIGHT / (this.canvas.clientHeight || SCREEN_HEIGHT));
    const stepX = Math.trunc(dx);
    const stepY = Math.trunc(dy);
    this.mouseRemainder.x = dx - stepX;
    this.mouseRemainder.y = dy - stepY;
    if (stepX || stepY) this.machine.keyboard.moveMouse(stepX, stepY);
  }

  onMouseButton(event, down) {
    if (!this.machine) return;
    event.preventDefault();
    this.audio?.start();
    if (down && !this.pointerLocked && event.button === 0) this.captureMouse();
    this.machine.keyboard.setButton(event.button === 1 ? 2 : event.button, down);
  }

  // ------------------------------------------------------------- fullscreen

  get fullscreenElement() {
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  get isFullscreen() {
    return this.fullscreenElement === this.root;
  }

  /**
   * A schermo intero la barra scivola fuori dal fondo e l'immagine si prende
   * tutta l'altezza. Torna quando il puntatore scende in fondo allo schermo, e
   * torna da sola quando il mouse smette di essere catturato — cioè premendo
   * Esc, che è il modo di riaverla senza sapere niente di tutto questo.
   *
   * @param {number} [hideAfter] millisecondi dopo i quali sparisce da sé; 0 la
   *   lascia dov'è finché non è il puntatore a mandarla via
   */
  showControls(hideAfter = 0) {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.add('amiga--controls-shown');
    if (!hideAfter) return;
    this.controlsTimer = setTimeout(() => this.hideControls(), hideAfter);
    this.controlsTimer?.unref?.();
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.remove('amiga--controls-shown');
  }

  /**
   * Il puntatore che si muove a schermo intero. Se il mouse è catturato non
   * conta: quello è dell'Amiga, e il doppio clic serve al Workbench, non a noi.
   */
  onPointerHover(event) {
    if (!this.isFullscreen || this.pointerLocked) return;
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
    this.root.classList.toggle('amiga--fullscreen', full);
    // Entrando, la barra si fa vedere un momento e poi se ne va: è il solo modo
    // di dire che c'è ancora, e dov'è, a chi non lo sa.
    if (full) this.showControls(CONTROLS_FLASH);
    else this.hideControls();
    this.root.focus();
  }

  // ---------------------------------------------------------------- keyboard

  onKeyDown(event) {
    if (!this.machine || event.metaKey) return;
    if (event.code === 'F9') {
      event.preventDefault();
      this.resetMachine();
      return;
    }
    if (event.code === 'F11') {
      event.preventDefault();
      this.pickFile(0);
      return;
    }
    this.audio?.start();
    if (this.machine.keyboard.handleKeyDown(event)) event.preventDefault();
  }

  onKeyUp(event) {
    if (!this.machine) return;
    if (this.machine.keyboard.handleKeyUp(event)) event.preventDefault();
  }

  // -------------------------------------------------------------- the drive

  pickFile(unit = 0) {
    this.pickTarget = unit;
    this.fileInput.click();
  }

  onDragOver(event) {
    event.preventDefault();
    this.root.classList.add('amiga--dropping');
  }

  onDrop(event) {
    event.preventDefault();
    this.root.classList.remove('amiga--dropping');
    this.acceptFiles([...event.dataTransfer.files]);
  }

  /**
   * @param {File[]} files
   * @param {?number} unit which drive to fill, or null to work it out
   */
  async acceptFiles(files, unit = null) {
    let next = unit;
    for (const file of files) {
      try {
        const used = await this.acceptFile(file, next);
        // Two disks dropped together are disk one and disk two, in that order.
        if (used !== null) next = Math.min(used + 1, this.machine.drives.length - 1);
      } catch (error) {
        const prefix = error instanceof ADFFormatError ? 'Disco illeggibile' : 'Errore';
        this.setStatus(`${prefix} — ${error.message}`);
      }
    }
  }

  /** @returns {?number} the drive the file went into, if it was a disk */
  async acceptFile(file, unit = null) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (isEncryptedROM(bytes)) {
      this.showROMPrompt(
        'Quella ROM è cifrata (formato Cloanto AMIROMTYPE1): serve la versione ' +
          'in chiaro, non quella che viaggia con il suo file di chiavi.',
      );
      return null;
    }

    const rom = acceptROMFile(bytes);
    if (rom) {
      if (rom.kind === 'extended') {
        this.setStatus('ROM di estensione salvata — riavvia la macchina per usarla');
        if (!this.machine) this.showROMPrompt();
        return null;
      }
      this.setStatus(`Kickstart ${rom.version?.name ?? ''} salvata — accensione…`);
      if (!this.machine) await this.start();
      else this.setStatus('Kickstart salvata: premi Reset per usarla');
      return null;
    }

    if (!this.machine) throw new Error(`${file.name} non è una Kickstart`);
    return this.insertDisk(unit ?? this.freeDrive(), bytes, file.name);
  }

  /**
   * Which drive a disk dropped on the window goes into: the first empty one,
   * and DF0: if both are full — a game that wants disk two in DF1: is asking
   * for a drive that already has disk one in it.
   */
  freeDrive() {
    const empty = this.machine.drives.findIndex((drive) => !drive.inserted);
    return empty < 0 ? 0 : empty;
  }

  /**
   * @param {number} unit
   * @param {Uint8Array} bytes a whole .adf
   * @returns {number} the drive it went into
   */
  insertDisk(unit, bytes, name) {
    checkADF(bytes);
    const drive = this.machine.drives[unit];
    drive.insert(bytes, name.replace(/\.adf$/i, ''));
    this.seenWrites[unit] = 0;
    this.savedWrites[unit] = 0;
    this.quietAt[unit] = 0;
    const label = volumeName(bytes);
    this.updateDrives();
    this.setStatus(
      isBootable(bytes)
        ? `${label || name} in ${drive.title} — premi Reset per avviarlo`
        : `${label || name} in ${drive.title} (non è un disco avviabile)`,
    );
    return unit;
  }

  ejectDisk(unit) {
    const drive = this.machine.drives[unit];
    // Whatever was written to it goes with the user, not in the bin.
    if (drive.inserted && drive.writeCount !== this.savedWrites[unit]) this.saveDisk(unit, true);
    drive.eject();
    this.seenWrites[unit] = 0;
    this.savedWrites[unit] = 0;
    this.quietAt[unit] = 0;
    this.updateDrives();
    this.setStatus(`${drive.title} vuoto`);
  }

  // ------------------------------------------------------------------ teardown

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.controlsTimer);
    for (const [target, type, handler] of this.listeners ?? []) {
      target.removeEventListener(type, handler);
    }
    if (this.pointerLocked) document.exitPointerLock?.();
    this.audio?.close();
    this.root.remove();
  }
}

/** When this was, for the name of a file the user will have several of. */
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

/**
 * Boots the machine into `container`.
 * @returns {Promise<{dispose():void}>}
 */
export async function boot(container, options) {
  const session = new AmigaSession(container, options);
  await session.start();
  return session;
}
