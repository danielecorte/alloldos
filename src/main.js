// alloldos: pick a machine in the boot menu, run it, come back for another.
//
// Copyright (C) 2026 Daniele Corte. alloldos is free software: you can
// redistribute it and/or modify it under the terms of the GNU General Public
// License version 3, as published by the Free Software Foundation. It comes
// with no warranty whatsoever; see the LICENSE file for the full text.

import { BootLoader } from './boot/bootloader.js';
import { SYSTEMS, DEFAULT_SYSTEM } from './boot/systems.js';

const container = document.getElementById('app');
let loader = null;
let session = null;

function showBootMenu() {
  session?.dispose();
  session = null;
  container.replaceChildren();
  document.body.dataset.screen = 'boot';

  loader = new BootLoader(container, SYSTEMS, {
    defaultSystem: DEFAULT_SYSTEM,
    onBoot: (system) => bootSystem(system),
  });
}

async function bootSystem(system) {
  loader?.dispose();
  loader = null;
  container.replaceChildren();
  document.body.dataset.screen = system.id;

  try {
    const module = await system.load();
    session = await module.boot(container, { onExit: showBootMenu });
  } catch (error) {
    console.error(error);
    showFatal(system, error);
  }
}

function showFatal(system, error) {
  container.replaceChildren();
  document.body.dataset.screen = 'panic';

  const panic = document.createElement('pre');
  panic.className = 'panic';
  panic.textContent = [
    `alloldos: impossibile avviare ${system.label}`,
    '',
    String(error?.stack ?? error),
    '',
    'Premi un tasto per tornare al menu di boot.',
  ].join('\n');
  container.append(panic);

  window.addEventListener('keydown', showBootMenu, { once: true });
  panic.addEventListener('click', showBootMenu, { once: true });
}

showBootMenu();
