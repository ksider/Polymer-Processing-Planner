(() => {
  const KETCHER_URL = '/ketcher/index.html';

  const describeError = (error) => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Use the generic message below.
    }
    return 'Unable to export the chemical structure.';
  };

  const asDataUrl = (image) => {
    if (typeof image === 'string') {
      if (image.startsWith('data:image/')) return Promise.resolve(image);
      if (/^[A-Za-z0-9+/=\s]+$/.test(image)) return Promise.resolve(`data:image/png;base64,${image.replace(/\s/g, '')}`);
      return Promise.reject(new Error('Chemical editor returned an unsupported image format.'));
    }
    const blob = image instanceof Blob ? image : new Blob([image], { type: 'image/png' });
    return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to prepare the structure image.'));
    reader.readAsDataURL(blob);
    });
  };

  const optional = async (action) => {
    try {
      return await action();
    } catch {
      return null;
    }
  };

  const withTimeout = (operation, timeoutMs, message) => Promise.race([
    operation,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);

  const waitForKetcher = (frame) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const check = () => {
      const ketcher = frame.contentWindow?.ketcher;
      if (ketcher) return resolve(ketcher);
      if (Date.now() >= deadline) return reject(new Error('Chemical editor did not start. Please reload the page and try again.'));
      window.setTimeout(check, 80);
    };
    check();
  });

  let dialog;
  let frame;
  let status;
  let insertButton;
  let pending = null;

  const settle = (value) => {
    const resolver = pending;
    pending = null;
    if (dialog?.open) dialog.close();
    resolver?.(value);
  };

  const ensureDialog = () => {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'modal-frame chemical-structure-dialog';
    dialog.setAttribute('aria-labelledby', 'chemicalStructureDialogTitle');
    dialog.innerHTML = `
      <div class="modal-header">
        <div>
          <span class="workspace-eyebrow">Chemical drawing</span>
          <strong id="chemicalStructureDialogTitle">Chemical structure</strong>
        </div>
        <button class="pure-button" type="button" data-chemical-close>Close</button>
      </div>
      <div class="chemical-structure-dialog-body">
        <p class="small-note" data-chemical-status>Starting chemical editor…</p>
        <div class="chemical-structure-frame-wrap" data-chemical-frame-wrap></div>
      </div>
      <div class="modal-footer">
        <span class="small-note">The report keeps the editable structure and a PNG copy for DOCX.</span>
        <div class="chemical-structure-actions">
          <button class="pure-button" type="button" data-chemical-cancel>Cancel</button>
          <button class="pure-button pure-button-primary" type="button" data-chemical-insert disabled>Insert structure</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    status = dialog.querySelector('[data-chemical-status]');
    insertButton = dialog.querySelector('[data-chemical-insert]');
    dialog.querySelector('[data-chemical-close]')?.addEventListener('click', () => settle(null));
    dialog.querySelector('[data-chemical-cancel]')?.addEventListener('click', () => settle(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      settle(null);
    });
    dialog.addEventListener('close', () => {
      if (pending) settle(null);
    });
  };

  const freshFrame = () => {
    const wrapper = dialog.querySelector('[data-chemical-frame-wrap]');
    frame?.remove();
    frame = document.createElement('iframe');
    frame.className = 'chemical-structure-frame';
    frame.title = 'Chemical structure editor';
    frame.src = KETCHER_URL;
    wrapper.replaceChildren(frame);
    return frame;
  };

  const exportStructure = async () => {
    if (!frame || !insertButton || insertButton.disabled) return;
    insertButton.disabled = true;
    insertButton.textContent = 'Preparing…';
    status.textContent = 'Preparing editable structure and image…';
    try {
      const ketcher = await waitForKetcher(frame);
      const ket = await ketcher.getKet();
      const molfile = await optional(() => ketcher.getMolfile('v3000'));
      const smiles = await optional(() => ketcher.getSmiles());
      // Match Ketcher's own "Copy image" implementation: KET preserves both
      // molecules and reactions, and the standalone Indigo worker expects an
      // RGB background string rather than a CSS hex colour.
      const image = await withTimeout(ketcher.generateImage(ket, {
        outputFormat: 'png',
        backgroundColor: '255, 255, 255',
        bondThickness: 2
      }), 20000, 'Image export took too long. Please try a simpler structure or reopen the editor.');
      const pngDataUrl = await asDataUrl(image);
      settle({ ket, molfile, smiles, pngDataUrl });
    } catch (error) {
      console.error('Chemical structure export failed', error);
      status.textContent = describeError(error);
      insertButton.disabled = false;
      insertButton.textContent = 'Insert structure';
    }
  };

  window.ChemicalStructureEditor = {
    open({ initialStructure = '' } = {}) {
      ensureDialog();
      if (pending) settle(null);
      const currentFrame = freshFrame();
      status.textContent = 'Starting chemical editor…';
      insertButton.disabled = true;
      dialog.showModal();
      const ready = waitForKetcher(currentFrame).then(async (ketcher) => {
        if (initialStructure) await ketcher.setMolecule(initialStructure);
        status.textContent = 'Draw a structure or reaction, then insert it into the document.';
        insertButton.disabled = false;
        insertButton.textContent = 'Insert structure';
      }).catch((error) => {
        status.textContent = error instanceof Error ? error.message : 'Chemical editor did not start.';
      });
      void ready;
      return new Promise((resolve) => {
        pending = resolve;
        insertButton.onclick = () => { void exportStructure(); };
      });
    }
  };
})();
