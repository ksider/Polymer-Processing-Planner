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

  const rasterizeSvgToPng = async (svg, requestedScale) => {
    const svgUrl = URL.createObjectURL(svg);
    try {
      const source = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('The chemical drawing could not be rendered as a high-resolution image.'));
        image.src = svgUrl;
      });
      const sourceWidth = Math.max(1, source.naturalWidth || 640);
      const sourceHeight = Math.max(1, source.naturalHeight || 360);
      // Keep a predictable memory limit while allowing enough pixels for a
      // crisp 80%-wide report image and a DOCX export.
      const maxPixels = 16 * 1024 * 1024;
      const safeScale = Math.max(1, Math.min(
        requestedScale,
        Math.sqrt(maxPixels / (sourceWidth * sourceHeight)),
        4096 / sourceWidth,
        4096 / sourceHeight
      ));
      const width = Math.max(1, Math.round(sourceWidth * safeScale));
      const height = Math.max(1, Math.round(sourceHeight * safeScale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not prepare a high-resolution chemical image.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
      const png = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The high-resolution chemical image could not be created.')), 'image/png');
      });
      return asDataUrl(png);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  };

  let dialog;
  let frame;
  let status;
  let insertButton;
  let exportScaleSelect;
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
      <div class="modal-header chemical-structure-header">
        <div class="chemical-structure-title">
          <span class="workspace-eyebrow">Chemical drawing</span>
          <strong id="chemicalStructureDialogTitle">Chemical structure</strong>
        </div>
        <button class="pure-button chemical-structure-icon-button" type="button" data-chemical-close aria-label="Close chemical structure editor" title="Close"><span class="material-symbols-rounded" aria-hidden="true">close</span></button>
      </div>
      <div class="modal-body chemical-structure-dialog-body">
        <p class="small-note" data-chemical-status>Starting chemical editor…</p>
        <div class="chemical-structure-frame-wrap" data-chemical-frame-wrap></div>
      </div>
      <div class="modal-footer chemical-structure-footer">
        <div class="chemical-structure-export-settings">
          <label class="chemical-structure-export-quality">PNG quality
            <select data-chemical-export-scale aria-label="Chemical structure PNG quality">
              <option value="1">Standard</option>
              <option value="2">High ×2</option>
              <option value="3" selected>Print ×3</option>
              <option value="4">Extra ×4</option>
            </select>
          </label>
          <span class="small-note">The report keeps the editable structure and a PNG copy for DOCX.</span>
        </div>
        <div class="chemical-structure-actions">
          <button class="pure-button" type="button" data-chemical-cancel>Cancel</button>
          <button class="pure-button pure-button-primary" type="button" data-chemical-insert disabled>Insert structure</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    status = dialog.querySelector('[data-chemical-status]');
    insertButton = dialog.querySelector('[data-chemical-insert]');
    exportScaleSelect = dialog.querySelector('[data-chemical-export-scale]');
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
      const exportScale = Number.parseInt(exportScaleSelect?.value || '3', 10);
      const qualityScale = [1, 2, 3, 4].includes(exportScale) ? exportScale : 3;
      const imageOptions = {
        backgroundColor: '255, 255, 255',
        bondThickness: 2
      };
      status.textContent = `Preparing ${qualityScale}× PNG for the report…`;
      let pngDataUrl;
      try {
        // Ketcher can give us a vector SVG. Rasterizing that locally at the
        // selected scale avoids stretching its small default PNG in the report
        // or DOCX export.
        const svg = await withTimeout(ketcher.generateImage(ket, {
          ...imageOptions,
          outputFormat: 'svg'
        }), 20000, 'Image export took too long. Please try a simpler structure or reopen the editor.');
        pngDataUrl = await rasterizeSvgToPng(svg, qualityScale);
      } catch (svgError) {
        // Keep insertion available in browsers/builds where SVG export is not
        // supported, even though its PNG will use Ketcher's default resolution.
        console.warn('High-resolution SVG export is unavailable; using the standard Ketcher PNG.', svgError);
        const image = await withTimeout(ketcher.generateImage(ket, {
          ...imageOptions,
          outputFormat: 'png'
        }), 20000, 'Image export took too long. Please try a simpler structure or reopen the editor.');
        pngDataUrl = await asDataUrl(image);
      }
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
