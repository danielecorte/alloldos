// Lo ZX Spectrum come lo vede alloldos: accendilo, mettigli la sua immagine su
// una canvas, dagli quaranta tasti di gomma, e infilagli dentro una cassetta.

import { Spectrum, FPS, FRAME_CYCLES } from './machine.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.js';
import { AudioOutput, beeperSamples } from './audio.js';
import { keysFor, positionOf, JOYSTICK_KEYS } from './keyboard.js';
import { Tape, parseTAP, tapeName, TAPFormatError } from './tape.js';
import { loadSNA, saveSNA, isSNA } from './snapshot.js';
import {
  loadROM,
  acceptROMFile,
  isSpectrumROM,
  MissingROMError,
  FUSE_URL,
  FUSE_SOURCE_URL,
  OPENSE_URL,
} from './roms.js';

const MAX_CATCHUP_FRAMES = 4;
/** Quanti quadri per ogni quadro del browser mentre il nastro corre. */
const WARP_FRAMES = 24;

/**
 * Per quanti quadri resta giù un tasto che la macchina si batte da sola, e
 * quanti ne passano prima del successivo.
 *
 * Non è un dettaglio di comodo: la ROM legge la tastiera una volta per quadro
 * e accetta un tasto solo quando lo ha visto uguale due volte di fila, e una
 * combinazione di due tasti ne vuole ancora di più. Un tasto premuto per un
 * quadro solo non arriva — che è poi il motivo per cui le tastiere di gomma
 * avevano bisogno di essere premute e non sfiorate.
 */
const KEY_HOLD = 8;
const KEY_GAP = 4;

/**
 * Quanti quadri aspettare, dopo un reset, prima di cominciare a battere.
 * La macchina all'accensione prova tutti i 48 KB di RAM uno per uno e non
 * guarda la tastiera finché non ha finito: chi batte prima batte nel vuoto.
 */
const BOOT_FRAMES = 120;

/** La striscia in fondo che richiama la barra, e quanto resta in vista da sé. */
const CONTROLS_EDGE = 60;
const CONTROLS_FLASH = 2500;

/** I tasti da battere per LOAD "": J, e due volte symbol shift più P. */
const TYPE_LOAD = [['J'], ['SymbolShift', 'P'], ['SymbolShift', 'P'], ['Enter']];

class SpectrumSession {
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
    /** I tasti che la macchina si sta battendo da sola, uno per quadro. */
    this.pendingKeys = [];
    this.heldKeys = null;
    this.keyTimer = 0;
    this.joystickOn = false;
    this.build();
  }

  // --------------------------------------------------------------------- DOM

  build() {
    this.root = element('div', 'zx');
    this.root.tabIndex = 0;

    const stage = element('div', 'zx__stage');
    this.canvas = element('canvas', 'zx__canvas');
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.image = this.context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.imageWords = new Uint32Array(this.image.data.buffer);
    stage.append(this.canvas);

    this.overlay = element('div', 'zx__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'zx__bar');
    this.status = element('span', 'zx__status');
    this.bar.append(
      this.button('Carica .tap / .sna', () => this.pickFile()),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.joystickButton = this.button('Joystick: no', () => this.toggleJoystick())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.button('Salva .sna', () => this.saveSnapshot()),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    // Il registratore, che si vede solo quando c'è dentro una cassetta.
    this.tapeBar = element('div', 'zx__tape');
    this.tapeBar.hidden = true;
    this.tapeLabel = element('span', 'zx__tape-label');
    this.tapeBar.append(
      this.tapeLabel,
      (this.tapePlayButton = this.button('Play', () => this.toggleTape())),
      this.button('Riavvolgi', () => this.rewindTape()),
      this.button('Espelli', () => this.ejectTape()),
    );

    this.fileInput = element('input', 'zx__file');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.tap,.sna,.rom,.bin';
    this.fileInput.multiple = true;
    this.fileInput.addEventListener('change', () => {
      this.acceptFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });

    this.controls = element('div', 'zx__controls');
    this.controls.append(this.bar, this.tapeBar);

    this.root.append(stage, this.controls, this.fileInput);
    this.container.append(this.root);
    this.bindEvents();
  }

  button(label, action) {
    const node = element('button', 'zx__button');
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
      [window, 'blur', () => this.machine?.ula.clearKeys()],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('zx--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.root, 'pointerdown', () => this.audio?.start()],
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
    this.setStatus('Caricamento della ROM…');
    let rom;
    try {
      rom = await loadROM();
    } catch (error) {
      if (error instanceof MissingROMError) {
        this.showROMPrompt();
        return;
      }
      throw error;
    }

    this.machine = new Spectrum(rom);
    try {
      this.audio = new AudioOutput();
    } catch {
      this.audio = null;
    }
    this.overlay.replaceChildren();
    this.root.focus();
    this.setStatus('Accensione…');

    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
  }

  showROMPrompt() {
    const panel = element('div', 'zx__panel');
    panel.innerHTML = `
      <h2>Trascina qui la ROM dello ZX Spectrum</h2>
      <p>alloldos non imita uno Spectrum: ne esegue il firmware. Sono sedici KB,
      e dentro c'è tutto — l'interprete BASIC, l'aritmetica, il disegno delle
      lettere, il caricamento da nastro. È di Amstrad, che ne permette la
      ridistribuzione insieme agli emulatori, quindi si trova senza fatica:</p>
      <ul>
        <li>dentro il sorgente di
        <a href="${FUSE_URL}" target="_blank" rel="noopener noreferrer">Fuse</a>
        (<a href="${FUSE_SOURCE_URL}" target="_blank" rel="noopener noreferrer">fuse-1.6.0.tar.gz</a>,
        in <code>roms/48.rom</code>);</li>
        <li>oppure, se preferisci una ROM libera,
        <a href="${OPENSE_URL}" target="_blank" rel="noopener noreferrer">OpenSE BASIC</a>,
        che è un rimpiazzo compatibile in GPL.</li>
      </ul>
      <p><b>Trascina il file sulla finestra</b>: resta salvato in questo
      browser, e la prossima volta la macchina si accende da sé.</p>
    `;
    const pick = element('button', 'zx__button');
    pick.type = 'button';
    pick.textContent = 'Scegli il file…';
    pick.addEventListener('click', () => this.pickFile());
    panel.append(pick);

    const notes = element('div', 'zx__panel-note');
    notes.innerHTML = `
      <p>Viene riconosciuta dal contenuto, quindi il nome non conta. Se hai
      clonato il repository, in cartella basta <code>npm run fetch-roms</code>.</p>
      <p>Non lascia il tuo browser: alloldos non ha un server a cui mandarla.</p>
    `;
    panel.append(notes);
    this.overlay.replaceChildren(panel);
    this.setStatus('Serve la ROM — trascinala sulla finestra');
  }

  // ------------------------------------------------------------------- loop

  tick(time) {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame((next) => this.tick(next));

    const elapsed = Math.min(time - this.lastTime, 250);
    this.lastTime = time;
    if (this.paused) return;

    // Un nastro va alla velocità del nastro, che vuol dire minuti. Mentre
    // corre si va più in fretta che si può: quattro minuti di caricamento
    // erano il prezzo del 1982, ma non c'è ragione di rifarli pagare.
    const winding = this.machine.tape?.playing && !this.machine.tape.finished;
    let frames;
    if (winding) {
      frames = WARP_FRAMES;
      this.frameDebt = 0;
    } else {
      this.frameDebt += (elapsed / 1000) * FPS;
      frames = Math.min(Math.floor(this.frameDebt), MAX_CATCHUP_FRAMES);
      this.frameDebt -= frames;
    }
    if (frames === 0) return;

    for (let i = 0; i < frames; i++) {
      this.machine.runFrame();
      this.drainKeys();
      if (!winding) this.pumpAudio();
    }

    this.present();
    this.updateTapeBar();
  }

  present() {
    this.imageWords.set(this.machine.ula.render());
    this.context.putImageData(this.image, 0, 0);
  }

  pumpAudio() {
    if (!this.audio?.node) return;
    // Se il pezzo che suona è già avanti di un decimo di secondo non gli si
    // dà altro: meglio saltare un quadro di suono che accumulare ritardo.
    if (this.audio.available > this.audio.sampleRate * 0.1) return;
    const count = Math.round(this.audio.sampleRate / FPS);
    this.audio.push(beeperSamples(this.machine.ula.audioEvents, FRAME_CYCLES, count));
  }

  /** I tasti che la macchina si sta battendo da sola, alla velocità di un dito. */
  drainKeys() {
    if (this.keyTimer > 0) {
      this.keyTimer--;
      return;
    }
    if (this.heldKeys) {
      for (const name of this.heldKeys) this.setKey(name, false);
      this.heldKeys = null;
      this.keyTimer = KEY_GAP;
      return;
    }
    const next = this.pendingKeys.shift();
    if (!next) return;
    this.heldKeys = next;
    for (const name of next) this.setKey(name, true);
    this.keyTimer = KEY_HOLD;
  }

  setKey(name, down) {
    const position = positionOf(name);
    if (position) this.machine.ula.setKey(position[0], position[1], down);
  }

  // ------------------------------------------------------------- la cassetta

  /**
   * Mette dentro una cassetta e batte LOAD "" da sé, poi preme play. È la
   * sequenza che facevano tutti, e non c'è nessun motivo di farla rifare.
   */
  insertTape(bytes, name) {
    const blocks = parseTAP(bytes);
    const label = tapeName(blocks) || name.replace(/\.tap$/i, '');
    this.machine.reset();
    this.machine.tape = new Tape(blocks, label);
    this.pendingKeys = [...TYPE_LOAD];
    this.heldKeys = null;
    this.keyTimer = BOOT_FRAMES;
    // Il tempo di accendersi e di battere LOAD "" con le sue dita finte.
    this.tapeStart =
      this.machine.frames + BOOT_FRAMES + (TYPE_LOAD.length + 1) * (KEY_HOLD + KEY_GAP);
    this.setStatus(`${label}: ${blocks.length} blocchi — caricamento`);
    this.updateTapeBar();
  }

  updateTapeBar() {
    const tape = this.machine?.tape;
    this.tapeBar.hidden = !tape;
    if (!tape) return;
    // Il play si preme da sé appena la riga di comando è stata battuta.
    if (this.tapeStart && this.machine.frames >= this.tapeStart) {
      this.tapeStart = 0;
      tape.play(this.machine.time);
    }
    const percent = Math.round(tape.progress * 100);
    this.tapeLabel.textContent = tape.playing
      ? `${tape.label} — ${percent}%`
      : `${tape.label} — fermo`;
    this.tapePlayButton.textContent = tape.playing ? 'Stop' : 'Play';
    if (tape.playing && tape.finished) {
      tape.stop();
      this.setStatus(`${tape.label}: nastro finito`);
    }
  }

  toggleTape() {
    const tape = this.machine?.tape;
    if (!tape) return;
    if (tape.playing) tape.stop();
    else tape.play(this.machine.time);
    this.updateTapeBar();
  }

  rewindTape() {
    const tape = this.machine?.tape;
    if (!tape) return;
    tape.rewind();
    tape.play(this.machine.time);
    this.setStatus(`${tape.label}: riavvolto`);
  }

  ejectTape() {
    if (!this.machine?.tape) return;
    this.machine.tape = null;
    this.updateTapeBar();
    this.setStatus('Registratore vuoto');
  }

  // ------------------------------------------------------------- istantanee

  saveSnapshot() {
    if (!this.machine) return;
    download(this.root, `spectrum ${timestamp()}.sna`, saveSNA(this.machine));
    this.setStatus('Istantanea salvata: ritrascinala qui per riprendere da lì');
  }

  // ---------------------------------------------------------------- comandi

  resetMachine() {
    this.machine.reset();
    this.pendingKeys = [];
    this.setStatus('Reset');
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? 'Riprendi' : 'Pausa';
    this.setStatus(this.paused ? 'In pausa' : 'In esecuzione');
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

  /**
   * Il joystick Kempston, che va chiesto: i tasti che vuole sono le frecce, e
   * le frecce sullo Spectrum sono già dei tasti — 5, 6, 7 e 8 con il caps
   * shift — che il BASIC usa per muoversi nella riga.
   */
  toggleJoystick() {
    this.joystickOn = !this.joystickOn;
    if (this.machine) this.machine.ula.joystick = 0;
    this.joystickButton.textContent = this.joystickOn ? 'Joystick: Kempston' : 'Joystick: no';
    this.setStatus(
      this.joystickOn
        ? 'Frecce e spazio = joystick Kempston'
        : 'Frecce e spazio = tasti dello Spectrum',
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
    this.root.classList.add('zx--dropping');
  }

  onDrop(event) {
    event.preventDefault();
    this.root.classList.remove('zx--dropping');
    this.acceptFiles([...(event.dataTransfer?.files ?? [])]);
  }

  async acceptFiles(files) {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isSpectrumROM(bytes)) {
        acceptROMFile(bytes);
        this.setStatus('ROM salvata — accensione…');
        this.overlay.replaceChildren();
        await this.start();
        return;
      }
      if (!this.machine) {
        this.setStatus('Prima serve la ROM');
        continue;
      }
      if (isSNA(bytes)) {
        loadSNA(this.machine, bytes);
        this.setStatus(`«${file.name}» ripresa da dove era`);
        continue;
      }
      try {
        this.insertTape(bytes, file.name);
      } catch (error) {
        if (error instanceof TAPFormatError) {
          this.setStatus(`«${file.name}» non è un .tap: ${error.message}`);
        } else throw error;
      }
    }
  }

  // ------------------------------------------------------- schermo intero

  get fullscreenElement() {
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  get isFullscreen() {
    return this.fullscreenElement === this.root;
  }

  showControls(hideAfter = 0) {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.add('zx--controls-shown');
    if (!hideAfter) return;
    this.controlsTimer = setTimeout(() => this.hideControls(), hideAfter);
    this.controlsTimer?.unref?.();
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.remove('zx--controls-shown');
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
    this.root.classList.toggle('zx--fullscreen', full);
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
    this.audio?.start();
    if (this.joystickOn && JOYSTICK_KEYS[event.code] !== undefined) {
      event.preventDefault();
      this.machine.ula.joystick |= JOYSTICK_KEYS[event.code];
      return;
    }
    const keys = keysFor(event.code);
    if (keys.length === 0) return;
    event.preventDefault();
    for (const name of keys) this.setKey(name, true);
  }

  onKeyUp(event) {
    if (!this.machine) return;
    if (this.joystickOn && JOYSTICK_KEYS[event.code] !== undefined) {
      event.preventDefault();
      this.machine.ula.joystick &= ~JOYSTICK_KEYS[event.code];
      return;
    }
    const keys = keysFor(event.code);
    if (keys.length === 0) return;
    event.preventDefault();
    for (const name of keys) this.setKey(name, false);
  }

  // ------------------------------------------------------------------ chiusura

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.controlsTimer);
    for (const [target, type, handler] of this.listeners ?? []) {
      target.removeEventListener(type, handler);
    }
    this.audio?.close();
    this.root.remove();
  }
}

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
  const link = element('a', 'zx__download');
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
  const session = new SpectrumSession(container, options);
  await session.start();
  return session;
}
