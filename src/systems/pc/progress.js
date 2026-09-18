// La barra che dice quanto manca, mentre un file arriva dentro la macchina.
//
// Un dischetto sono settecento KB e arriva prima che uno se ne accorga. Un CD
// sono seicento mega e un disco fisso salvato un giga: il browser ci mette
// secondi a leggerli, e per tutto quel tempo la finestra non dice niente — che
// è il modo più sicuro per far trascinare il file una seconda volta. Quindi il
// file si legge a pezzi, e dopo ogni pezzo la barra si allunga.

/** Sotto questa misura il file arriva subito, e una barra che lampeggia disturba e basta. */
const WORTH_SHOWING = 4 * 1024 * 1024;

function element(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function megabytes(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * La barra sopra lo schermo della macchina. Si mette nello stage, sotto la
 * macchina e sopra il bordo, e sparisce quando non c'è niente da caricare.
 */
export class LoadProgress {
  constructor() {
    this.root = element('div', 'pc__progress');
    this.root.hidden = true;
    this.root.setAttribute('role', 'progressbar');
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-valuemax', '100');
    this.label = element('span', 'pc__progress-label');
    const track = element('div', 'pc__progress-track');
    this.fill = element('div', 'pc__progress-fill');
    track.append(this.fill);
    this.root.append(this.label, track);
  }

  /**
   * Legge dei file uno dopo l'altro, con la barra che conta i byte di tutti
   * insieme. Un file che non si lascia leggere a pezzi si legge in un colpo.
   *
   * @param {File[]} files
   * @param {(file:File, bytes:Uint8Array) => (void|Promise<void>)} each cosa farne, appena letto
   */
  async readAll(files, each) {
    const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const shown = total >= WORTH_SHOWING;
    let before = 0;
    try {
      for (const [index, file] of files.entries()) {
        const name = files.length > 1 ? `«${file.name}» (${index + 1} di ${files.length})` : `«${file.name}»`;
        const bytes = await readFile(file, (done) => {
          if (shown) this.show(name, before + done, total);
        });
        before += bytes.length;
        if (shown) this.show(name, before, total);
        await each(file, bytes);
      }
    } finally {
      this.root.hidden = true;
    }
  }

  show(name, done, total) {
    const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    this.root.hidden = false;
    this.fill.style.width = `${percent}%`;
    this.root.setAttribute('aria-valuenow', String(percent));
    this.label.textContent =
      done >= total
        ? `${name} — letto, lo sto montando…`
        : `Caricamento ${name} — ${percent}% (${megabytes(done)} di ${megabytes(total)} MB)`;
  }
}

/**
 * Un file letto a pezzi dentro un blocco solo, grande quanto il file.
 *
 * @param {File} file
 * @param {(done:number) => void} onProgress
 * @returns {Promise<Uint8Array>}
 */
export async function readFile(file, onProgress) {
  if (typeof file.stream !== 'function') return new Uint8Array(await file.arrayBuffer());
  const bytes = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    bytes.set(value, done);
    done += value.length;
    onProgress(done);
  }
  return done === bytes.length ? bytes : bytes.subarray(0, done);
}
