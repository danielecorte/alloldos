// Il PC 286 come lo vede alloldos: accendilo, mettigli la sua immagine su una
// canvas, dagli la tastiera, e lasciagli infilare dentro i dischi.

import { PC, FPS } from './machine.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './cga.js';
import { Speaker } from './speaker.js';
import { SCANCODES } from './scancodes.js';
import {
  loadBIOS,
  loadCardROM,
  acceptROMFile,
  MissingBIOSError,
  BIOS_SPEC,
  CARD_SPEC,
  CARD_ROM_BASE,
  GLABIOS_URL,
  GLABIOS_SOURCE_URL,
  XTIDE_URL,
  XTIDE_SOURCE_URL,
} from './roms.js';
import { loadFloppy, loadHardDisk, storeFloppy, classifyImage, FREEDOS_URL } from './media.js';
import { formatOf } from './fdc.js';

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
    this.audio = null;
    this.running = false;
    this.paused = false;
    this.rafHandle = 0;
    this.lastTime = 0;
    this.frameDebt = 0;
    this.floppyName = '';
    this.seenFloppyWrites = 0;
    this.savedFloppyWrites = 0;
    this.savedDiskWrites = 0;
    this.quietAt = 0;
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
    this.image = this.context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.imageWords = new Uint32Array(this.image.data.buffer);
    stage.append(this.canvas);

    this.overlay = element('div', 'pc__overlay');
    stage.append(this.overlay);

    this.bar = element('div', 'pc__bar');
    this.status = element('span', 'pc__status');
    this.bar.append(
      this.button('Metti un dischetto .img', () => this.pickFile()),
      this.button('Reset', () => this.resetMachine()),
      (this.pauseButton = this.button('Pausa', () => this.togglePause())),
      (this.muteButton = this.button('Audio on', () => this.toggleMute())),
      (this.fullscreenButton = this.button('Schermo intero', () => this.toggleFullscreen())),
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
    this.fileInput.accept = '.img,.ima,.rom,.bin';
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
      this.root.focus(); // la tastiera resta puntata sulla macchina
    });
    return node;
  }

  bindEvents() {
    this.listeners = [
      [window, 'keydown', (event) => this.onKeyDown(event)],
      [window, 'keyup', (event) => this.onKeyUp(event)],
      [window, 'blur', () => this.machine?.keyboard.reset()],
      [window, 'beforeunload', (event) => this.warnUnsaved(event)],
      [this.root, 'dragover', (event) => this.onDragOver(event)],
      [this.root, 'dragleave', () => this.root.classList.remove('pc--dropping')],
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

    const [card, floppy, disk] = await Promise.all([loadCardROM(), loadFloppy(), loadHardDisk()]);
    this.machine = new PC(bios, {
      disk,
      cards: card ? [{ base: CARD_ROM_BASE, bytes: card }] : [],
    });
    if (floppy) this.insertFloppy(floppy, 'FreeDOS');
    this.savedDiskWrites = 0;

    try {
      this.audio = new Speaker();
    } catch {
      this.audio = null; // un browser senza audio: la macchina va lo stesso
    }

    this.overlay.replaceChildren();
    this.root.focus();
    this.updateDrives();
    this.setStatus(
      card
        ? 'Accensione…'
        : 'Accensione senza la scheda del disco fisso: c\'è solo il dischetto',
    );

    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame((time) => this.tick(time));
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
        cioè la ROM della scheda del disco fisso: senza, la macchina ha solo il
        lettore di dischetti</li>
        <li>un dischetto avviabile: quello di
        <a href="${FREEDOS_URL}" target="_blank" rel="noopener noreferrer">FreeDOS</a>
        da 720 KB va benissimo, e si trascina qui come gli altri</li>
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
      clonato il repository, in cartella bastano <code>npm run fetch-roms</code>
      e <code>npm run make-hdd</code>: il secondo installa FreeDOS su un disco
      da venti mega facendolo alla macchina, con FDISK e FORMAT veri.</p>
      <p>Niente di tutto questo esce dal tuo browser: alloldos non ha un server
      a cui mandarlo.</p>
    `;
    panel.append(notes);

    this.overlay.replaceChildren(panel);
    this.setStatus('Serve il BIOS — trascinalo sulla finestra');
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

    this.audio?.update(this.machine);
    this.present();
    this.updateDrives();
    this.offerModifiedFloppy();
  }

  present() {
    this.imageWords.set(this.machine.cga.render());
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
      ? `${(disk.data.length / 1024 / 1024).toFixed(0)} MB${
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
      return;
    }
    const name = `disco fisso ${timestamp()}.img`;
    download(this.root, name, disk.data);
    this.savedDiskWrites = disk.writes;
    this.setStatus(`Scaricato «${name}» — 20 MB, rimettilo qui la prossima volta`);
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

  async acceptFiles(files) {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = classifyImage(bytes);
      if (image?.kind === 'floppy') {
        if (!this.machine) {
          this.setStatus('Prima serve il BIOS');
          continue;
        }
        this.insertFloppy(bytes, file.name);
        continue;
      }
      if (image?.kind === 'hdd') {
        if (!this.machine) {
          this.setStatus('Prima serve il BIOS');
          continue;
        }
        this.machine.hdc.disk.data.set(bytes.subarray(0, this.machine.hdc.disk.data.length));
        this.machine.hdc.disk.writes = 0;
        this.savedDiskWrites = 0;
        this.updateDrives();
        this.setStatus(`Disco fisso da ${image.label} montato — premi Reset per avviarlo`);
        continue;
      }
      const kind = acceptROMFile(bytes);
      if (kind === 'bios') {
        this.setStatus('BIOS salvato — accensione…');
        this.overlay.replaceChildren();
        await this.start();
        return;
      }
      if (kind === 'card') {
        this.setStatus('ROM della scheda salvata — ricarica la macchina per montarla');
        continue;
      }
      this.setStatus(`«${file.name}» non è né una ROM né un'immagine di disco`);
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
    this.audio?.start();
    this.machine.keyboard.press(code);
  }

  onKeyUp(event) {
    if (!this.machine) return;
    const code = SCANCODES[event.code];
    if (code === undefined) return;
    event.preventDefault();
    this.machine.keyboard.release(code);
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
