// The first screen: a boot menu in the spirit of GRUB.
//
// Arrow keys move the highlight, Return boots, and the default entry boots
// itself once the countdown runs out — which any keypress cancels, as it
// should.

const COUNTDOWN_SECONDS = 8;

export class BootLoader {
  /**
   * @param {HTMLElement} container
   * @param {Array<object>} systems
   * @param {{defaultSystem:string, onBoot:(system:object)=>void}} options
   */
  constructor(container, systems, options) {
    this.container = container;
    this.systems = systems;
    this.onBoot = options.onBoot;
    this.selected = Math.max(0, systems.findIndex((system) => system.id === options.defaultSystem));
    this.countdown = COUNTDOWN_SECONDS;
    this.timer = 0;
    this.build();
  }

  build() {
    this.root = element('div', 'grub');
    this.root.tabIndex = 0;

    const header = element('div', 'grub__header');
    header.textContent = 'alloldos 0.1  —  raccoglitore di sistemi operativi emulati';

    this.menu = element('ul', 'grub__menu');
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('aria-label', 'Sistemi disponibili');

    this.entries = this.systems.map((system, index) => {
      const item = element('li', 'grub__entry');
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);
      if (!system.available) item.classList.add('grub__entry--unavailable');

      const label = element('span', 'grub__entry-label');
      label.textContent = system.label;
      const year = element('span', 'grub__entry-year');
      year.textContent = system.available ? String(system.year) : 'non disponibile';
      item.append(label, year);

      item.addEventListener('click', () => {
        this.select(index);
        this.boot();
      });
      item.addEventListener('mousemove', () => this.select(index));
      this.menu.append(item);
      return item;
    });

    this.details = element('div', 'grub__details');
    this.message = element('div', 'grub__message');
    this.help = element('div', 'grub__help');
    this.help.innerHTML = [
      'Usa i tasti <b>↑</b> e <b>↓</b> per evidenziare una voce.',
      'Premi <b>Invio</b> per avviare il sistema selezionato.',
    ].join('<br>');

    this.footer = element('div', 'grub__footer');

    const frame = element('div', 'grub__frame');
    frame.append(this.menu);

    this.root.append(header, frame, this.details, this.message, this.help, this.footer);
    this.container.append(this.root);

    this.keyHandler = (event) => this.onKeyDown(event);
    window.addEventListener('keydown', this.keyHandler);

    this.render();
    this.startCountdown();
    this.root.focus();
  }

  startCountdown() {
    this.timer = window.setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0) {
        this.stopCountdown();
        this.boot();
        return;
      }
      this.renderFooter();
    }, 1000);
    this.renderFooter();
  }

  stopCountdown() {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.renderFooter();
  }

  select(index) {
    const count = this.systems.length;
    this.selected = ((index % count) + count) % count;
    this.render();
  }

  render() {
    this.entries.forEach((item, index) => {
      const active = index === this.selected;
      item.classList.toggle('grub__entry--selected', active);
      item.setAttribute('aria-selected', String(active));
    });
    this.message.textContent = '';
    this.renderDetails();
  }

  /**
   * A machine is described by its silicon; an entry that is not a machine says
   * so with its own labels rather than leaving three empty hardware rows.
   */
  renderDetails() {
    const system = this.systems[this.selected];
    const rows = system.details ?? [
      ['cpu', system.cpu],
      ['memoria', system.memory],
      ['note', system.notes],
    ];
    this.details.replaceChildren(...rows.map(([label, value]) => row(label, value)));
  }

  renderFooter() {
    this.footer.textContent = this.timer
      ? `La voce evidenziata verrà avviata automaticamente tra ${this.countdown} second${this.countdown === 1 ? 'o' : 'i'}.`
      : '';
  }

  onKeyDown(event) {
    switch (event.key) {
      case 'ArrowUp':
        this.stopCountdown();
        this.select(this.selected - 1);
        break;
      case 'ArrowDown':
        this.stopCountdown();
        this.select(this.selected + 1);
        break;
      case 'Home':
        this.stopCountdown();
        this.select(0);
        break;
      case 'End':
        this.stopCountdown();
        this.select(this.systems.length - 1);
        break;
      case 'Enter':
        this.stopCountdown();
        this.boot();
        break;
      default:
        // Any other key just cancels the automatic boot, like the real thing.
        this.stopCountdown();
        return;
    }
    event.preventDefault();
  }

  boot() {
    const system = this.systems[this.selected];
    if (!system.available || !system.load) {
      // GRUB's own way of saying "I cannot boot that".
      this.message.textContent = `Error 15: ${system.label.split(' — ')[0]} non è ancora emulato.`;
      return;
    }
    this.onBoot(system);
  }

  dispose() {
    this.stopCountdown();
    window.removeEventListener('keydown', this.keyHandler);
    this.root.remove();
  }
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** One "label  value" line of the detail block under the menu. */
function row(label, value) {
  const line = element('div', 'grub__detail');
  const name = element('span', 'grub__detail-label');
  name.textContent = label;
  const text = element('span', 'grub__detail-value');
  text.textContent = value ?? '—';
  line.append(name, text);
  return line;
}
