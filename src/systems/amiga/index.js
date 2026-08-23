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
      this.button('Inserisci un disco .adf', () => this.pickFile()),
      (this.ejectButton = this.button('Espelli', () => this.ejectDisk())),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.joystickButton = this.button('Joystick: no', () => this.toggleJoystick())),
      (this.mouseButton = this.button('Cattura il mouse', () => this.captureMouse())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    // The drive light and the power light, which on a real machine are the only
    // two things telling you the computer is alive at all.
    this.drive = element('div', 'amiga__drive');
    this.drive.hidden = true;
    this.driveLabel = element('span', 'amiga__drive-label');
    this.drive.append(this.driveLabel);

    this.fileInput = element('input', 'amiga__file');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.adf,.rom,.bin';
    this.fileInput.multiple = true;
    this.fileInput.addEventListener('change', () => {
      this.acceptFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });

    this.root.append(stage, this.bar, this.drive, this.fileInput);
    this.container.append(this.root);

    this.bindEvents();
  }

  button(label, action) {
    const node = element('button', 'amiga__button');
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
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('amiga--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.root, 'pointerdown', () => this.audio?.start()],
      [this.canvas, 'mousedown', (event) => this.onMouseButton(event, true)],
      [this.canvas, 'mouseup', (event) => this.onMouseButton(event, false)],
      [this.canvas, 'mousemove', (event) => this.onMouseMove(event)],
      [this.canvas, 'contextmenu', (event) => event.preventDefault()],
      [this.canvas, 'dblclick', () => this.toggleFullscreen()],
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
    pick.addEventListener('click', () => this.pickFile());
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
    this.updateDrive();
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

  /** The drive light, and where the head is, while anything is going on. */
  updateDrive() {
    const drive = this.machine.disk;
    const on = drive.motor && drive.selected;
    this.drive.hidden = !drive.inserted;
    if (!drive.inserted) return;
    const label = drive.label || drive.name;
    this.driveLabel.textContent =
      `${on ? '●' : '○'} DF0:  ${label}  ` +
      `traccia ${String(drive.cylinder).padStart(2, '0')}/${drive.head}` +
      `${drive.bootable ? '' : '  (non avviabile)'}`;
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
    if (locked) this.setStatus('Mouse catturato — premi Esc per riprenderlo');
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
    const full = this.fullscreenElement === this.root;
    this.fullscreenButton.textContent = full ? 'Finestra' : 'Schermo intero';
    this.root.classList.toggle('amiga--fullscreen', full);
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
      this.pickFile();
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

  pickFile() {
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

  async acceptFiles(files) {
    for (const file of files) {
      try {
        await this.acceptFile(file);
      } catch (error) {
        const prefix = error instanceof ADFFormatError ? 'Disco illeggibile' : 'Errore';
        this.setStatus(`${prefix} — ${error.message}`);
      }
    }
  }

  async acceptFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (isEncryptedROM(bytes)) {
      this.showROMPrompt(
        'Quella ROM è cifrata (formato Cloanto AMIROMTYPE1): serve la versione ' +
          'in chiaro, non quella che viaggia con il suo file di chiavi.',
      );
      return;
    }

    const rom = acceptROMFile(bytes);
    if (rom) {
      if (rom.kind === 'extended') {
        this.setStatus('ROM di estensione salvata — riavvia la macchina per usarla');
        if (!this.machine) this.showROMPrompt();
        return;
      }
      this.setStatus(`Kickstart ${rom.version?.name ?? ''} salvata — accensione…`);
      if (!this.machine) await this.start();
      else this.setStatus('Kickstart salvata: premi Reset per usarla');
      return;
    }

    if (!this.machine) throw new Error(`${file.name} non è una Kickstart`);
    this.insertDisk(bytes, file.name);
  }

  /** @param {Uint8Array} bytes a whole .adf */
  insertDisk(bytes, name) {
    checkADF(bytes);
    this.machine.disk.insert(bytes, name.replace(/\.adf$/i, ''));
    const label = volumeName(bytes);
    this.updateDrive();
    this.setStatus(
      isBootable(bytes)
        ? `${label || name} nel drive — premi Reset per avviarlo`
        : `${label || name} nel drive (non è un disco avviabile)`,
    );
  }

  ejectDisk() {
    this.machine.disk.eject();
    this.updateDrive();
    this.setStatus('Disco espulso');
  }

  // ------------------------------------------------------------------ teardown

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    for (const [target, type, handler] of this.listeners ?? []) {
      target.removeEventListener(type, handler);
    }
    if (this.pointerLocked) document.exitPointerLock?.();
    this.audio?.close();
    this.root.remove();
  }
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
