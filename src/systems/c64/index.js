// The Commodore 64 as alloldos sees it: boot it, put its picture on a canvas,
// feed it the keyboard, and let files be dropped onto it.

import { C64, FPS } from './machine.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './vic2.js';
import { AudioOutput } from './audio.js';
import { loadROMs, acceptROMFile, MissingROMsError, ROM_SPECS, romDownloadLink } from './roms.js';
import { tokenize, detokenize, petsciiFromAscii, BasicSyntaxError } from './basic.js';
import { parseTAP, encodeTAP, TAPFormatError } from './tap.js';
import { BUTTON_NONE, BUTTON_PLAY } from './datasette.js';
import { isAtReadyPrompt, readScreenText } from './screen.js';

const MAX_CATCHUP_FRAMES = 4; // never try to make up more than this after a stall
const BOOT_FAST_FORWARD = 400; // frames we are willing to skip through on load
const WARP_FRAMES = 24; // frames per animation frame while winding a tape
const JOYSTICK_HINT_POLLS = 30; // port reads before offering to plug a stick in

/** La striscia in fondo che richiama la barra, e quanto resta in vista da sé. */
const CONTROLS_EDGE = 60;
const CONTROLS_FLASH = 2500;

const TYPE_LOAD = [0x4c, 0x4f, 0x41, 0x44, 0x0d];
const TYPE_RUN = [0x52, 0x55, 0x4e, 0x0d];

class C64Session {
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
    this.pendingType = null; // characters still to be pushed into the key buffer
    this.tapeStage = null; // where we are in the LOAD-from-tape sequence
    this.hintedPort = 0; // the port already suggested for the program now running
    this.build();
  }

  // --------------------------------------------------------------------- DOM

  build() {
    this.root = element('div', 'c64');
    this.root.tabIndex = 0;

    const stage = element('div', 'c64__stage');
    this.canvas = element('canvas', 'c64__canvas');
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.image = this.context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.imageWords = new Uint32Array(this.image.data.buffer);
    stage.append(this.canvas);

    this.overlay = element('div', 'c64__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'c64__bar');
    this.status = element('span', 'c64__status');
    this.bar.append(
      this.button('Carica .bas / .prg / .tap', () => this.pickFile()),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.joystickButton = this.button('Joystick: no', () => this.cycleJoystick())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
      this.button('Salva .bas', () => this.saveListing()),
      this.button('Salva .tap', () => this.saveTape()),
      (this.probeButton = this.button('Diagnostica tasti', () => this.toggleProbe())),
      this.button('Menu di boot', () => this.onExit()),
      this.status,
    );

    this.probe = element('div', 'c64__probe');
    this.probe.hidden = true;
    this.probeLog = [];

    // Tape transport, shown only once there is a tape in the machine.
    this.tapeBar = element('div', 'c64__tape');
    this.tapeBar.hidden = true;
    this.tapeLabel = element('span', 'c64__tape-label');
    this.tapeBar.append(
      this.tapeLabel,
      (this.tapePlayButton = this.button('Play', () => this.toggleTape())),
      this.button('Espelli', () => this.ejectTape()),
    );

    this.fileInput = element('input', 'c64__file');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.bas,.prg,.tap,.txt,.bin,.rom';
    this.fileInput.multiple = true;
    this.fileInput.addEventListener('change', () => {
      this.acceptFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });

    // Barra, registratore e diagnostica stanno insieme: a schermo intero escono
    // di scena insieme, e l'immagine si prende tutta l'altezza.
    this.controls = element('div', 'c64__controls');
    this.controls.append(this.bar, this.tapeBar, this.probe);

    this.root.append(stage, this.controls, this.fileInput);
    this.container.append(this.root);

    this.bindEvents();
  }

  button(label, action) {
    const node = element('button', 'c64__button');
    node.type = 'button';
    node.tabIndex = -1;
    node.textContent = label;
    node.addEventListener('click', (event) => {
      event.preventDefault();
      action();
      this.root.focus(); // keep the keyboard pointed at the emulated machine
    });
    return node;
  }

  bindEvents() {
    this.listeners = [
      [window, 'keydown', (event) => this.onKeyDown(event)],
      [window, 'keyup', (event) => this.onKeyUp(event)],
      [window, 'blur', () => this.machine?.keyboard.reset()],
      [this.root, 'paste', (event) => this.onPaste(event)],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('c64--dropping')],
      [this.root, 'drop', (event) => this.onDrop(event)],
      [this.root, 'pointerdown', () => this.audio?.start()],
      [this.canvas, 'dblclick', () => this.toggleFullscreen()],
      [this.root, 'mousemove', (event) => this.onPointerHover(event)],
      // Fullscreen can also be left with Escape or the browser's own button, so
      // the button's label follows the browser rather than our own clicks.
      [document, 'fullscreenchange', () => this.onFullscreenChange()],
      [document, 'webkitfullscreenchange', () => this.onFullscreenChange()],
    ];
    for (const [target, type, handler] of this.listeners) {
      target.addEventListener(type, handler);
    }
  }

  // ------------------------------------------------------------------- boot

  async start() {
    this.setStatus('Caricamento ROM…');
    let roms;
    try {
      roms = await loadROMs();
    } catch (error) {
      if (error instanceof MissingROMsError) {
        this.showROMPrompt(error.missing);
        return;
      }
      throw error;
    }

    this.audio = new AudioOutput();
    this.machine = new C64(roms, this.audio.sampleRate);
    this.overlay.replaceChildren();
    this.root.focus();
    this.setStatus('Accensione…');

    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
  }

  /**
   * Shown when the firmware images are not available yet — which, on a public
   * page, is the first thing a visitor ever sees. So it asks for the ROMs
   * rather than explaining the problem: the invitation first, the reasons
   * after, and the terminal command last, for the few who cloned the repo.
   */
  showROMPrompt(missing) {
    const panel = element('div', 'c64__panel');
    panel.innerHTML = `
      <h2>Trascina qui le ROM del Commodore 64</h2>
      <p>alloldos non imita un C64: ne esegue il firmware originale. Quel
      firmware è proprietà Commodore/Cloanto e non può essere distribuito
      insieme a questa pagina, quindi va portato da te — una volta sola.
      <b>Trascina i tre file sulla finestra</b>, o scegli i file qui sotto:
      restano salvati in questo browser, e la prossima volta la macchina si
      accende da sé.</p>
      <p><strong>Mancano:</strong> ${missing.join(', ')}. Se non sai dove
      prenderle, sono qui — vengono dalla distribuzione di
      <a href="https://vice-emu.sourceforge.io/" target="_blank" rel="noopener noreferrer">VICE</a>:</p>
      <ul>${ROM_SPECS.filter((spec) => missing.includes(spec.label))
        .map((spec) => `<li>${romDownloadLink(spec)}</li>`)
        .join('')}</ul>
    `;

    const pick = element('button', 'c64__button');
    pick.type = 'button';
    pick.textContent = 'Scegli i file…';
    pick.addEventListener('click', () => this.pickFile());
    panel.append(pick);

    const notes = element('div', 'c64__panel-note');
    notes.innerHTML = `
      <p>Vengono riconosciuti dal contenuto, quindi il nome del file non conta.
      Se hai <b>VICE</b> installato, i tre file stanno nella sua cartella
      <code>C64</code>. Se hai clonato il repository, in cartella basta
      <code>npm run fetch-roms</code>.</p>
      <p>Non lasciano il tuo browser: alloldos non ha un server a cui mandarli.</p>
    `;
    panel.append(notes);

    this.overlay.replaceChildren(panel);
    this.setStatus('Servono le ROM del C64 — trascinale sulla finestra');
  }

  // ------------------------------------------------------------------- loop

  tick(time) {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame((next) => this.tick(next));

    const elapsed = Math.min(time - this.lastTime, 250);
    this.lastTime = time;

    if (this.paused) return;

    // A tape runs at the speed of the tape, which is to say minutes. Wind it on
    // as fast as the browser can manage instead of making anyone sit through it.
    const warping = this.machine.datasette.running;
    let frames;
    if (warping) {
      frames = WARP_FRAMES;
      this.frameDebt = 0;
    } else {
      this.frameDebt += (elapsed / 1000) * FPS;
      frames = Math.min(Math.floor(this.frameDebt), MAX_CATCHUP_FRAMES);
      this.frameDebt -= frames;
    }
    if (frames === 0) return; // the display is faster than 50 Hz; nothing new to show

    for (let i = 0; i < frames; i++) {
      this.machine.runFrame();
      this.drainKeyboardQueue();
    }

    if (warping) this.machine.sid.drain(this.machine.sid.pendingSamples); // no audio at 20x
    else this.pumpAudio();
    this.advanceTape();
    this.present();
    this.checkForCrash();
    this.suggestJoystick();
  }

  /**
   * A 6510 that hits an illegal opcode stops dead, and so does this one. Say so
   * plainly rather than leaving a frozen picture on screen with no explanation.
   */
  checkForCrash() {
    const cpu = this.machine.cpu;
    if (!cpu.jammed || this.reportedCrash) return;
    this.reportedCrash = true;
    this.setStatus(
      `CPU bloccata su un opcode illegale: $${cpu.jammedOpcode.toString(16).padStart(2, '0')} ` +
        `a $${cpu.jammedAt.toString(16).padStart(4, '0')} — Reset per ripartire`,
    );
  }

  present() {
    this.imageWords.set(this.machine.vic.framebuffer);
    this.context.putImageData(this.image, 0, 0);
  }

  pumpAudio() {
    // Always empty the SID's buffer so nothing goes stale, but stop handing
    // samples over once the worklet is more than ~120 ms ahead.
    const samples = this.machine.sid.drain(this.machine.sid.pendingSamples);
    if (this.audio.available > this.audio.sampleRate * 0.12) return;
    this.audio.push(samples);
    this.audio.available += samples.length;
  }

  /** Pushes queued characters into the KERNAL buffer a few at a time. */
  drainKeyboardQueue() {
    if (!this.pendingType || this.machine.peek(0xc6) !== 0) return;
    const chunk = this.pendingType.splice(0, 8);
    this.machine.typeIntoBuffer(chunk);
    if (this.pendingType.length === 0) this.pendingType = null;
  }

  // -------------------------------------------------------------------- tape

  /**
   * Puts a tape in and starts a LOAD, then follows it along: press PLAY when
   * the KERNAL asks, and type RUN once the program has arrived.
   */
  insertTape(bytes, label) {
    const tape = parseTAP(bytes);
    if (this.paused) this.togglePause();

    this.machine.reset();
    this.pendingType = null;
    this.hintedPort = 0;
    if (!this.fastForwardToReady()) return;

    this.machine.datasette.insert(tape, label);
    this.machine.datasette.press(BUTTON_NONE);
    this.pendingType = [...TYPE_LOAD];
    this.tapeStage = 'waiting-for-play';
    this.setStatus(`${label} — ${(tape.cycles / 985248).toFixed(0)}s di nastro`);
    this.updateTapeBar();
  }

  /** One step of the tape's own little story, checked once per animation frame. */
  advanceTape() {
    const tape = this.machine.datasette;
    if (!this.tapeStage) {
      if (tape.tape) this.updateTapeBar();
      return;
    }

    const screen = readScreenText(this.machine);

    if (this.tapeStage === 'waiting-for-play') {
      if (screen.includes('PRESS PLAY ON TAPE')) {
        tape.press(BUTTON_PLAY);
        this.tapeStage = 'loading';
      }
    } else if (this.tapeStage === 'loading') {
      const loading = screen.indexOf('LOADING');
      if (loading >= 0 && screen.indexOf('READY.', loading) > loading) {
        tape.press(BUTTON_NONE);
        this.tapeStage = null;
        const end = this.machine.peekWord(0x2d);
        if (end > 0x0803) this.pendingType = [...TYPE_RUN];
        this.setStatus(end > 0x0803 ? `${tape.name} caricato — RUN` : `${tape.name}: niente da caricare`);
      } else if (tape.atEnd && !tape.running) {
        this.tapeStage = null;
        this.setStatus(`${tape.name}: nastro finito senza trovare il programma`);
      }
    }
    this.updateTapeBar();
  }

  updateTapeBar() {
    const tape = this.machine.datasette;
    this.tapeBar.hidden = !tape.tape;
    if (!tape.tape) return;

    const counter = String(tape.counter).padStart(3, '0');
    const percent = Math.round(tape.progress * 100);
    this.tapeLabel.textContent = `⊙ ${tape.name || 'nastro'}  ${counter}  ${percent}%${
      tape.running ? '  ▶ avanti veloce' : ''
    }`;
    this.tapePlayButton.textContent = tape.button === BUTTON_PLAY ? 'Stop' : 'Play';
  }

  toggleTape() {
    const tape = this.machine.datasette;
    tape.press(tape.button === BUTTON_PLAY ? BUTTON_NONE : BUTTON_PLAY);
    this.updateTapeBar();
  }

  ejectTape() {
    this.machine.datasette.eject();
    this.tapeStage = null;
    this.updateTapeBar();
    this.setStatus('Nastro estratto');
  }

  /** Writes whatever BASIC program is in memory out as a tape image. */
  saveTape() {
    const prg = this.currentProgram();
    if (!prg) {
      this.setStatus('Nessun programma BASIC in memoria');
      return;
    }
    download('programma.tap', encodeTAP(prg, { name: 'PROGRAMMA' }), 'application/octet-stream');
    this.setStatus('Nastro salvato come programma.tap');
  }

  // ---------------------------------------------------------------- controls

  resetMachine() {
    this.machine.reset();
    this.pendingType = null;
    this.tapeStage = null;
    this.reportedCrash = false;
    this.hintedPort = 0;
    this.setStatus('Reset');
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? 'Riprendi' : 'Pausa';
    this.setStatus(this.paused ? 'In pausa' : 'In esecuzione');
  }

  /**
   * Cycles the cursor keys between being the C64's own cursor keys and being a
   * joystick in port 1 or port 2. The numeric keypad always drives whichever
   * port is selected.
   */
  cycleJoystick() {
    const keyboard = this.machine.keyboard;
    if (!keyboard.arrowsAreJoystick) {
      keyboard.arrowsAreJoystick = true;
      keyboard.setJoystickPort(1);
    } else if (keyboard.joystickPort === 1) {
      keyboard.setJoystickPort(2);
    } else {
      keyboard.arrowsAreJoystick = false;
      keyboard.setJoystickPort(2);
    }
    this.joystickButton.textContent = keyboard.arrowsAreJoystick
      ? `Joystick: porta ${keyboard.joystickPort}`
      : 'Joystick: no';
    this.setStatus(
      keyboard.arrowsAreJoystick
        ? `Frecce e spazio = joystick nella porta ${keyboard.joystickPort}`
        : 'Frecce = tasti cursore del C64',
    );
  }

  /**
   * If a game keeps interrogating a joystick port that nothing is plugged into,
   * say so — otherwise it just looks like the controls do not work.
   *
   * The threshold is low on purpose. A game that reads the port every frame
   * trips it in half a second, and one that reads it once per move — 1994 asks
   * about eight times a second — within a few seconds, which is still while
   * someone is wiggling the arrow keys wondering why nothing happens.
   */
  suggestJoystick() {
    const polls = this.machine.joystickPolls;
    const port = polls[1] > JOYSTICK_HINT_POLLS ? 1 : polls[2] > JOYSTICK_HINT_POLLS ? 2 : 0;
    if (!port || port === this.hintedPort) return;

    const keyboard = this.machine.keyboard;
    if (keyboard.arrowsAreJoystick && keyboard.joystickPort === port) return;

    this.hintedPort = port;
    this.setStatus(`Questo programma usa il joystick nella porta ${port} — premi "Joystick" per attivarlo`);
  }

  // ------------------------------------------------------------- fullscreen

  /** Whatever the browser currently has filling the screen, if anything. */
  get fullscreenElement() {
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  get isFullscreen() {
    return this.fullscreenElement === this.root;
  }

  /**
   * A schermo intero la barra scivola fuori dal fondo: torna quando il
   * puntatore scende in fondo allo schermo, e si fa vedere un momento da sé
   * appena si entra, per dire che c'è ancora.
   *
   * @param {number} [hideAfter] millisecondi dopo i quali sparisce da sé
   */
  showControls(hideAfter = 0) {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.add('c64--controls-shown');
    if (!hideAfter) return;
    this.controlsTimer = setTimeout(() => this.hideControls(), hideAfter);
    this.controlsTimer?.unref?.();
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = null;
    this.root.classList.remove('c64--controls-shown');
  }

  onPointerHover(event) {
    if (!this.isFullscreen) return;
    const height = window.innerHeight ?? 0;
    if (height && event.clientY >= height - CONTROLS_EDGE) this.showControls();
    else if (!this.controlsTimer) this.hideControls();
  }

  /**
   * The whole machine goes fullscreen — picture and bar together — so the
   * controls, the tape counter and the status line stay reachable. Also on a
   * double click on the picture, which is where anyone looks for it first.
   */
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
    // The standard call answers with a promise, which the browser rejects when
    // it does not believe a click was behind it; Safari's older one answers
    // with nothing at all.
    Promise.resolve(request.call(this.root)).catch(() =>
      this.setStatus('Schermo intero rifiutato dal browser'),
    );
  }

  /** Follows the browser: Escape and its own controls change this too. */
  onFullscreenChange() {
    const full = this.isFullscreen;
    this.fullscreenButton.textContent = full ? 'Finestra' : 'Schermo intero';
    this.root.classList.toggle('c64--fullscreen', full);
    if (full) this.showControls(CONTROLS_FLASH);
    else this.hideControls();
    this.root.focus(); // entering and leaving both move focus off the machine
  }

  toggleMute() {
    const muted = !this.audio.muted;
    this.audio.setMuted(muted);
    this.muteButton.textContent = muted ? 'Audio off' : 'Audio on';
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  // ------------------------------------------------------------- diagnostic

  toggleProbe() {
    this.probe.hidden = !this.probe.hidden;
    this.probeButton.textContent = this.probe.hidden ? 'Diagnostica tasti' : 'Chiudi diagnostica';
    if (!this.probe.hidden) this.renderProbe();
  }

  /** Records what a key event was translated into, newest first. */
  logKey(event) {
    if (this.probe.hidden) return;
    const { host, c64 } = this.machine.keyboard.describe(event);
    this.probeLog.unshift({ host, c64 });
    this.probeLog.length = Math.min(this.probeLog.length, 10);
    this.renderProbe();
  }

  renderProbe() {
    const held = this.machine.keyboard.heldKeyNames();
    const lines = this.probeLog.map(({ host, c64 }) => `${host.padEnd(34)} →  ${c64}`);
    this.probe.textContent = [
      `premuti ora: ${held.length ? held.join(', ') : '(nessuno)'}`,
      '',
      ...(lines.length ? lines : ['(premi un tasto)']),
    ].join('\n');
  }

  // ---------------------------------------------------------------- keyboard

  onKeyDown(event) {
    if (!this.machine || event.metaKey) return;
    // Let the browser have the clipboard shortcuts.
    if (event.ctrlKey && ['KeyV', 'KeyC', 'KeyX'].includes(event.code)) return;

    if (event.code === 'F9') {
      event.preventDefault();
      this.resetMachine();
      return;
    }
    if (event.code === 'F10') {
      event.preventDefault();
      this.pickFile();
      return;
    }

    this.audio?.start();
    if (this.machine.keyboard.handleKeyDown(event)) event.preventDefault();
    this.logKey(event);
  }

  onKeyUp(event) {
    if (!this.machine) return;
    if (this.machine.keyboard.handleKeyUp(event)) event.preventDefault();
    if (!this.probe.hidden) this.renderProbe();
  }

  onPaste(event) {
    const text = event.clipboardData?.getData('text');
    if (!text) return;
    event.preventDefault();
    this.pendingType = [...text]
      .map((char) => (char === '\n' ? 0x0d : petsciiFromAscii(char)))
      .filter((code) => code === 0x0d || (code >= 0x20 && code <= 0xff));
    this.setStatus(`Incollo ${this.pendingType.length} caratteri…`);
  }

  // ------------------------------------------------------------ file loading

  pickFile() {
    this.fileInput.click();
  }

  onDragOver(event) {
    event.preventDefault();
    this.root.classList.add('c64--dropping');
  }

  onDrop(event) {
    event.preventDefault();
    this.root.classList.remove('c64--dropping');
    this.acceptFiles([...event.dataTransfer.files]);
  }

  async acceptFiles(files) {
    for (const file of files) {
      try {
        await this.acceptFile(file);
      } catch (error) {
        const prefix =
          error instanceof BasicSyntaxError ? 'Errore BASIC'
          : error instanceof TAPFormatError ? 'Nastro illeggibile'
          : 'Errore';
        this.setStatus(`${prefix} — ${error.message}`);
      }
    }
  }

  async acceptFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();

    // A ROM image dropped while the machine has no firmware yet.
    if (!this.machine && acceptROMFile(bytes, name)) {
      this.setStatus(`ROM ${file.name} salvata`);
      const remaining = await loadROMs().then(() => null, (error) => error.missing);
      if (remaining) this.showROMPrompt(remaining);
      else await this.start();
      return;
    }
    if (!this.machine) throw new Error(`${file.name} non è una ROM del C64`);

    if (name.endsWith('.tap')) {
      this.insertTape(bytes, file.name.replace(/\.tap$/i, ''));
      return;
    }
    if (name.endsWith('.bas') || name.endsWith('.txt')) {
      const source = new TextDecoder().decode(bytes);
      this.runProgram(tokenize(source), file.name);
      return;
    }
    this.runProgram(bytes, file.name);
  }

  /**
   * Resets, waits for the READY prompt, drops the program in at its load
   * address and starts it — the same sequence as LOAD followed by RUN.
   * @param {Uint8Array} prg
   */
  runProgram(prg, label) {
    this.setStatus(`Avvio ${label}…`);
    if (this.paused) this.togglePause();
    this.machine.reset();
    this.pendingType = null;
    this.hintedPort = 0;

    if (!this.fastForwardToReady()) return;

    const { start, end } = this.machine.loadPRG(prg);
    if (start === 0x0801) {
      this.pendingType = [0x52, 0x55, 0x4e, 0x0d]; // RUN + Return
      this.setStatus(`${label} — ${end - start} byte, RUN`);
    } else {
      this.setStatus(`${label} caricato a $${hex(start)} — avvialo con SYS ${start}`);
    }
  }

  /**
   * Runs the machine on at full tilt until BASIC is at its prompt.
   * @returns {boolean} false if it never got there
   */
  fastForwardToReady() {
    let frames = 0;
    while (frames < BOOT_FAST_FORWARD && !isAtReadyPrompt(this.machine)) {
      this.machine.runFrame();
      frames++;
    }
    if (frames >= BOOT_FAST_FORWARD) {
      this.setStatus('La macchina non è arrivata al prompt READY.');
      return false;
    }
    // The fast-forward produced a couple of seconds of audio nobody heard.
    this.machine.sid.drain(this.machine.sid.pendingSamples);
    this.frameDebt = 0;
    this.lastTime = performance.now();
    return true;
  }

  /** The BASIC program currently in memory, as a .prg image. */
  currentProgram() {
    const start = this.machine.peekWord(0x2b);
    const end = this.machine.peekWord(0x2d);
    if (end <= start + 2) return null;

    const prg = new Uint8Array(end - start + 2);
    prg[0] = start & 0xff;
    prg[1] = (start >> 8) & 0xff;
    for (let i = 0; i < end - start; i++) prg[i + 2] = this.machine.peek(start + i);
    return prg;
  }

  /** Saves whatever BASIC program is currently in memory as a .bas file. */
  saveListing() {
    const prg = this.currentProgram();
    if (!prg) {
      this.setStatus('Nessun programma BASIC in memoria');
      return;
    }
    download('programma.bas', detokenize(prg), 'text/plain');
    this.setStatus('Listato salvato come programma.bas');
  }

  // ------------------------------------------------------------------ teardown

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

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function hex(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** @param {string|Uint8Array} content */
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Firefox needs the URL to outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Boots the machine into `container`.
 * @returns {Promise<{dispose():void}>}
 */
export async function boot(container, options) {
  const session = new C64Session(container, options);
  await session.start();
  return session;
}
